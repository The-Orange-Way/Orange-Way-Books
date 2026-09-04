#!/usr/bin/env node
// Compares every SECURITY DEFINER function LIVE in the public schema against
// the body declared in the migration file that most recently defines it, and
// fails BY NAME on a mismatch, an unsafe grant, or a function with no
// migration provenance at all.
//
// WHY: supabase_migrations.schema_migrations proves a migration FILENAME
// ran. It does not prove the live object still matches the file. A function
// whose body drifted away from its migration reads as fully applied and
// fully green under a filename-only check. This script closes that gap for
// SECURITY DEFINER functions specifically, because those are the ones that
// run with elevated privilege regardless of who calls them.
//
// This talks to the Supabase Management API with an access token, not a
// database password, so it needs only the SUPABASE_ACCESS_TOKEN secret this
// repo already has (reused from deploy-supabase-functions.yml). "Could not
// check" must never read as green: every failure path below exits non-zero
// with a message that names what could not be done, distinct from the pass
// message, so a broken credential is never silently reported as a clean run.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const PROJECT_REF = process.env.DRIFT_CHECK_PROJECT_REF;
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const MIGRATIONS_DIR = process.env.DRIFT_CHECK_MIGRATIONS_DIR || 'supabase/migrations';

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

if (!PROJECT_REF) {
  fail('DRIFT_CHECK_PROJECT_REF was not set. Refusing to report green: no target project.');
}
if (!ACCESS_TOKEN) {
  fail(
    'SUPABASE_ACCESS_TOKEN was not set. Refusing to report green: cannot read the live database.',
  );
}

const LIVE_QUERY = `
  select
    p.proname as name,
    p.prosrc as body,
    md5(p.prosrc) as body_md5,
    length(p.prosrc) as body_len,
    p.proacl::text as acl
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosecdef = true
  order by p.proname;
`;

async function queryLive() {
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: LIVE_QUERY }),
    });
  } catch (err) {
    fail(
      `Could not reach the Supabase Management API for project ${PROJECT_REF}: ${err.message}. Refusing to report green.`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    fail(
      `Supabase Management API returned ${res.status} for project ${PROJECT_REF}. Body: ${text.slice(0, 500)}. Refusing to report green.`,
    );
  }
  let rows;
  try {
    rows = JSON.parse(text);
  } catch (err) {
    fail(
      `Could not parse the Management API response as JSON: ${err.message}. Refusing to report green.`,
    );
  }
  if (!Array.isArray(rows)) {
    fail(
      `Management API response was not a row array. Refusing to report green. Body: ${text.slice(0, 500)}`,
    );
  }
  return rows;
}

function normalizeWs(sql) {
  // Line wrapping is not a defect; a changed comment or statement is.
  return sql.replace(/\s+/g, ' ').trim();
}

function md5(str) {
  return createHash('md5').update(str).digest('hex');
}

// Manual scanner, not a single regex: function argument lists and bodies can
// nest parens and dollar-quote tags, which a naive regex mishandles.
function extractFunctionDefinitions(sql) {
  const defs = [];
  const createRe =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/gi; // eslint-disable-line
  let m;
  while ((m = createRe.exec(sql)) !== null) {
    const name = m[1];
    let i = createRe.lastIndex; // just after the opening '('
    let depth = 1;
    while (i < sql.length && depth > 0) {
      if (sql[i] === '(') depth++;
      else if (sql[i] === ')') depth--;
      i++;
    }
    if (depth !== 0) continue; // unmatched parens, skip rather than guess
    const afterArgs = sql.slice(i);
    const dollarStart = afterArgs.match(/\$([A-Za-z_]*)\$/);
    if (!dollarStart) continue; // no dollar-quoted body found, skip
    const tag = `$${dollarStart[1]}$`;
    const bodyStartIdx = i + dollarStart.index + dollarStart[0].length;
    const bodyEndIdx = sql.indexOf(tag, bodyStartIdx);
    if (bodyEndIdx === -1) continue;
    const body = sql.slice(bodyStartIdx, bodyEndIdx);
    defs.push({ name, body, offset: m.index });
  }
  return defs;
}

function loadMigrationDefinitions() {
  let files;
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();
  } catch (err) {
    fail(
      `Could not read migrations directory ${MIGRATIONS_DIR}: ${err.message}. Refusing to report green.`,
    );
  }
  if (files.length === 0) {
    fail(
      `Found zero migration files under ${MIGRATIONS_DIR}. Refusing to report green: nothing to compare against.`,
    );
  }
  // Filename-order = chronological order, since every file starts with a
  // 14-digit timestamp prefix. Later files override earlier ones per name,
  // so the map ends up holding the LAST definition of each function.
  const byName = new Map();
  for (const file of files) {
    const content = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const def of extractFunctionDefinitions(content)) {
      byName.set(def.name, { ...def, file });
    }
  }
  return byName;
}

function unsafeGrantees(acl) {
  // proacl NULL means default privileges apply, and Postgres' default
  // privilege for a function is EXECUTE granted to PUBLIC -- that is unsafe
  // for a SECURITY DEFINER function and must fail exactly like an explicit
  // PUBLIC grant would.
  if (acl === null || acl === undefined) {
    return ['PUBLIC (no explicit ACL, default privileges apply)'];
  }
  const inner = acl.replace(/^\{/, '').replace(/\}$/, '');
  if (inner === '') return [];
  const items = inner.split(',');
  const bad = [];
  for (const item of items) {
    const grantee = item.split('=')[0];
    if (grantee === '') bad.push('PUBLIC');
    else if (grantee === 'anon') bad.push('anon');
  }
  return bad;
}

async function main() {
  const liveRows = await queryLive();
  const migrationDefs = loadMigrationDefinitions();

  let compared = 0;
  let failed = 0;
  const problems = [];

  for (const row of liveRows) {
    compared++;
    const def = migrationDefs.get(row.name);
    if (!def) {
      failed++;
      problems.push(
        `${row.name}: SECURITY DEFINER live, but no CREATE FUNCTION for it was found in any file under ${MIGRATIONS_DIR}. No provenance.`,
      );
      continue;
    }
    const liveNorm = normalizeWs(row.body);
    const fileNorm = normalizeWs(def.body);
    const liveMd5 = md5(liveNorm);
    const fileMd5 = md5(fileNorm);
    if (liveMd5 !== fileMd5) {
      failed++;
      problems.push(
        `${row.name}: LIVE body (md5 ${liveMd5}, ${liveNorm.length} chars normalized) does not match ${def.file} (md5 ${fileMd5}, ${fileNorm.length} chars normalized). The database and the migration file have diverged.`,
      );
    }
    const bad = unsafeGrantees(row.acl);
    if (bad.length > 0) {
      failed++;
      problems.push(
        `${row.name}: unsafe EXECUTE grant(s) live: ${bad.join(', ')}. acl=${row.acl}`,
      );
    }
  }

  console.log(`compared ${compared} of ${liveRows.length} SECURITY DEFINER functions`);
  for (const row of liveRows) {
    console.log(`  - ${row.name}`);
  }

  if (compared === 0) {
    fail(
      'Compared zero SECURITY DEFINER functions. That is either an empty database or a query that silently matched nothing; either way this run proves nothing and must not pass.',
    );
  }

  if (failed > 0) {
    console.error(`security-definer-drift-check: FAIL (${failed} problem(s))`);
    for (const p of problems) console.error(`::error::${p}`);
    process.exit(1);
  }

  console.log(
    'security-definer-drift-check: PASS (every live SECURITY DEFINER function matches its migration file, no unsafe grants)',
  );
}

main();
