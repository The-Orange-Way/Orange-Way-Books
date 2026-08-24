#!/usr/bin/env node
/**
 * email-drain.mjs — inserts a synthetic row into pending_admin_emails,
 * invokes drain-email-outbox, asserts the row flipped to 'sent', and
 * (optionally) verifies the email arrived via Resend's GET /emails.
 *
 * Env:
 *   V3_DEV_SUPABASE_URL
 *   V3_DEV_SUPABASE_SERVICE_KEY
 *   FLASH_CRON_SECRET           (matches CRON_SECRET on the edge function)
 *   DRAIN_TEST_TO_EMAIL         (required; where the test email goes, your inbox)
 *
 * Usage:
 *   node tests/e2e/email-drain.mjs
 */

const SUPABASE_URL = process.env.V3_DEV_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.V3_DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.FLASH_CRON_SECRET || process.env.CRON_SECRET;
const TO_EMAIL = process.env.DRAIN_TEST_TO_EMAIL;

if (!SUPABASE_URL || !SERVICE_KEY || !CRON_SECRET || !TO_EMAIL) {
  console.error(
    'Missing env. Need V3_DEV_SUPABASE_URL, V3_DEV_SUPABASE_SERVICE_KEY, FLASH_CRON_SECRET, DRAIN_TEST_TO_EMAIL.',
  );
  process.exit(2);
}

const H = {
  Authorization: `Bearer ${SERVICE_KEY}`,
  apikey: SERVICE_KEY,
  'Content-Type': 'application/json',
};

async function rest(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { ...H, Prefer: 'return=representation', ...(opts.headers | {}) },
  });
  if (!r.ok) throw new Error(`${r.status} ${path}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

const stamp = new Date().toISOString();
const subject = `Drainer probe — ${stamp}`;

console.log(`📤 inserting probe row to=${TO_EMAIL} subject="${subject}"`);
const [row] = await rest('pending_admin_emails', {
  method: 'POST',
  body: JSON.stringify({
    to_email: TO_EMAIL,
    subject,
    body_text: `This is an automated probe from tests/e2e/email-drain.mjs at ${stamp}. If you got this, the drainer works.`,
    body_html: `<p>Drainer probe at <code>${stamp}</code> — if this landed in your inbox, the Resend wiring is live.</p>`,
    status: 'pending',
  }),
});
console.log(`   queued row id=${row.id}`);

console.log('\n⚙️  invoking drain-email-outbox…');
const r = await fetch(`${SUPABASE_URL}/functions/v1/drain-email-outbox`, {
  method: 'POST',
  headers: { 'X-Cron-Secret': CRON_SECRET, 'Content-Type': 'application/json' },
});
const text = await r.text();
console.log(`   HTTP ${r.status}: ${text}`);

console.log('\n🔎 re-reading row status');
const [after] = await rest(`pending_admin_emails?id=eq.${row.id}&select=status,sent_at`);
console.log(`   status=${after.status} sent_at=${after.sent_at}`);

if (after.status === 'sent') {
  console.log(`\n✅ drainer works. Check ${TO_EMAIL} for the probe email.`);
} else {
  console.log(`\n❌ drainer did NOT mark row sent. Inspect drain-email-outbox logs.`);
  process.exit(1);
}
