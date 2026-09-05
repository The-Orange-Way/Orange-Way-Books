#!/usr/bin/env node
// Proves the drift-check comparison logic can actually FAIL, on every push
// and every PR, without a live database credential and without anyone
// firing a workflow_dispatch (no tool on this estate's agent surface can do
// that; the same structural gap exists in the twin repo's ticket for this
// check, and the same fix applies: a negative control that runs
// automatically instead of a dispatch-only proof). Every fixture below is
// planted; nothing here touches Supabase.
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

// Keeps every fixture below to a few short lines instead of one long
// array/object literal, so formatting stays unambiguous under the repo's
// printWidth and each check reads as "what differs from the clean case".
function defsFor(name, body, version, file) {
  return new Map([[name, migrationDef(name, body, version, file)]]);
}

function historyFor(name, body, version, file) {
  return new Map([[name, { action: 'create', version, file, body }]]);
}

const RPC_NAME = 'create_org_for_current_user';
const RPC_VERSION = '20260819000000';
const RPC_FILE = '20260819000000_create_org_rpc.sql';

// --- clean fixture: everything agrees, must report zero problems ---
check('clean fixture reports zero problems', () => {
  const live = [liveRow(RPC_NAME, GOOD_BODY, SAFE_ACL)];
  const defs = defsFor(RPC_NAME, GOOD_BODY, RPC_VERSION, RPC_FILE);
  const ledger = new Set([RPC_VERSION]);
  const history = historyFor(RPC_NAME, GOOD_BODY, RPC_VERSION, RPC_FILE);
  const result = compareAll(live, defs, ledger, history);
  assert.equal(result.compared, 1, `expected compared=1, got ${result.compared}`);
  const got = result.problems.join(' | ');
  assert.equal(result.failed, 0, `expected 0 problems, got ${result.failed}: ${got}`);
});

// --- planted body mismatch: must fail BY NAME ---
check('planted body mismatch fails by name (acceptance item 1)', () => {
  const live = [liveRow(RPC_NAME, BAD_BODY, SAFE_ACL)];
  const defs = defsFor(RPC_NAME, GOOD_BODY, RPC_VERSION, RPC_FILE);
  const ledger = new Set([RPC_VERSION]);
  const history = historyFor(RPC_NAME, GOOD_BODY, RPC_VERSION, RPC_FILE);
  const result = compareAll(live, defs, ledger, history);
  assert.ok(result.failed > 0, 'expected a failure, got none');
  const named = result.problems.some((p) => p.includes(RPC_NAME) && p.includes('does not match'));
  const got = result.problems.join(' | ');
  assert.ok(named, `expected a body-mismatch problem naming the function, got: ${got}`);
});

// --- restored body after the plant above: must go back to green ---
check('restoring the body after a plant returns to green', () => {
  const live = [liveRow(RPC_NAME, GOOD_BODY, SAFE_ACL)];
  const defs = defsFor(RPC_NAME, GOOD_BODY, RPC_VERSION, RPC_FILE);
  const ledger = new Set([RPC_VERSION]);
  const history = historyFor(RPC_NAME, GOOD_BODY, RPC_VERSION, RPC_FILE);
  const result = compareAll(live, defs, ledger, history);
  const got = result.problems.join(' | ');
  assert.equal(result.failed, 0, `expected recovery to green, got: ${got}`);
});

// --- unsafe grant fixtures ---
check('explicit PUBLIC grant fails by name', () => {
  const live = [liveRow('foo', GOOD_BODY, PUBLIC_ACL)];
  const defs = defsFor('foo', GOOD_BODY, '20260101000000', 'x.sql');
  const ledger = new Set(['20260101000000']);
  const history = historyFor('foo', GOOD_BODY, '20260101000000', 'x.sql');
  const result = compareAll(live, defs, ledger, history);
  const found = result.problems.some(
    (p) => p.includes('foo') && p.includes('unsafe EXECUTE grant'),
  );
  assert.ok(found, `got: ${result.problems.join(' | ')}`);
});

check('NULL acl (default PUBLIC EXECUTE) fails by name', () => {
  const live = [liveRow('foo', GOOD_BODY, null)];
  const defs = defsFor('foo', GOOD_BODY, '20260101000000', 'x.sql');
  const ledger = new Set(['20260101000000']);
  const history = historyFor('foo', GOOD_BODY, '20260101000000', 'x.sql');
  const result = compareAll(live, defs, ledger, history);
  const found = result.problems.some((p) => p.includes('foo') && p.includes('PUBLIC'));
  assert.ok(found, `got: ${result.problems.join(' | ')}`);
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
  const found = result.problems.some(
    (p) => p.includes('mystery_fn') && p.includes('No provenance'),
  );
  assert.ok(found, `got: ${result.problems.join(' | ')}`);
});

// --- ledger direction (a): ledgered create, object missing, not retired ---
check('ledger direction a: applied migration, missing object, not retired -> fails', () => {
  const version = '20260101000000';
  const file = '20260101000000_ghost.sql';
  const live = []; // the function does not exist live
  const defs = new Map(); // nothing to compare since it is not live
  const ledger = new Set([version]);
  const entry = { action: 'create', version, file, body: GOOD_BODY };
  const history = new Map([['ghost_fn', entry]]);
  const result = compareAll(live, defs, ledger, history);
  const found = result.problems.some(
    (p) => p.includes('ghost_fn') && p.includes('does not exist live'),
  );
  assert.ok(found, `got: ${result.problems.join(' | ')}`);
});

// --- ledger direction (a), negative: legitimately retired function must NOT fail ---
check('ledger direction a: a later ledgered DROP for the same name is not flagged', () => {
  const live = [];
  const defs = new Map();
  const ledger = new Set(['20260101000000', '20260201000000']);
  // loadMigrationHistory keeps only the LAST action per name; a later DROP
  // overwrites the earlier CREATE entry, so this fixture models that by
  // handing compareAll a history whose last action for the name is 'drop'.
  const dropEntry = { action: 'drop', version: '20260201000000', file: '20260201000000_drop.sql' };
  const history = new Map([['retired_fn', dropEntry]]);
  const result = compareAll(live, defs, ledger, history);
  const got = result.problems.join(' | ');
  assert.equal(
    result.failed,
    0,
    `a legitimately dropped function must not be flagged, got: ${got}`,
  );
});

// --- ledger direction (b): live and file-faithful, but ledger has no row ---
check('ledger direction b: live object with no ledger row for its migration -> fails', () => {
  const name = 'unrecorded_fn';
  const version = '20260301000000';
  const file = '20260301000000_unrecorded.sql';
  const live = [liveRow(name, GOOD_BODY, SAFE_ACL)];
  const defs = defsFor(name, GOOD_BODY, version, file);
  const ledger = new Set(); // no row for this version at all
  const history = historyFor(name, GOOD_BODY, version, file);
  const result = compareAll(live, defs, ledger, history);
  const found = result.problems.some((p) => p.includes(name) && p.includes('NO row for'));
  assert.ok(found, `got: ${result.problems.join(' | ')}`);
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
