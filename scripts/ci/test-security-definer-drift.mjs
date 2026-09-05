#!/usr/bin/env node
// Proves the drift-check comparison logic can actually FAIL, on every push
// and every PR, without a live database credential and without anyone
// firing a workflow_dispatch (no tool on this estate's agent surface can do
// that; see OWB-T0181 / OWM-T0698 for the same structural gap and the same
// fix: a negative control that runs automatically instead of a dispatch-only
// proof). Every fixture below is planted; nothing here touches Supabase.
//
// This is acceptance item 1's proof for OWB-T0164: "a deliberately altered
// SECURITY DEFINER function body makes the check FAIL by name... plus a
// green run once the body is restored." The fixtures ARE the deliberate
// alteration and the restoration, exercised directly against the same
// compareAll() the live workflow calls.

import assert from 'node:assert/strict';
import {
  compareAll,
  extractFunctionDefinitions,
  extractDropFunctionNames,
  unsafeGrantees,
} from './check-security-definer-drift.mjs';

let failures = 0;

function check(label, fn) {
  try {
    fn();
    console.log(`ok - ${label}`);
  } catch (err) {
    failures++;
    console.error(`::error::FAILED - ${label}: ${err.message}`);
  }
}

const GOOD_BODY = ' insert into organizations (name) values ($1); ';
const BAD_BODY = ' insert into organizations (name, extra) values ($1, $2); ';
const SAFE_ACL = '{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}';
const PUBLIC_ACL = '{=X/postgres,authenticated=X/postgres}';

function liveRow(name, body, acl) {
  return { name, body, acl };
}

function migrationDef(name, body, version, file) {
  return { name, body, version, file, action: 'create' };
}

// --- clean fixture: everything agrees, must report zero problems ---
check('clean fixture reports zero problems', () => {
  const live = [liveRow('create_org_for_current_user', GOOD_BODY, SAFE_ACL)];
  const defs = new Map([
    ['create_org_for_current_user', migrationDef('create_org_for_current_user', GOOD_BODY, '20260819000000', '20260819000000_create_org_rpc.sql')],
  ]);
  const ledger = new Set(['20260819000000']);
  const history = new Map([
    ['create_org_for_current_user', { action: 'create', version: '20260819000000', file: '20260819000000_create_org_rpc.sql', body: GOOD_BODY }],
  ]);
  const result = compareAll(live, defs, ledger, history);
  assert.equal(result.compared, 1, `expected compared=1, got ${result.compared}`);
  assert.equal(result.failed, 0, `expected 0 problems, got ${result.failed}: ${result.problems.join(' | ')}`);
});

// --- planted body mismatch: must fail BY NAME ---
check('planted body mismatch fails by name (acceptance item 1)', () => {
  const live = [liveRow('create_org_for_current_user', BAD_BODY, SAFE_ACL)];
  const defs = new Map([
    ['create_org_for_current_user', migrationDef('create_org_for_current_user', GOOD_BODY, '20260819000000', '20260819000000_create_org_rpc.sql')],
  ]);
  const ledger = new Set(['20260819000000']);
  const history = new Map([
    ['create_org_for_current_user', { action: 'create', version: '20260819000000', file: '20260819000000_create_org_rpc.sql', body: GOOD_BODY }],
  ]);
  const result = compareAll(live, defs, ledger, history);
  assert.ok(result.failed > 0, 'expected a failure, got none');
  assert.ok(
    result.problems.some((p) => p.includes('create_org_for_current_user') && p.includes('does not match')),
    `expected a body-mismatch problem naming the function, got: ${result.problems.join(' | ')}`,
  );
});

// --- restored body after the plant above: must go back to green ---
check('restoring the body after a plant returns to green', () => {
  const live = [liveRow('create_org_for_current_user', GOOD_BODY, SAFE_ACL)];
  const defs = new Map([
    ['create_org_for_current_user', migrationDef('create_org_for_current_user', GOOD_BODY, '20260819000000', '20260819000000_create_org_rpc.sql')],
  ]);
  const ledger = new Set(['20260819000000']);
  const history = new Map([
    ['create_org_for_current_user', { action: 'create', version: '20260819000000', file: '20260819000000_create_org_rpc.sql', body: GOOD_BODY }],
  ]);
  const result = compareAll(live, defs, ledger, history);
  assert.equal(result.failed, 0, `expected recovery to green, got: ${result.problems.join(' | ')}`);
});

// --- unsafe grant fixtures ---
check('explicit PUBLIC grant fails by name', () => {
  const live = [liveRow('foo', GOOD_BODY, PUBLIC_ACL)];
  const defs = new Map([['foo', migrationDef('foo', GOOD_BODY, '20260101000000', 'x.sql')]]);
  const ledger = new Set(['20260101000000']);
  const history = new Map([['foo', { action: 'create', version: '20260101000000', file: 'x.sql', body: GOOD_BODY }]]);
  const result = compareAll(live, defs, ledger, history);
  assert.ok(result.problems.some((p) => p.includes('foo') && p.includes('unsafe EXECUTE grant')), `got: ${result.problems.join(' | ')}`);
});

check('NULL acl (default PUBLIC EXECUTE) fails by name', () => {
  const live = [liveRow('foo', GOOD_BODY, null)];
  const defs = new Map([['foo', migrationDef('foo', GOOD_BODY, '20260101000000', 'x.sql')]]);
  const ledger = new Set(['20260101000000']);
  const history = new Map([['foo', { action: 'create', version: '20260101000000', file: 'x.sql', body: GOOD_BODY }]]);
  const result = compareAll(live, defs, ledger, history);
  assert.ok(result.problems.some((p) => p.includes('foo') && p.includes('PUBLIC')), `got: ${result.problems.join(' | ')}`);
});

check('unsafeGrantees direct unit checks', () => {
  assert.deepEqual(unsafeGrantees(SAFE_ACL), []);
  assert.deepEqual(unsafeGrantees(PUBLIC_ACL), ['PUBLIC']);
  assert.deepEqual(unsafeGrantees('{anon=X/postgres}'), ['anon']);
});

// --- missing provenance: live function with no CREATE anywhere ---
check('live function with no migration provenance fails by name', () => {
  const live = [liveRow('mystery_fn', GOOD_BODY, SAFE_ACL)];
  const defs = new Map();
  const ledger = new Set();
  const history = new Map();
  const result = compareAll(live, defs, ledger, history);
  assert.ok(result.problems.some((p) => p.includes('mystery_fn') && p.includes('No provenance')), `got: ${result.problems.join(' | ')}`);
});

// --- ledger direction (a): ledgered create, object missing, not retired ---
check('ledger direction a: applied migration, missing object, not retired -> fails', () => {
  const live = []; // the function does not exist live
  const defs = new Map(); // nothing to compare since it is not live
  const ledger = new Set(['20260101000000']);
  const history = new Map([
    ['ghost_fn', { action: 'create', version: '20260101000000', file: '20260101000000_ghost.sql', body: GOOD_BODY }],
  ]);
  const result = compareAll(live, defs, ledger, history);
  assert.ok(
    result.problems.some((p) => p.includes('ghost_fn') && p.includes('does not exist live')),
    `got: ${result.problems.join(' | ')}`,
  );
});

// --- ledger direction (a), negative: legitimately retired function must NOT fail ---
check('ledger direction a: a later ledgered DROP for the same name is not flagged', () => {
  const live = [];
  const defs = new Map();
  const ledger = new Set(['20260101000000', '20260201000000']);
  // loadMigrationHistory keeps only the LAST action per name; a later DROP
  // overwrites the earlier CREATE entry, so this fixture models that by
  // handing compareAll a history whose last action for the name is 'drop'.
  const history = new Map([
    ['retired_fn', { action: 'drop', version: '20260201000000', file: '20260201000000_drop_retired_fn.sql' }],
  ]);
  const result = compareAll(live, defs, ledger, history);
  assert.equal(result.failed, 0, `a legitimately dropped function must not be flagged, got: ${result.problems.join(' | ')}`);
});

// --- ledger direction (b): live and file-faithful, but ledger has no row ---
check('ledger direction b: live object with no ledger row for its migration -> fails', () => {
  const live = [liveRow('unrecorded_fn', GOOD_BODY, SAFE_ACL)];
  const defs = new Map([
    ['unrecorded_fn', migrationDef('unrecorded_fn', GOOD_BODY, '20260301000000', '20260301000000_unrecorded.sql')],
  ]);
  const ledger = new Set(); // no row for 20260301000000 at all
  const history = new Map([
    ['unrecorded_fn', { action: 'create', version: '20260301000000', file: '20260301000000_unrecorded.sql', body: GOOD_BODY }],
  ]);
  const result = compareAll(live, defs, ledger, history);
  assert.ok(
    result.problems.some((p) => p.includes('unrecorded_fn') && p.includes('NO row for')),
    `got: ${result.problems.join(' | ')}`,
  );
});

// --- zero-compared guard: main() must have something real to refuse on ---
check('empty live list reports compared=0', () => {
  const result = compareAll([], new Map(), new Set(), new Map());
  assert.equal(result.compared, 0);
});

// --- extractFunctionDefinitions / extractDropFunctionNames sanity ---
check('extractFunctionDefinitions finds a dollar-quoted body', () => {
  const sql = `CREATE FUNCTION public.foo(a int) RETURNS void AS $$ select 1; $$ LANGUAGE sql;`;
  const defs = extractFunctionDefinitions(sql);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'foo');
  assert.ok(defs[0].body.includes('select 1'));
});

check('extractDropFunctionNames finds a DROP FUNCTION IF EXISTS', () => {
  const sql = `DROP FUNCTION IF EXISTS public.foo(int, text);`;
  const names = extractDropFunctionNames(sql);
  assert.deepEqual(names, ['foo']);
});

if (failures > 0) {
  console.error(`test-security-definer-drift: FAIL (${failures} assertion(s) failed)`);
  process.exit(1);
}
console.log('test-security-definer-drift: PASS (all fixtures behaved as expected)');
