#!/usr/bin/env node
// Compares every SECURITY DEFINER function LIVE in the public schema against
// the body declared in the migration file that most recently defines it, and
// fails BY NAME on a mismatch, an unsafe grant, or a function with no
// migration provenance at all. Also reconciles the migration LEDGER
// (supabase_migrations.schema_migrations) against those same objects, in
// both directions.
//
// WHY: supabase_migrations.schema_migrations proves a migration FILENAME
// ran. It does not prove the live object still matches the file, and it
// does not prove the object's existence and the ledger agree at all. Three
// failure shapes, all measured live on this estate (OWB-T0164, widened by
// the DBA on 2026-09-04 after the Auditor's OWM DEV measurement):
//   (1) file says X, live object says Y                  (body/grant drift)
//   (2) ledger says a migration ran, the object is absent (silent loss)
//   (3) the object exists live, the ledger has no row for it (silent gap)
// A check that only does (1) reads (2) and (3) as green. This script does
// all three.
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

const LEDGER_QUERY = `select version from supabase_migrations.schema_migrations order by version;`;

async function runManagementQuery(query, describeFor) {
  const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
  } catch (err) {
    fail(
      `Could not reach the Supabase Management API for ${describeFor} on project ${PROJECT_REF}: ${err.message}. Refusing to report green.`,
    );
  }
  const text = await res.text();
  if (!res.ok) {
    fail(
      `Supabase Management API returned ${res.status} fetching ${describeFor} for project ${PROJECT_REF}. Body: ${text.slice(0, 500)}. Refusing to report green.`,
    );
  }
  let rows;
  try {
    rows = JSON.parse(text);
  } catch (err) {
    fail(
      `Could not parse the Management API response for ${describeFor} as JSON: ${err.message}. Refusing to report green.`,
    );
  }
  if (!Array.isArray(rows)) {
    fail(
      `Management API response for ${describeFor} was not a row array. Refusing to report green. Body: ${text.slice(0, 500)}`,
    );
  }
  return rows;
}

async function queryLive() {
  if (!PROJECT_REF) {
    fail('DRIFT_CHECK_PROJECT_REF was not set. Refusing to report green: no target project.');
  }
  if (!ACCESS_TOKEN) {
    fail(
      'SUPABASE_ACCESS_TOKEN was not set. Refusing to report green: cannot read the live database.',
    );
  }
  return runManagementQuery(LIVE_QUERY, 'live SECURITY DEFINER functions');
}

async function queryLedger() {
  const rows = await runManagementQuery(LEDGER_QUERY, 'the migration ledger');
  return new Set(rows.map((r) => String(r.version)));
}

export function normalizeWs(sql) {
  // Line wrapping is not a defect; a changed comment or statement is.
  return sql.replace(/\s+/g, ' ').trim();
}

export function md5(str) {
  return createHash('md5').update(str).digest('hex');
}

// Manual scanner, not a single regex: function argument lists and bodies can
// nest parens and dollar-quote tags, which a naive regex mishandles.
export function extractFunctionDefinitions(sql) {
  const defs = [];
  const createRe =
    /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\(/gi;
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

// DROP FUNCTION IF EXISTS public.foo(...) -- name only, argument list is not
// needed for this check since we reconcile by name.
export function extractDropFunctionNames(sql) {
  const dropRe = /DROP\s+FUNCTION\s+(?:IF\s+EXISTS\s+)?(?:public\.)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;
  const names = [];
  let m;
  while ((m = dropRe.exec(sql)) !== null) names.push(m[1]);
  return names;
}

function versionOf(filename) {
  const m = filename.match(/^(\d{14})_/);
  return m ? m[1] : null;
}

// Walks every migration file in chronological (filename) order and, per
// function name, keeps the LAST action (create or drop) and every ledger
// version at which a create happened. That is enough to answer both ledger
// reconciliation directions without re-reading files per name.
export function loadMigrationHistory(files, readFile) {
  const lastAction = new Map(); // name -> { action: 'create'|'drop', version, file, body }
  for (const file of files) {
    const version = versionOf(file);
    const content = readFile(file);
    for (const def of extractFunctionDefinitions(content)) {
      lastAction.set(def.name, { action: 'create', version, file, body: def.body });
    }
    for (const name of extractDropFunctionNames(content)) {
      lastAction.set(name, { action: 'drop', version, file });
    }
  }
  return lastAction;
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
  const history = loadMigrationHistory(files, (f) => readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  // Filename-order = chronological order, since every file starts with a
  // 14-digit timestamp prefix. history already holds the LAST create per
  // name (a later file overwrites an earlier map entry).
  const byName = new Map();
  for (const [name, entry] of history) {
    if (entry.action === 'create') byName.set(name, entry);
  }
  return { byName, history };
}

export function unsafeGrantees(acl) {
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

// The whole comparison, as a pure function of its inputs, so it can be
// exercised with fixtures (see test-security-definer-drift.mjs) and not
// only against a live database. This is what makes acceptance item 1
// provable on every push and PR instead of only through a manual
// workflow_dispatch nobody here holds a tool to fire.
export function compareAll(liveRows, migrationDefs, ledgerVersions, migrationHistory) {
  let compared = 0;
  let failed = 0;
  const problems = [];
  const liveNames = new Set(liveRows.map((r) => r.name));

  for (const row of liveRows) {
    compared++;
    const def = migrationDefs.get(row.name);
    if (!def) {
      failed++;
      problems.push(
        `${row.name}: SECURITY DEFINER live, but no CREATE FUNCTION for it was found in any migration file. No provenance.`,
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
      problems.push(`${row.name}: unsafe EXECUTE grant(s) live: ${bad.join(', ')}. acl=${row.acl}`);
    }
    // Ledger direction (b): the object is present and correct, but the
    // migration that creates it never made it into the ledger.
    if (!ledgerVersions.has(def.version)) {
      failed++;
      problems.push(
        `${row.name}: live and file-faithful, but supabase_migrations.schema_migrations has NO row for ${def.version} (${def.file}), the migration that creates it. The ledger and the objects have diverged.`,
      );
    }
  }

  // Ledger direction (a): a migration the ledger claims ran created a
  // function that does not exist live, and nothing later legitimately
  // dropped it.
  for (const [name, entry] of migrationHistory) {
    if (entry.action !== 'create') continue;
    if (!ledgerVersions.has(entry.version)) continue; // not applied per ledger, nothing to reconcile here
    if (liveNames.has(name)) continue; // present live, already compared above
    problems.push(
      `${name}: supabase_migrations.schema_migrations records ${entry.version} (${entry.file}) as applied, and that migration creates ${name}, but the function does not exist live and no later migration drops it. The ledger and the objects have diverged.`,
    );
    failed++;
  }

  return { compared, failed, problems };
}

async function main() {
  const liveRows = await queryLive();
  const { byName: migrationDefs, history: migrationHistory } = loadMigrationDefinitions();
  const ledgerVersions = await queryLedger();

  const { compared, failed, problems } = compareAll(
    liveRows,
    migrationDefs,
    ledgerVersions,
    migrationHistory,
  );

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
    'security-definer-drift-check: PASS (every live SECURITY DEFINER function matches its migration file and its ledger row, no unsafe grants)',
  );
}

// Only run against a live database when invoked directly. The test file
// imports the functions above and never calls main().
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
