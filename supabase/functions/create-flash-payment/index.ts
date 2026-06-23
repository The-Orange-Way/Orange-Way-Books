/**
 * create-flash-payment, generates a Flash payment link for the caller's
 * subscription. Customer-facing: any authed user who has a subscription
 * via their org's billing_account can call this.
 *
 * Request body (JSON):
 *   { subscriptionId?: string }
 *   - Optional. Defaults to the caller's only visible subscription.
 *
 * Optional header:
 *   Idempotency-Key: <opaque string>
 *   - If a pending flash_payments row exists with the same key and was
 *     created within IDEMPOTENCY_WINDOW_MS, we return its existing URL
 *     instead of minting a new one.
 *
 * Response:
 *   { flashPaymentId, url, externalReference }
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { rateLimit } from '../_shared/rate-limit.ts';
import { createPaymentLink } from '../_shared/flash.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const IDEMPOTENCY_WINDOW_MS = 10 * 60 * 1000;
const PAYMENT_EXPIRES_IN_SECONDS = 24 * 3600;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function listVisibleSubscriptionIds(userId: string): Promise<string[]> {
  // Subscriptions visible to the caller: those whose billing_account is
  // either owned by the caller or attached to an org the caller belongs to.
  const { data: owned } = await admin
    .from('billing_accounts')
    .select('id')
    .eq('owner_user_id', userId);
  const { data: memberOrgs } = await admin
    .from('org_members')
    .select('org_id')
    .eq('user_id', userId);

  const ownedIds = (owned ?? []).map((r) => r.id as string);
  const orgIds = (memberOrgs ?? []).map((r) => r.org_id as string);

  let memberBaIds: string[] = [];
  if (orgIds.length > 0) {
    const { data: orgRows } = await admin
      .from('organizations')
      .select('billing_account_id')
      .in('id', orgIds);
    memberBaIds = (orgRows ?? [])
      .map((r) => r.billing_account_id as string | null)
      .filter((id): id is string => !!id);
  }

  const allBaIds = Array.from(new Set([...ownedIds, ...memberBaIds]));
  if (allBaIds.length === 0) return [];

  const { data: subs } = await admin
    .from('subscriptions')
    .select('id')
    .in('billing_account_id', allBaIds);
  return (subs ?? []).map((r) => r.id as string);
}

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401, cors);
  }
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user: caller },
    error: authErr,
  } = await callerClient.auth.getUser();
  if (authErr || !caller) {
    return jsonResponse({ error: 'Unauthorized' }, 401, cors);
  }

  // M5, 2026-05-19 audit. 10 payment-link creations per user per 5 min.
  // Real users almost never need more than one in a session; cap is
  // protection against runaway client retries hammering Flash.
  const rl = await rateLimit(admin, {
    scope: 'create-flash-payment',
    subject: caller.id,
    maxPerWindow: 10,
    windowSeconds: 300,
  });
  if (!rl.allowed) {
    return jsonResponse({ error: 'Rate limit exceeded; try again shortly' }, 429, cors);
  }

  const raw = await readBoundedText(req);
  if (raw === null) return jsonResponse({ error: 'Body too large' }, 413, cors);
  let parsed: { subscriptionId?: string } = {};
  if (raw.trim().length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonResponse({ error: 'Body must be JSON' }, 400, cors);
    }
  }

  const visibleIds = await listVisibleSubscriptionIds(caller.id);
  if (visibleIds.length === 0) {
    return jsonResponse({ error: 'No subscription for caller' }, 404, cors);
  }

  let subId = parsed.subscriptionId ?? null;
  if (subId) {
    if (!visibleIds.includes(subId)) {
      return jsonResponse({ error: 'Subscription not visible to caller' }, 403, cors);
    }
  } else {
    if (visibleIds.length > 1) {
      return jsonResponse({ error: 'subscriptionId required (caller has multiple)' }, 400, cors);
    }
    subId = visibleIds[0];
  }

  const { data: sub, error: subErr } = await admin
    .from('subscriptions')
    .select('id, plan, price_cents, currency, status')
    .eq('id', subId)
    .maybeSingle();
  if (subErr || !sub) {
    return jsonResponse({ error: 'Subscription not found' }, 404, cors);
  }

  const idempotencyKey = req.headers.get('Idempotency-Key');
  if (idempotencyKey) {
    const cutoff = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS).toISOString();
    const { data: existing } = await admin
      .from('flash_payments')
      .select('id, flash_payment_link_url, external_reference, status, created_at')
      .eq('idempotency_key', idempotencyKey)
      .eq('subscription_id', sub.id)
      .gte('created_at', cutoff)
      .order('created_at', { ascending: false })
      .limit(1);
    const row = existing?.[0];
    if (row && row.status === 'pending' && row.flash_payment_link_url) {
      return jsonResponse(
        {
          flashPaymentId: row.id,
          url: row.flash_payment_link_url,
          externalReference: row.external_reference,
          idempotent: true,
        },
        200,
        cors,
      );
    }
  }

  const externalReference = crypto.randomUUID();

  // Insert pending row first so the webhook can find it even if the
  // Flash call below races a fast-arriving completion event.
  const { data: inserted, error: insertErr } = await admin
    .from('flash_payments')
    .insert({
      subscription_id: sub.id,
      external_reference: externalReference,
      amount_cents: sub.price_cents,
      currency: sub.currency,
      status: 'pending',
      idempotency_key: idempotencyKey,
    })
    .select('id')
    .single();
  if (insertErr || !inserted) {
    console.error('create-flash-payment insert error:', insertErr);
    return jsonResponse({ error: 'Failed to create payment record' }, 500, cors);
  }

  let link;
  try {
    link = await createPaymentLink(admin, {
      amountCents: sub.price_cents,
      currency: sub.currency,
      description: `Orange Way Books, ${sub.plan}`,
      externalReference,
      expiresInSeconds: PAYMENT_EXPIRES_IN_SECONDS,
    });
  } catch (err) {
    console.error('create-flash-payment Flash error:', err);
    await admin.from('flash_payments').update({ status: 'failed' }).eq('id', inserted.id);
    return jsonResponse({ error: 'Flash payment link creation failed' }, 502, cors);
  }

  const { error: updateErr } = await admin
    .from('flash_payments')
    .update({ flash_payment_link_url: link.url })
    .eq('id', inserted.id);
  if (updateErr) {
    console.error('create-flash-payment link update error:', updateErr);
  }

  return jsonResponse(
    {
      flashPaymentId: inserted.id,
      url: link.url,
      externalReference,
    },
    200,
    cors,
  );
});
