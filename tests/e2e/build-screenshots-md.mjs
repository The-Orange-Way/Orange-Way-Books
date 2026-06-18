#!/usr/bin/env node
/**
 * Reads tests/e2e/__screenshots__/captions.json (produced by the
 * Playwright spec) and renders SCREENSHOTS.md alongside it. This
 * markdown file is the deliverable for Bram at Flash — it pairs each
 * captured PNG with its caption in narrative order.
 *
 * Captions are written in the order test steps complete. We re-sort by
 * the leading `NN-` prefix on `name` so the output is always 01 → 10.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const shotsDir = path.join(__dirname, '__screenshots__');
const captionsPath = path.join(shotsDir, 'captions.json');
const outPath = path.join(shotsDir, 'SCREENSHOTS.md');

if (!fs.existsSync(captionsPath)) {
  console.error(`No captions found at ${captionsPath}. Did you run \`npm run test:e2e\` first?`);
  process.exit(1);
}

/** @type {{name:string,file:string,caption:string,status:string,skipReason?:string}[]} */
const captions = JSON.parse(fs.readFileSync(captionsPath, 'utf8'));
captions.sort((a, b) => a.name.localeCompare(b.name));

const titles = {
  '01-signup': 'New user signup',
  '02-billing-page-trialing': 'Billing page during trial',
  '03-admin-flash-empty': 'Admin Flash before connection',
  '04-admin-flash-redirect': 'OAuth redirect to Flash',
  '05-admin-flash-connected': 'Admin Flash after OAuth',
  '06-billing-pay-button': 'Customer sees Pay $30',
  '07-flash-checkout-page': 'Flash-hosted checkout',
  '08-payment-marked-paid': 'Payment completed → webhook',
  '09-billing-active': 'Subscription active',
  '10-payment-history': 'Payment history',
};

const lines = [
  '# Orange Way Books — Pay with Flash E2E Flow',
  '',
  'Captured against a local stack: Orange Way Books dev server +',
  '`supabase start` + the mock Flash server in `scripts/mock-flash/`.',
  'Each step below is a real screenshot from the running app.',
  '',
  'In production, the only differences are:',
  '',
  '- Flash authorize / token / payment-link URLs point at',
  '  `api.paywithflash.com` instead of the local mock.',
  '- `payment.completed` webhooks come from Flash with the real',
  '  HMAC signature (header / algo / encoding are configurable at the',
  '  top of `supabase/functions/flash-webhook/index.ts`).',
  '- Fee fields come from Flash; the mock injects a 1% flash fee for',
  '  demonstration.',
  '',
  '---',
  '',
];

let idx = 1;
for (const entry of captions) {
  const title = titles[entry.name] ?? entry.name;
  lines.push(`## ${idx}. ${title}`);
  lines.push('');
  if (entry.status === 'captured') {
    lines.push(`![${entry.name}](${entry.file})`);
  } else {
    lines.push(`_(screenshot skipped: ${entry.skipReason ?? 'unknown reason'})_`);
  }
  lines.push('');
  lines.push(entry.caption);
  lines.push('');
  lines.push('---');
  lines.push('');
  idx += 1;
}

fs.writeFileSync(outPath, lines.join('\n'));
console.log(`Wrote ${outPath}`);
