/**
 * flash-webhook — receives Flash payment notifications.
 *
 * Verifies HMAC signature, logs every event, and updates the matching
 * flash_payments + subscriptions rows. Idempotent on re-delivery.
 *
 * SPEC GAPS — Bram has not yet confirmed the exact signature header /
 * algorithm. Defaults below are the standard payments-API choice.
 * When his email lands, edit the four constants and we're done.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse } from '../_shared/http.ts';

// ── Pluggable signature config ──────────────────────────────────────
const SIGNATURE_HEADER = 'X-Flash-Signature';        // header carrying the HMAC
const SIGNATURE_ALGO: 'HMAC-SHA256' = 'HMAC-SHA256'; // hash algorithm
const SIGNATURE_ENCODING: 'hex' | 'base64' = 'hex';  // how the digest is encoded
const SIGNATURE_PREFIX = '';                         // e.g. 'sha256=' on some platforms
// ────────────────────────────────────────────────────────────────────

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RENEWAL_PERIOD_MS = 30 * 24 * 3600 * 1000;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.byteLength; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifySignature(rawBody: string, presentedSig: string | null): Promise<boolean> {
  const secret = Deno.env.get('FLASH_WEBHOOK_SECRET');
  if (!secret) {
    console.error('flash-webhook: FLASH_WEBHOOK_SECRET not set');
    return false;
  }
  if (!presentedSig) return false;
  const presented = SIGNATURE_PREFIX && presentedSig.startsWith(SIGNATURE_PREFIX)
    ? presentedSig.slice(SIGNATURE_PREFIX.length)
    : presentedSig;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: SIGNATURE_ALGO === 'HMAC-SHA256' ? 'SHA-256' : 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody)));
  const computed = SIGNATURE_ENCODING === 'hex' ? bytesToHex(mac) : bytesToBase64(mac);
  return timingSafeEqual(computed.toLowerCase(), presented.toLowerCase());
}

async function logEvent(eventType: string, externalReference: string | null, payload: unknown, signature: string | null) {
  await admin.from('flash_payment_events').insert({
    event_type: eventType,
    external_reference: externalReference,
    payload,
    signature,
  });
}

async function findPayment(externalReference: string) {
  const { data } = await admin
    .from('flash_payments')
    .select('id, subscription_id, status, amount_cents, currency')
    .eq('external_reference', externalReference)
    .maybeSingle();
  return data;
}

async function applyCompleted(externalReference: string, payload: any) {
  const payment = await findPayment(externalReference);
  if (!payment) {
    console.warn(`flash-webhook completed: no flash_payments row for ${externalReference}`);
    return;
  }
  if (payment.status === 'completed') return; // idempotent

  const paidAt = typeof payload?.paidAt === 'string'
    ? payload.paidAt
    : (typeof payload?.paid_at === 'string' ? payload.paid_at : new Date().toISOString());

  const fees = payload?.fees ?? payload ?? {};
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  await admin
    .from('flash_payments')
    .update({
      status: 'completed',
      paid_at: paidAt,
      gross_cents: num(fees.gross_cents ?? fees.grossCents ?? payment.amount_cents),
      flash_fee_cents: num(fees.flash_fee_cents ?? fees.flashFeeCents),
      platform_fee_cents: num(fees.platform_fee_cents ?? fees.platformFeeCents),
      net_cents: num(fees.net_cents ?? fees.netCents),
    })
    .eq('id', payment.id);

  const newPeriodEnd = new Date(new Date(paidAt).getTime() + RENEWAL_PERIOD_MS).toISOString();
  const { data: sub } = await admin
    .from('subscriptions')
    .select('id, status')
    .eq('id', payment.subscription_id)
    .maybeSingle();
  if (sub) {
    await admin
      .from('subscriptions')
      .update({
        status: 'active',
        current_period_end: newPeriodEnd,
        past_due_since: null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', sub.id);
    if (sub.status !== 'active') {
      await admin.from('subscription_lifecycle_events').insert({
        subscription_id: sub.id,
        from_status: sub.status,
        to_status: 'active',
        reason: 'payment.completed',
      });
    }
  }
}

async function applyFailureOrExpiry(externalReference: string, eventType: 'payment.failed' | 'payment.expired') {
  const payment = await findPayment(externalReference);
  if (!payment) return;
  const next = eventType === 'payment.failed' ? 'failed' : 'expired';
  if (payment.status === next) return;
  await admin.from('flash_payments').update({ status: next }).eq('id', payment.id);

  const { data: sub } = await admin
    .from('subscriptions')
    .select('id, status, current_period_end, past_due_since')
    .eq('id', payment.subscription_id)
    .maybeSingle();
  if (!sub) return;
  const now = Date.now();
  const periodOver = sub.current_period_end
    ? new Date(sub.current_period_end).getTime() < now
    : true; // trialing without a paid period — treat as needing payment
  if (periodOver && sub.status !== 'past_due') {
    await admin
      .from('subscriptions')
      .update({
        status: 'past_due',
        past_due_since: sub.past_due_since ?? new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', sub.id);
    await admin.from('subscription_lifecycle_events').insert({
      subscription_id: sub.id,
      from_status: sub.status,
      to_status: 'past_due',
      reason: eventType,
    });
  }
}

async function applyRefund(externalReference: string) {
  const payment = await findPayment(externalReference);
  if (!payment) return;
  if (payment.status === 'refunded') return;
  await admin.from('flash_payments').update({ status: 'refunded' }).eq('id', payment.id);
  // Do not auto-cancel the subscription — refunds need human follow-up.
  // The flash_payment_events row written by the caller carries the audit trail.
}

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  const rawBody = await req.text();
  const presentedSig = req.headers.get(SIGNATURE_HEADER) ?? req.headers.get(SIGNATURE_HEADER.toLowerCase());
  const ok = await verifySignature(rawBody, presentedSig);
  if (!ok) {
    return jsonResponse({ error: 'Unauthorized' }, 401, cors);
  }

  let payload: any;
  try { payload = JSON.parse(rawBody); } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400, cors);
  }

  const eventType: string = typeof payload?.event_type === 'string'
    ? payload.event_type
    : (typeof payload?.type === 'string' ? payload.type : 'unknown');
  const externalReference: string | null =
    typeof payload?.externalReference === 'string' ? payload.externalReference
    : typeof payload?.external_reference === 'string' ? payload.external_reference
    : typeof payload?.data?.externalReference === 'string' ? payload.data.externalReference
    : null;

  // Always log the event for audit. Even unknown event types land here.
  await logEvent(eventType, externalReference, payload, presentedSig);

  try {
    if (externalReference) {
      switch (eventType) {
        case 'payment.completed':
          await applyCompleted(externalReference, payload?.data ?? payload);
          break;
        case 'payment.failed':
          await applyFailureOrExpiry(externalReference, 'payment.failed');
          break;
        case 'payment.expired':
          await applyFailureOrExpiry(externalReference, 'payment.expired');
          break;
        case 'payment.refunded':
          await applyRefund(externalReference);
          break;
        default:
          // unknown event type — already logged, fall through with 200
          break;
      }
    }
  } catch (err) {
    console.error('flash-webhook handler error:', err);
    return jsonResponse({ error: 'Handler error' }, 500, cors);
  }

  return jsonResponse({ ok: true }, 200, cors);
});
