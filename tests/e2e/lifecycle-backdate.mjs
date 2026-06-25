#!/usr/bin/env node
/**
 * lifecycle-backdate.mjs — exercises the subscription-lifecycle cron
 * without waiting 45 real days.
 *
 * For each transition (trialing → past_due → read_only → locked), we:
 *   1. Backdate the relevant timestamp on a real subscription row.
 *   2. POST to the subscription-lifecycle edge function with the
 *      cron secret.
 *   3. Assert the new status + that a row was written to
 *      subscription_lifecycle_events + that an email was queued in
 *      pending_admin_emails.
 *
 * Env (sourced from the deploy environment):
 *   V3_DEV_SUPABASE_URL
 *   V3_DEV_SUPABASE_SERVICE_KEY
 *   FLASH_CRON_SECRET   (matches CRON_SECRET on the edge function)
 *
 * Usage:
 *   node tests/e2e/lifecycle-backdate.mjs
 *
 * The script creates a throwaway billing_account + subscription, walks
 * it through the lifecycle, then deletes both at the end.
 */

import { randomUUID } from 'node:crypto';

const SUPABASE_URL = process.env.V3_DEV_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.V3_DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.FLASH_CRON_SECRET || process.env.CRON_SECRET;

if (!SUPABASE_URL || !SERVICE_KEY || !CRON_SECRET) {
  console.error(
    'Missing env. Need V3_DEV_SUPABASE_URL, V3_DEV_SUPABASE_SERVICE_KEY, FLASH_CRON_SECRET.',
  );
  process.exit(2);
}

const H = {
  Authorization: `Bearer ${SERVICE_KEY}`,
  apikey: SERVICE_KEY,
  'Content-Type': 'application/json',
};
const DAY = 24 * 3600 * 1000;
const iso = (ms) => new Date(ms).toISOString();
const now = Date.now();

async function rest(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { ...H, Prefer: 'return=representation', ...(opts.headers | {}) },
  });
  if (!r.ok) throw new Error(`${r.status} ${path}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function runCron() {
  const r = await fetch(`${SUPABASE_URL}/functions/v1/subscription-lifecycle`, {
    method: 'POST',
    headers: { 'X-Cron-Secret': CRON_SECRET, 'Content-Type': 'application/json' },
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`cron ${r.status}: ${text}`);
  return JSON.parse(text);
}

async function getSub(id) {
  const [row] = await rest(
    `subscriptions?id=eq.${id}&select=status,past_due_since,locked_at,scheduled_deletion_at`,
  );
  return row;
}

async function countEvents(subId, toStatus) {
  const rows = await rest(
    `subscription_lifecycle_events?subscription_id=eq.${subId}&to_status=eq.${toStatus}&select=id`,
  );
  return rows.length;
}

async function countQueuedEmails(toEmail) {
  const rows = await rest(
    `pending_admin_emails?to_email=eq.${encodeURIComponent(toEmail)}&select=subject,status`,
  );
  return rows;
}

function assert(cond, msg) {
  if (!cond) {
    console.error(`❌ ${msg}`);
    process.exitCode = 1;
  } else console.log(`✅ ${msg}`);
}

// ─── Setup: create a throwaway billing_account + subscription ────────────
console.log('🧪 setting up test billing_account + subscription');

const ownerEmail = `lifecycle+${randomUUID()}@owb.test`;
const adminUser = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
  method: 'POST',
  headers: H,
  body: JSON.stringify({ email: ownerEmail, password: `T-${randomUUID()}!`, email_confirm: true }),
}).then((r) => r.json());

const ownerId = adminUser.id;
console.log(`   owner user_id=${ownerId}, email=${ownerEmail}`);

const [billing] = await rest('billing_accounts', {
  method: 'POST',
  body: JSON.stringify({ type: 'org', display_name: 'lifecycle-test', owner_user_id: ownerId }),
});
const billingId = billing.id;

const [sub] = await rest('subscriptions', {
  method: 'POST',
  body: JSON.stringify({
    billing_account_id: billingId,
    plan: 'vault-monthly',
    price_cents: 3000,
    currency: 'USD',
    status: 'trialing',
    trial_ends_at: iso(now + 45 * DAY),
  }),
});
console.log(`   subscription id=${sub.id} (trialing)`);

try {
  // ── Phase 1: backdate trial_ends_at → past, expect past_due ──────────
  console.log('\n📅 phase 1: trialing → past_due');
  await rest(`subscriptions?id=eq.${sub.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ trial_ends_at: iso(now - 1 * DAY) }),
  });
  let report = await runCron();
  console.log('   cron report:', report);
  let after = await getSub(sub.id);
  assert(after.status === 'past_due', `status is past_due (got ${after.status})`);
  assert((await countEvents(sub.id, 'past_due')) >= 1, 'lifecycle event written for past_due');

  // ── Phase 2: backdate past_due_since 46 days, expect read_only ───────
  console.log('\n📅 phase 2: past_due → read_only');
  await rest(`subscriptions?id=eq.${sub.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ past_due_since: iso(now - 46 * DAY) }),
  });
  report = await runCron();
  console.log('   cron report:', report);
  after = await getSub(sub.id);
  assert(after.status === 'read_only', `status is read_only (got ${after.status})`);
  assert((await countEvents(sub.id, 'read_only')) >= 1, 'lifecycle event written for read_only');

  // ── Phase 3: backdate past_due_since 91 days, expect locked ──────────
  console.log('\n📅 phase 3: read_only → locked');
  await rest(`subscriptions?id=eq.${sub.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ past_due_since: iso(now - 91 * DAY) }),
  });
  report = await runCron();
  console.log('   cron report:', report);
  after = await getSub(sub.id);
  assert(after.status === 'locked', `status is locked (got ${after.status})`);
  assert(after.locked_at !== null, 'locked_at set');
  assert((await countEvents(sub.id, 'locked')) >= 1, 'lifecycle event written for locked');

  // ── Email queue check ────────────────────────────────────────────────
  console.log('\n📧 checking queued emails for owner');
  const emails = await countQueuedEmails(ownerEmail);
  console.log(`   ${emails.length} rows in pending_admin_emails for ${ownerEmail}`);
  emails.forEach((e) => console.log(`     • [${e.status}] ${e.subject}`));
  assert(emails.length >= 3, 'at least 3 lifecycle emails queued (one per transition)');
} finally {
  // ── Cleanup ──────────────────────────────────────────────────────────
  console.log('\n🧹 cleanup');
  await rest(`subscriptions?id=eq.${sub.id}`, { method: 'DELETE' }).catch(() => {});
  await rest(`billing_accounts?id=eq.${billingId}`, { method: 'DELETE' }).catch(() => {});
  await rest(`pending_admin_emails?to_email=eq.${encodeURIComponent(ownerEmail)}`, {
    method: 'DELETE',
  }).catch(() => {});
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${ownerId}`, {
    method: 'DELETE',
    headers: H,
  }).catch(() => {});
}

console.log('\n✨ done.');
