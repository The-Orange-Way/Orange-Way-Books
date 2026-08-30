#!/usr/bin/env node
/**
 * Spec-execution guards for the Playwright E2E job. There are two, and they
 * answer different questions.
 *
 * 1. ZERO-SPEC GUARD (DL-0779). A Playwright run that finds no tests, or finds
 *    only tests that skip themselves, still exits 0. The E2E job then reports
 *    green having verified nothing. This fails unless at least one spec
 *    actually EXECUTED (expected + unexpected + flaky). Skipped specs do not
 *    count: a suite that only skips has proven nothing.
 *
 * 2. REQUIRED-SPEC GUARD (OWB-T0094). Guard 1 is suite-wide, so ONE spec
 *    answering "yes, I ran" covers for every other spec, and any individual
 *    spec can skip itself forever with CI fully green. That is not a theory:
 *    tests/e2e/rls-cross-user.spec.ts file-scope skipped on every CI run from
 *    the day it was written until 2026-08-30 and nothing anywhere went red. It
 *    skips whenever its Supabase creds are absent, so a secret rotation or a
 *    rename can silently retire our only cross-tenant isolation test. For a
 *    zero-knowledge product whose core claim is that one tenant cannot read
 *    another, that is the single test we least want to lose quietly.
 *
 *    So: the specs named in tests/e2e/required-specs.json must each be observed
 *    EXECUTING in this run, and a miss fails the job BY NAME with the likely
 *    cause. Naming it is the point. The whole reason this exists is that the
 *    next person should not have to download an artifact to find out what
 *    happened.
 *
 * Usage:
 *   bun tests/e2e/scripts/assert-specs-ran.mjs <path-to-results.json>
 *
 * The required list is data, not code: adding a spec is one line in
 * tests/e2e/required-specs.json, with no edit to this script and no edit to
 * the workflow. Set E2E_REQUIRED_SPECS_FILE to point somewhere else; the CI
 * self-proof does exactly that, so the proof does not depend on what the real
 * list happens to contain.
 *
 * A missing or unparseable report, and a missing, unparseable or EMPTY
 * required list, are all failures in themselves and are never silently scored
 * as OK. "The check could not run" must be loud, or it is worse than no check
 * at all, because it reads as a pass.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_EXECUTED = 1;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REQUIRED_LIST_PATH =
  process.env.E2E_REQUIRED_SPECS_FILE || path.join(HERE, '..', 'required-specs.json');

function fail(reason) {
  console.error(`::error::zero-spec guard failed: ${reason}`);
  process.exit(1);
}

function failRequired(lines) {
  for (const line of lines) {
    console.error(`::error::required-spec guard failed: ${line}`);
  }
  console.error(
    `::error::required-spec guard failed: ${lines.length} required spec(s) did not execute. ` +
      `The required list is ${REQUIRED_LIST_PATH}. A spec that skips itself is the failure ` +
      `this guard exists to catch, so do not "fix" it by removing the entry.`,
  );
  process.exit(1);
}

const reportPath = process.argv[2];
if (!reportPath) {
  fail('no report path given (usage: assert-specs-ran.mjs <results.json>)');
}

if (!fs.existsSync(reportPath)) {
  fail(`no Playwright JSON report at ${reportPath}; the run produced none`);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch (err) {
  fail(`report at ${reportPath} is not valid JSON: ${err.message}`);
}

const stats = report && report.stats;
if (!stats || typeof stats.expected !== 'number') {
  fail(`report at ${reportPath} has no stats block to count executed specs`);
}

const executed = (stats.expected || 0) + (stats.unexpected || 0) + (stats.flaky || 0);
const skipped = stats.skipped || 0;

if (executed < MIN_EXECUTED) {
  fail(`${executed} spec(s) executed, ${skipped} skipped; need at least ${MIN_EXECUTED}`);
}

console.log(`zero-spec guard: OK, ${executed} spec(s) executed, ${skipped} skipped`);

// ---------------------------------------------------------------------------
// Guard 2: the named specs that must have executed in THIS run.
// ---------------------------------------------------------------------------

if (!fs.existsSync(REQUIRED_LIST_PATH)) {
  failRequired([
    `no required-spec list at ${REQUIRED_LIST_PATH}. A guard that cannot read its own list ` +
      `verifies nothing, so this is a failure and not a skip.`,
  ]);
}

let requiredRaw;
try {
  requiredRaw = JSON.parse(fs.readFileSync(REQUIRED_LIST_PATH, 'utf8'));
} catch (err) {
  failRequired([`required-spec list at ${REQUIRED_LIST_PATH} is not valid JSON: ${err.message}`]);
}

// Accept either a bare array or an object with a `required` array, so the file
// can carry its own explanation without the script caring.
const required = Array.isArray(requiredRaw) ? requiredRaw : requiredRaw && requiredRaw.required;

if (!Array.isArray(required)) {
  failRequired([
    `required-spec list at ${REQUIRED_LIST_PATH} has no "required" array (or is not an array itself)`,
  ]);
}

if (required.length === 0) {
  failRequired([
    `required-spec list at ${REQUIRED_LIST_PATH} is EMPTY, so this guard would verify nothing ` +
      `while still reporting OK. That is the silent-success shape it exists to stop.`,
  ]);
}

/**
 * Walk the report's suite tree and record every spec with whether it actually
 * ran. Playwright marks a skipped test with result status "skipped"; anything
 * else (passed, failed, timedOut, interrupted) means the body executed.
 */
function collectSpecs(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node.specs)) {
    for (const spec of node.specs) {
      const file = spec.file || node.file || '';
      const ran = (spec.tests || []).some((t) =>
        (t.results || []).some((r) => r && r.status && r.status !== 'skipped'),
      );
      out.push({ file, title: spec.title || '', ran });
    }
  }
  if (Array.isArray(node.suites)) {
    for (const child of node.suites) collectSpecs(child, out);
  }
}

const observed = [];
collectSpecs(report, observed);

function normalize(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

/**
 * Match repo-relative list entries (tests/e2e/x.spec.ts) against the
 * testDir-relative paths Playwright reports (x.spec.ts), in either direction,
 * so the list stays readable and neither side has to know the other's root.
 */
function matches(specFile, entry) {
  const a = normalize(specFile);
  const b = normalize(entry);
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

const problems = [];
const satisfied = [];

for (const entry of required) {
  const hits = observed.filter((s) => matches(s.file, entry));
  if (hits.length === 0) {
    problems.push(
      `${entry} did not appear in this run AT ALL. It was renamed, deleted, or excluded by the ` +
        `test command. If it moved, update ${REQUIRED_LIST_PATH}.`,
    );
  } else if (!hits.some((s) => s.ran)) {
    problems.push(
      `${entry} was collected but every one of its ${hits.length} test(s) SKIPPED, so it proved ` +
        `nothing. The usual cause is a file-scope skip firing because its env credentials are ` +
        `missing or were renamed (for rls-cross-user.spec.ts: OWB_E2E_SUPABASE_URL and ` +
        `OWB_E2E_SUPABASE_SECRET_KEY in the dev environment scope).`,
    );
  } else {
    satisfied.push(entry);
  }
}

if (problems.length > 0) {
  failRequired(problems);
}

console.log(
  `required-spec guard: OK, ${satisfied.length} required spec(s) executed: ${satisfied.join(', ')}`,
);
