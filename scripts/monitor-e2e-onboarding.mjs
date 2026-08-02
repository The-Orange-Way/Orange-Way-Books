/**
 * Monitor for the OWB E2E onboarding run.
 *
 * Reads a Playwright JSON report and asserts that the run executed the number
 * of tests we expect. It exists because a run that never happened and a run
 * that passed look identical to CI: both leave a green job. This monitor makes
 * the difference loud.
 *
 * Two distinct failure modes, each its own non-zero exit code. They are never
 * the same branch, so "I could not check" can never be silently reported as
 * "nothing went wrong":
 *
 *   EXIT_UNREADABLE (2)  the report file is missing, unreadable, not valid
 *                        JSON, or not a Playwright report (no numeric stats).
 *                        This is "could not check", not "zero failures".
 *   EXIT_MISMATCH   (3)  the report parsed but the executed-test count does
 *                        not equal the expected count.
 *   EXIT_OK         (0)  the executed count matches the expected count.
 *
 * Counting: Playwright records each test once, by final status, in exactly one
 * of stats.expected / unexpected / flaky / skipped. Retries do NOT add extra
 * counts: a test that fails then passes on retry lands in `flaky` once, not in
 * `expected`. So the number of tests actually executed is
 * expected + unexpected + flaky. `skipped` tests were declared but not run and
 * are excluded from the executed count.
 *
 * CLI:
 *   node scripts/monitor-e2e-onboarding.mjs <reportPath> <expectedTestCount>
 *   E2E_REPORT_PATH=... E2E_EXPECTED_TESTS=... node scripts/monitor-e2e-onboarding.mjs
 *
 * The pure functions are exported so vitest can drive both failure modes
 * deterministically without spawning a process.
 */

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const EXIT_OK = 0;
export const EXIT_UNREADABLE = 2;
export const EXIT_MISMATCH = 3;

/**
 * Read and validate a Playwright JSON report.
 * Returns { ok: true, stats } or { ok: false, reason }.
 */
export function readReport(reportPath) {
  let raw;
  try {
    raw = fs.readFileSync(reportPath, 'utf8');
  } catch (e) {
    return { ok: false, reason: `report not found or unreadable at ${reportPath}: ${e.code || e.message}` };
  }

  let report;
  try {
    report = JSON.parse(raw);
  } catch (e) {
    return { ok: false, reason: `report at ${reportPath} is not valid JSON: ${e.message}` };
  }

  const stats = report && typeof report === 'object' ? report.stats : undefined;
  if (!stats || typeof stats !== 'object') {
    return { ok: false, reason: `report at ${reportPath} has no stats object; not a Playwright JSON report` };
  }

  // A stats object whose buckets are all non-numeric is a malformed report,
  // not a real run of zero tests. Treat it as "could not check".
  const buckets = ['expected', 'unexpected', 'flaky', 'skipped'];
  if (!buckets.some((k) => typeof stats[k] === 'number')) {
    return { ok: false, reason: `report at ${reportPath} has a stats object with no numeric counts; not a Playwright JSON report` };
  }

  return { ok: true, stats };
}

/**
 * Number of tests the run actually executed. Retries do not inflate this:
 * each test is counted once by final status. `skipped` are excluded because
 * they were declared but not run.
 */
export function countExecuted(stats) {
  const n = (v) => (Number.isFinite(v) ? v : 0);
  return n(stats.expected) + n(stats.unexpected) + n(stats.flaky);
}

/**
 * Run the check. Returns { code, message }.
 */
export function check({ reportPath, expected }) {
  if (!Number.isInteger(expected) || expected < 0) {
    return {
      code: EXIT_UNREADABLE,
      message: `COULD NOT CHECK: expected test count must be a non-negative integer, got ${JSON.stringify(expected)}`,
    };
  }

  const r = readReport(reportPath);
  if (!r.ok) {
    return { code: EXIT_UNREADABLE, message: `COULD NOT CHECK: ${r.reason}` };
  }

  const executed = countExecuted(r.stats);
  if (executed !== expected) {
    const s = r.stats;
    return {
      code: EXIT_MISMATCH,
      message:
        `COUNT MISMATCH: expected ${expected} tests, report executed ${executed} ` +
        `(expected=${s.expected} unexpected=${s.unexpected} flaky=${s.flaky} skipped=${s.skipped})`,
    };
  }

  return { code: EXIT_OK, message: `OK: ${executed} tests executed, matches expected ${expected}` };
}

function runCli() {
  const reportPath = process.env.E2E_REPORT_PATH || process.argv[2] || 'test-results/results.json';
  const expectedRaw = process.env.E2E_EXPECTED_TESTS ?? process.argv[3];

  if (expectedRaw === undefined || expectedRaw === '') {
    console.error(
      'usage: node scripts/monitor-e2e-onboarding.mjs <reportPath> <expectedTestCount>\n' +
        '   or: E2E_REPORT_PATH=... E2E_EXPECTED_TESTS=... node scripts/monitor-e2e-onboarding.mjs',
    );
    process.exit(EXIT_UNREADABLE);
  }

  const expected = Number.parseInt(String(expectedRaw), 10);
  const { code, message } = check({ reportPath, expected: Number.isNaN(expected) ? expectedRaw : expected });
  (code === EXIT_OK ? console.log : console.error)(message);
  process.exit(code);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
