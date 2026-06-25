#!/usr/bin/env node
/**
 * webhook-probe.mjs — minimal HMAC probe for the flash-webhook function.
 *
 * Posts a synthetic payment.completed with no DB side-effects (uses a
 * known-bogus external_reference) and prints both the computed signature
 * and the function's response. If we get 401, the secret on the edge
 * function differs from the local FLASH_WEBHOOK_SECRET. If we get 200,
 * the signing scheme is correct and the real e2e webhook step should
 * work too — investigate the script's payload instead.
 *
 * Env (sourced from the deploy environment):
 *   V3_DEV_SUPABASE_URL
 *   V3_DEV_SUPABASE_ANON_KEY
 *   FLASH_WEBHOOK_SECRET
 *
 * Usage:
 *   node tests/e2e/webhook-probe.mjs
 */

import { createHmac } from 'node:crypto';

const SUPABASE_URL = process.env.V3_DEV_SUPABASE_URL || process.env.SUPABASE_URL;
const ANON_KEY = process.env.V3_DEV_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
const SECRET = process.env.FLASH_WEBHOOK_SECRET;

if (!SUPABASE_URL || !ANON_KEY || !SECRET) {
  console.error(
    'Missing env. Need V3_DEV_SUPABASE_URL, V3_DEV_SUPABASE_ANON_KEY, FLASH_WEBHOOK_SECRET.',
  );
  process.exit(2);
}

const payload = JSON.stringify({
  event_type: 'payment.completed',
  external_reference: 'probe-ignored',
  gross_cents: 3000,
});

const sig = createHmac('sha256', SECRET).update(payload).digest('hex');

console.log('🔎 probe parameters');
console.log(`   secret length: ${SECRET.length} chars`);
console.log(`   body length:   ${payload.length} bytes`);
console.log(`   computed sig:  ${sig.slice(0, 16)}…${sig.slice(-8)}`);
console.log(`   body sample:   ${payload}`);

const r = await fetch(`${SUPABASE_URL}/functions/v1/flash-webhook`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Flash-Signature': sig,
    Authorization: `Bearer ${ANON_KEY}`,
  },
  body: payload,
});
const text = await r.text();
console.log(`\n📨 response: HTTP ${r.status}`);
console.log(`   body: ${text}`);

if (r.status === 401) {
  console.log('\n❌ 401 = signature mismatch.');
  console.log('   Likely causes:');
  console.log('   1. FLASH_WEBHOOK_SECRET on the edge function ≠ deploy-env value');
  console.log('      Fix: SUPABASE_ACCESS_TOKEN=$SUPABASE_ACCESS_TOKEN_LAB \\');
  console.log('           supabase secrets set --project-ref pfoywzsziessalioerlg \\');
  console.log('             FLASH_WEBHOOK_SECRET="$FLASH_WEBHOOK_SECRET"');
  console.log('   2. Secret has trailing whitespace in one of the two places.');
  console.log('   3. The edge function was deployed before the secret was set.');
  console.log(
    '      Fix: redeploy: supabase functions deploy flash-webhook --project-ref pfoywzsziessalioerlg',
  );
} else if (r.status === 200) {
  console.log('\n✅ signing scheme is correct.');
}
