/**
 * flash-webhook HMAC smoke — directly POST a signed event to the deployed
 * webhook receiver and assert it accepts (or rejects) appropriately.
 *
 * Catches regressions in the HMAC verification path without needing the
 * full mock-flash UI stack (Deno + local Supabase + local Vite). This is
 * the security-critical path: if HMAC verification breaks, a stranger
 * could forge "payment.completed" events and flip arbitrary subscriptions
 * to active. This spec guards exactly that.
 *
 * Skipped when FLASH_WEBHOOK_SECRET is not in env. CI sets it from a repo
 * secret; local devs need to pull from Proton Pass to run.
 *
 * What it asserts:
 *   1. Unsigned POST → HTTP 401 (no signature)
 *   2. Wrong-signature POST → HTTP 401
 *   3. Correctly-signed POST → HTTP 200 (function accepts, logs event)
 *
 * What it does NOT assert (yet — those need the full mock-flash UI stack):
 *   - Billing account flips to 'active' end-to-end
 *   - flash_payment_events row reflects the event
 *   - The Pay button in the UI updates without a manual refresh
 */

import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';

const SECRET = process.env.FLASH_WEBHOOK_SECRET ?? '';
const WEBHOOK_URL =
  process.env.FLASH_WEBHOOK_URL ?? process.env.OWB_E2E_SUPABASE_URL + '/functions/v1/flash-webhook';

// Unsigned + wrong-sig tests always run (no secret needed). The signed
// test skips when FLASH_WEBHOOK_SECRET is absent.

function signBody(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

async function postRaw(
  url: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  return { status: res.status, body: await res.text() };
}

test.describe('flash-webhook HMAC verification', () => {
  // Mock-shaped payment.completed event. Uses a fake external_reference
  // so even if the function tries to update a billing row, no real
  // subscription is touched.
  const eventBody = JSON.stringify({
    type: 'payment.completed',
    data: {
      id: 'evt-smoke-' + Date.now(),
      external_reference: 'no-such-billing-account-' + Date.now(),
      amount: 3000,
      currency: 'USD',
      status: 'completed',
      net_amount: 2970,
      ts: new Date().toISOString(),
    },
  });

  test('unsigned POST returns 401', async () => {
    const r = await postRaw(WEBHOOK_URL, eventBody);
    expect(r.status, `body: ${r.body.slice(0, 200)}`).toBe(401);
  });

  test('wrong-signature POST returns 401', async () => {
    const r = await postRaw(WEBHOOK_URL, eventBody, { 'X-Flash-Signature': 'deadbeef'.repeat(8) });
    expect(r.status, `body: ${r.body.slice(0, 200)}`).toBe(401);
  });

  test('correctly-signed POST accepted (200 or 202)', async () => {
    test.skip(!SECRET, 'FLASH_WEBHOOK_SECRET not set — signed test skipped');
    const sig = signBody(eventBody, SECRET);
    const r = await postRaw(WEBHOOK_URL, eventBody, { 'X-Flash-Signature': sig });
    // 200 = event logged + processed (subscription flipped)
    // 202 = event logged, no matching billing_account (synthetic external_reference)
    expect([200, 202], `body: ${r.body.slice(0, 200)}`).toContain(r.status);
  });
});
