#!/usr/bin/env node
/**
 * DL-0779 zero-spec guard, plus the per-spec required-execution guard.
 *
 * TWO CHECKS, and they answer different questions.
 *
 * 1. ZERO-SPEC. A Playwright run that finds no tests, or finds only tests that
 *    skip themselves, still exits 0. The E2E job then reports green having
 *    verified nothing. This fails unless at least one spec actually EXECUTED
 *    (expected + unexpected + flaky). Skipped specs do not count: a suite that
 *    only skips has proven nothing.
 *
 * 2. REQUIRED SPECS. Check 1 is suite-wide, so it cannot see an INDIVIDUAL
 *    spec quietly going back to skipping while the rest of the suite carries
 *    the count. That is not hypothetical: rls-cross-user.spec.ts file-scope
 *    skipped on every CI run from the day it was written until 2026-08-30 and
 *    nothing anywhere went red. A secret rotation can silently retire our only
 *    cross-tenant isolation spec. So a named list of specs that MUST have
 *    executed is read from a JSON file and each one is checked by name.
 *
 * Usage: bun tests/e2e/scripts/assert-specs-ran.mjs <results.json> [required-specs.json]
 *
 * The required list defaults to tests/e2e/required-specs.json. If that default
 * is absent, check 2 is skipped and check 1 still runs, so this script drops
 * into a repo that has no list yet. If a path is passed EXPLICITLY and is
 * missing or unreadable, that is a failure: an explicit argument is a claim
 * that the list exists.
 *
 * A missing or unparseable report is itself a failure, not a pass. "The check
 * could not run" must be loud, never silently scored as OK.
 */

import fs from 'node:fs';
import path from 'node:path';

const MIN_EXECUTED = 1;
const DEFAULT_REQUIRED_LIST = path.join('tests', 'e2e', 'required-specs.json');

function fail(reason) {
  console.error(`::error::spec-execution guard failed: ${reason}`);
  process.exit(1);
}

/** Normalize a path for suffix comparison: posix separators, no leading "./". */
function normalizePath(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Match a required entry against a path from the report. The report records
 * files relative to Playwright's rootDir, which is the testDir here and not
 * the repo root, so "tests/e2e/x.spec.ts" and "x.spec.ts" are the same file
 * seen from two places. Suffix match in both directions covers both without
 * needing to know which one Playwright chose.
 */
function samePath(a, b) {
  const left = normalizePath(a);
  const right = normalizePath(b);
  return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

/** A test counts as executed when any of its statuses is something other than skipped. */
function testExecuted(test) {
  if (test && typeof test.status === 'string' && test.status !== 'skipped') return true;
  const results = (test && test.results) || [];
  return results.some((r) => r && typeof r.status === 'string' && r.status !== 'skipped');
}

/**
 * Walk the report's suite tree and record, per file, whether ANY spec in it
 * executed. Suites nest (describe blocks), and only the outermost carries the
 * file, so the file is inherited on the way down.
 */
function collectFiles(suites, inheritedFile, seen) {
  for (const suite of suites || []) {
    const file = suite.file || inheritedFile;
    for (const spec of suite.specs || []) {
      const specFile = spec.file || file;
      if (!specFile) continue;
      const executed = (spec.tests || []).some(testExecuted);
      seen.set(specFile, (seen.get(specFile) || false) || executed);
    }
    collectFiles(suite.suites, file, seen);
  }
  return seen;
}

function readJson(file, what) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`cannot read ${what} at ${file}: ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    fail(`${what} at ${file} is not valid JSON: ${err.message}`);
  }
  return null;
}

const reportPath = process.argv[2];
if (!reportPath) {
  fail('no report path given (usage: assert-specs-ran.mjs <results.json> [required-specs.json])');
}

if (!fs.existsSync(reportPath)) {
  fail(`no Playwright JSON report at ${reportPath}; the run produced none`);
}

const report = readJson(reportPath, 'Playwright JSON report');

// ---------------------------------------------------------------- check 1
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

// ---------------------------------------------------------------- check 2
const requestedList = process.argv[3];
const listPath = requestedList || DEFAULT_REQUIRED_LIST;

if (!fs.existsSync(listPath)) {
  if (requestedList) {
    fail(`no required-spec list at ${listPath}; it was named explicitly, so its absence is a failure`);
  }
  console.log(
    `required-spec guard: no list at ${DEFAULT_REQUIRED_LIST}, suite-wide check only. ` +
      'Add that file to name the specs that must never go back to skipping.',
  );
  process.exit(0);
}

const list = readJson(listPath, 'required-spec list');
const required = (list && list.required) || [];
if (!Array.isArray(required)) {
  fail(`required-spec list at ${listPath} has a "required" key that is not an array`);
}
if (required.length === 0) {
  console.log(`required-spec guard: ${listPath} names no required specs, nothing to check`);
  process.exit(0);
}

const seen = collectFiles(report.suites, null, new Map());
const missing = [];
const skippedSpecs = [];

for (const entry of required) {
  const matches = [...seen.entries()].filter(([file]) => samePath(file, entry));
  if (matches.length === 0) {
    missing.push(entry);
    continue;
  }
  if (!matches.some(([, didRun]) => didRun)) skippedSpecs.push(entry);
}

for (const entry of skippedSpecs) {
  console.error(
    `::error::required spec did not execute: ${entry} -- it is in the report and every one of ` +
      'its tests skipped. Most likely cause: the env credentials it guards on are missing or ' +
      'renamed in the dev environment scope, so the spec skipped itself at file scope. It is on ' +
      'the required list precisely so this cannot pass quietly.',
  );
}
for (const entry of missing) {
  console.error(
    `::error::required spec is absent from the report: ${entry} -- no file matching that path ` +
      'appears in the run at all. Most likely cause: it was renamed, moved, deleted, or filtered ' +
      'out by a grep/project selection. Fix the path in ' +
      `${listPath} if the spec legitimately moved.`,
  );
}

if (missing.length > 0 || skippedSpecs.length > 0) {
  fail(
    `${skippedSpecs.length + missing.length} of ${required.length} required spec(s) did not ` +
      `execute (${skippedSpecs.length} skipped, ${missing.length} absent); see the errors above`,
  );
}

console.log(
  `required-spec guard: OK, all ${required.length} required spec(s) executed ` +
    `(${required.map(normalizePath).join(', ')})`,
);
