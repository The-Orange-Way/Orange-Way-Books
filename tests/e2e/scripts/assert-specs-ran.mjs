#!/usr/bin/env node
/**
 * DL-0779 zero-spec guard.
 *
 * A Playwright run that finds no tests, or finds only tests that skip
 * themselves, still exits 0. The E2E job then reports green having verified
 * nothing. This reads the JSON report the run writes and fails unless at least
 * one spec actually EXECUTED (expected + unexpected + flaky). Skipped specs do
 * not count: a suite that only skips has proven nothing.
 *
 * Usage: bun tests/e2e/scripts/assert-specs-ran.mjs <path-to-results.json>
 *
 * A missing or unparseable report is itself a failure, not a pass. "The check
 * could not run" must be loud, never silently scored as OK.
 */

import fs from 'node:fs';

const MIN_EXECUTED = 1;

function fail(reason) {
  console.error(`::error::zero-spec guard failed: ${reason}`);
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

const executed =
  (stats.expected || 0) + (stats.unexpected || 0) + (stats.flaky || 0);
const skipped = stats.skipped || 0;

if (executed < MIN_EXECUTED) {
  fail(`${executed} spec(s) executed, ${skipped} skipped; need at least ${MIN_EXECUTED}`);
}

console.log(`zero-spec guard: OK, ${executed} spec(s) executed, ${skipped} skipped`);
