#!/usr/bin/env node
/**
 * DL-0947 E2E failure summarizer.
 *
 * When the E2E job fails, the failing expect() label used to live only
 * inside the uploaded artifact zip. This reads the Playwright JSON report and
 * writes each failing spec's title and the first line of its error into the
 * GitHub run summary (GITHUB_STEP_SUMMARY), so the label is readable on the
 * run page with no download and no log paste.
 *
 * Usage: bun tests/e2e/scripts/summarize-failures.mjs <path-to-results.json>
 *
 * Informational ONLY. It runs on the failure path (if: failure()), so it must
 * never exit non-zero and never mask the real failure: any problem reading the
 * report degrades to a note, not a second red step.
 */

import fs from 'node:fs';

function emit(markdown) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (summaryPath) {
    try {
      fs.appendFileSync(summaryPath, markdown + '\n');
      return;
    } catch {
      // fall through to stdout
    }
  }
  console.log(markdown);
}

const reportPath = process.argv[2];
const heading = '### E2E failing assertions (DL-0947)';

if (!reportPath || !fs.existsSync(reportPath)) {
  const where = reportPath || '<none>';
  const note = `${heading}\n\n_no Playwright JSON report at ${where}; nothing to summarize_`;
  emit(note);
  process.exit(0);
}

let report;
try {
  report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
} catch (err) {
  emit(`${heading}\n\n_report is not valid JSON: ${err.message}_`);
  process.exit(0);
}

const lines = [];

function firstLine(text) {
  const str = String(text || '');
  return str.split('\n')[0].trim();
}

function collectErrors(result) {
  if (result.errors && result.errors.length) return result.errors;
  if (result.error) return [result.error];
  return [];
}

function walk(suite) {
  if (!suite || typeof suite !== 'object') return;
  for (const spec of suite.specs || []) {
    for (const test of spec.tests || []) {
      for (const result of test.results || []) {
        if (result.status === 'failed' || result.status === 'timedOut') {
          const errors = collectErrors(result);
          const parts = errors.map((e) => firstLine(e.message));
          const msg = parts.filter(Boolean).join(' | ');
          lines.push(`- **${spec.title || 'spec'}** (${result.status})${msg ? ': ' + msg : ''}`);
        }
      }
    }
  }
  for (const child of suite.suites || []) walk(child);
}

for (const suite of report.suites || []) walk(suite);

const body = lines.length ? lines.join('\n') : '_no failing spec found in the report_';

emit(`${heading}\n\n${body}`);
process.exit(0);
