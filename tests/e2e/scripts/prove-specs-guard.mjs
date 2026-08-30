#!/usr/bin/env node
/**
 * Self-proof for tests/e2e/scripts/assert-specs-ran.mjs.
 *
 * A guard nobody has watched go red is not a guard. This drives the real
 * guard, against the real required-spec list, through every failure mode it
 * claims to catch, and through the passing case as a control:
 *
 *   A. zero specs executed suite-wide            -> guard must FAIL
 *   B. a required spec present, all tests skipped -> guard must FAIL, by name
 *   C. a required spec absent from the report     -> guard must FAIL, by name
 *   D. every required spec executed               -> guard must PASS
 *
 * D matters as much as A to C. Without it, a guard that failed for some
 * unrelated reason would still look "proven red" and would be failing every
 * run for the wrong reason.
 *
 * The required spec names are read from the list file, never written here, so
 * adding a required spec stays a one line data change.
 *
 * Usage: bun tests/e2e/scripts/prove-specs-guard.mjs [required-specs.json]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const GUARD = path.join('tests', 'e2e', 'scripts', 'assert-specs-ran.mjs');
const listPath = process.argv[2] || path.join('tests', 'e2e', 'required-specs.json');
const tmpDir = process.env.RUNNER_TEMP || os.tmpdir();

function die(reason) {
  console.error(`::error::spec-execution guard self-proof failed: ${reason}`);
  process.exit(1);
}

if (!fs.existsSync(listPath)) die(`no required-spec list at ${listPath}`);

let required;
try {
  required = JSON.parse(fs.readFileSync(listPath, 'utf8')).required || [];
} catch (err) {
  die(`required-spec list at ${listPath} is not valid JSON: ${err.message}`);
}
if (!Array.isArray(required) || required.length === 0) {
  die(`required-spec list at ${listPath} names no specs, so there is nothing to prove`);
}

const ran = { status: 'expected', results: [{ status: 'expected' }] };
const notRan = { status: 'skipped', results: [{ status: 'skipped' }] };

const suiteFor = (file, test) => ({ file, specs: [{ title: `synthetic ${file}`, tests: [test] }] });
const filler = suiteFor('tests/e2e/__self-proof-filler.spec.ts', ran);

function write(name, report) {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, JSON.stringify(report));
  return file;
}

function runGuard(reportFile) {
  return spawnSync(process.execPath, [GUARD, reportFile, listPath], { encoding: 'utf8' });
}

function expect(label, reportFile, shouldPass) {
  const out = runGuard(reportFile);
  const passed = out.status === 0;
  if (passed !== shouldPass) {
    console.error(out.stdout || '');
    console.error(out.stderr || '');
    die(
      `case ${label}: the guard ${passed ? 'PASSED' : 'FAILED'} but it must ` +
        `${shouldPass ? 'PASS' : 'FAIL'} here. Exit code ${out.status}.`,
    );
  }
  return out;
}

const stats = (executed, skipped) => ({ expected: executed, unexpected: 0, flaky: 0, skipped });

// A: nothing executed at all. The original suite-wide guard.
expect(
  'A (zero executed)',
  write('self-proof-a.json', { stats: stats(0, 3), suites: [] }),
  false,
);

// B: the suite carries a count, but a required spec skipped itself. This is the
// exact shape a rotated or renamed secret produces, and the shape that used to
// pass.
const target = required[0];
const caseB = expect(
  'B (required spec present but skipped)',
  write('self-proof-b.json', {
    stats: stats(1, 1),
    suites: [filler, suiteFor(target, notRan)],
  }),
  false,
);
if (!String(caseB.stderr || '').includes(target)) {
  die(`case B: the guard failed but did not name ${target} in its error output`);
}

// C: the required spec is not in the report at all: renamed, moved, deleted or
// filtered out.
const caseC = expect(
  'C (required spec absent)',
  write('self-proof-c.json', { stats: stats(1, 0), suites: [filler] }),
  false,
);
if (!String(caseC.stderr || '').includes(target)) {
  die(`case C: the guard failed but did not name ${target} in its error output`);
}

// D: the control. Everything required ran, so the guard must pass. Without this
// a guard that was red for an unrelated reason would still look proven.
expect(
  'D (all required specs executed)',
  write('self-proof-d.json', {
    stats: stats(required.length, 0),
    suites: required.map((file) => suiteFor(file, ran)),
  }),
  true,
);

console.log(
  `spec-execution guard self-proof: OK. Fails on a zero-executed run, on ${target} being ` +
    'present-but-skipped, and on it being absent; passes when every required spec ran.',
);
