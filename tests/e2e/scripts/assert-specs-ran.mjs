#!/usr/bin/env node
/**
 * Spec execution guard.
 *
 * TWO checks, and the second is the reason this file was rewritten.
 *
 * 1. DL-0779 zero-spec guard. A Playwright run that finds no tests, or finds
 *    only tests that skip themselves, still exits 0. The E2E job then reports
 *    green having verified nothing. This fails unless at least one spec
 *    actually EXECUTED (expected + unexpected + flaky).
 *
 * 2. OWB-T0094 required-spec guard. Check 1 is suite-wide, so it answers "did
 *    the loop finish", not "did the work happen": any INDIVIDUAL spec can skip
 *    itself forever and CI stays green. rls-cross-user.spec.ts did exactly
 *    that on every run from the day it was written until 2026-08-30. So every
 *    spec named in tests/e2e/required-specs.json must appear in the report AND
 *    have at least one test that did not skip, or this fails and names it.
 *
 * Usage: bun tests/e2e/scripts/assert-specs-ran.mjs <results.json> [required-specs.json]
 *
 * The required list defaults to tests/e2e/required-specs.json and can be
 * overridden by the second argument or by E2E_REQUIRED_SPECS_FILE. The
 * override exists so the workflow can prove this guard goes RED in the same
 * run, against a synthetic report, without touching the real list.
 *
 * A missing or unparseable report, and a missing or malformed required list,
 * are themselves failures, never silently scored as OK. "The check could not
 * run" must be loud.
 */

import fs from 'node:fs';

const MIN_EXECUTED = 1;
const DEFAULT_REQUIRED_LIST = 'tests/e2e/required-specs.json';

function fail(reason) {
  console.error(`::error::spec-execution guard failed: ${reason}`);
  process.exit(1);
}

function readJson(filePath, what) {
  if (!fs.existsSync(filePath)) {
    fail(`no ${what} at ${filePath}`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    fail(`${what} at ${filePath} is not valid JSON: ${err.message}`);
  }
  return null;
}

// Report paths are posix-ish already, but a Windows-run report and a leading
// './' should not be the reason a required spec reads as missing.
function normalize(p) {
  const forwardSlashes = String(p).replace(/\\/g, '/');
  return forwardSlashes.replace(/^\.\//, '');
}

function sameSpecFile(reportFile, requiredFile) {
  const a = normalize(reportFile);
  const b = normalize(requiredFile);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

// Walk the suite tree and record, per spec FILE, how many of its specs had at
// least one test that did not skip. Playwright nests suites arbitrarily deep
// and only some nodes carry `file`, so an inherited value is passed down.
function collectByFile(node, out, inheritedFile) {
  if (!node || typeof node !== 'object') return;
  const file = node.file || inheritedFile;

  for (const spec of node.specs || []) {
    const specFile = spec.file || file;
    if (!specFile) continue;
    const key = normalize(specFile);
    const ran = (spec.tests || []).some((t) => t && t.status && t.status !== 'skipped');
    const seen = out.get(key) || { executed: 0, total: 0 };
    seen.total += 1;
    if (ran) seen.executed += 1;
    out.set(key, seen);
  }

  for (const child of node.suites || []) {
    collectByFile(child, out, file);
  }
}

const reportPath = process.argv[2];
if (!reportPath) {
  fail('no report path given (usage: assert-specs-ran.mjs <results.json> [required-specs.json])');
}

const requiredListPath =
  process.argv[3] || process.env.E2E_REQUIRED_SPECS_FILE || DEFAULT_REQUIRED_LIST;

const report = readJson(reportPath, 'Playwright JSON report');

const stats = report && report.stats;
if (!stats || typeof stats.expected !== 'number') {
  fail(`report at ${reportPath} has no stats block to count executed specs`);
}

const executed = (stats.expected || 0) + (stats.unexpected || 0) + (stats.flaky || 0);
const skipped = stats.skipped || 0;

if (executed < MIN_EXECUTED) {
  fail(`${executed} spec(s) executed, ${skipped} skipped; need at least ${MIN_EXECUTED}`);
}

const requiredDoc = readJson(requiredListPath, 'required-spec list');
const required = Array.isArray(requiredDoc) ? requiredDoc : requiredDoc && requiredDoc.required;
if (!Array.isArray(required)) {
  fail(`required-spec list at ${requiredListPath} has no "required" array`);
}

const byFile = new Map();
collectByFile(report, byFile, '');

const problems = [];
for (const requiredFile of required) {
  const hits = [...byFile.entries()].filter(([f]) => sameSpecFile(f, requiredFile));
  if (hits.length === 0) {
    problems.push(
      `${requiredFile} did not appear in the run AT ALL. Likely cause: it was renamed or moved, ` +
        `or the Playwright testDir/grep no longer matches it. Fix the path in ${requiredListPath} ` +
        `or restore the spec.`,
    );
    continue;
  }
  const ranCount = hits.reduce((n, [, v]) => n + v.executed, 0);
  if (ranCount === 0) {
    const total = hits.reduce((n, [, v]) => n + v.total, 0);
    problems.push(
      `${requiredFile} was collected but ALL ${total} of its spec(s) SKIPPED. Likely cause: its ` +
        `environment credentials are missing or renamed in the dev environment scope, so the ` +
        `file-scope skip fired. This spec is on the required list because losing it quietly is ` +
        `not acceptable.`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`::error::required spec did not execute: ${problem}`);
  }
  fail(`${problems.length} required spec(s) did not execute; see the error(s) above`);
}

console.log(
  `spec-execution guard: OK, ${executed} spec(s) executed, ${skipped} skipped; ` +
    `all ${required.length} required spec(s) executed`,
);
