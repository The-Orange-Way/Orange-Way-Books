/**
 * owb-or-proxy: Orange Way Books to OrangeRails proxy.
 *
 * Orange Way Books is a Plaid-style platform consumer of OrangeRails. End users
 * of Orange Way Books never see OR; this proxy holds the OR_PLATFORM_API_KEY
 * (Supabase secret) and forwards user requests to OR's edge functions
 * with the platform key + the org's subaccount_id added.
 *
 * One subaccount per Orange Way Books org (vault is per-org). The first call to
 * `or-provision` from any user in an org establishes the subaccount;
 * subsequent calls return the same id (idempotent).
 *
 * POST body:
 *   endpoint: one of:
 *     'or-provision' | 'or-connection-create' | 'or-connection-list'
 *     | 'or-connection-delete' | 'or-sync' | 'or-transactions-list'
 *     | 'or-discover-wallets' | 'or-source-wallets-set'
 *   org_id: uuid  the Orange Way Books org to act on (caller must be a member)
 *   payload: object  forwarded to OR; subaccount_id auto-injected for
 *                    non-provision endpoints if not present
 *
 * For or-provision: external_user_id is set to the org_id automatically.
 * For all others: subaccount_id is looked up from a small in-memory cache
 * (per warm function instance) or re-provisioned on miss.
 *
 * Response: passes through OR's response body and status.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { rateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
// Canonical Orange Rails API gateway. The Cloudflare Worker at
// api.orangerails.com proxies /functions/v1/or-* to the live OR
// project and survives any future OR backend migration without
// requiring OWB to redeploy. Keep OR_SUPABASE_URL as an override
// knob for one-off / staging integrations only.
//
// Previous comment: the silent empty default routed Connections requests
// to a dead project ref and surfaced as a
// confusing 401. The canonical URL fixes that root cause; the gateway
// re-targets internally if the underlying OR project ever moves.
const OR_SUPABASE_URL = Deno.env.get('OR_SUPABASE_URL') ?? 'https://api.orangerails.com';
const OR_PLATFORM_API_KEY = Deno.env.get('OR_PLATFORM_API_KEY');

// Service-role client used ONLY for rate-limit bookkeeping. All OR
// forwarding still uses the caller's JWT via userClient below.
const rlClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const ALLOWED_ENDPOINTS = new Set([
  'or-provision',
  'or-connection-create',
  'or-connection-list',
  'or-connection-delete',
  'or-sync',
  'or-transactions-list',
  // Phase 3: source-wallet discovery + per-wallet sync selection.
  'or-discover-wallets',
  'or-source-wallets-set',
]);

async function callOr(endpoint: string, body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${OR_SUPABASE_URL}/functions/v1/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Platform-API-Key': OR_PLATFORM_API_KEY!,
    },
    body: JSON.stringify(body),
  });
}

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  // (Removed 2026-05-16: was a debug header dump that truncated Authorization /
  // apikey / cookie values to their first 40 chars and logged them. Even
  // truncated, partial bearer tokens can be correlated against breach
  // databases or accumulated across requests — better to never log them.
  // If we ever need to diagnose auth issues here, hash the headers instead.)

  if (!OR_PLATFORM_API_KEY) {
    return jsonResponse({ error: 'OR_PLATFORM_API_KEY secret not configured' }, 500, cors);
  }
  if (!OR_SUPABASE_URL) {
    return jsonResponse({ error: 'OR_SUPABASE_URL secret not configured' }, 500, cors);
  }

  try {
    // ── Authenticate caller via Supabase JWT ─────────────────────────
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) return jsonResponse({ error: 'Missing Authorization header' }, 401, cors);

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user },
      error: authErr,
    } = await userClient.auth.getUser();
    if (authErr || !user) return jsonResponse({ error: 'Unauthorized' }, 401, cors);

    // ── Rate limit (M5 — 2026-05-19 audit) ───────────────────────────
    // 30 OR calls per user per minute. Caps cost-amplification against
    // OR's edge functions; Connections page rarely exceeds a handful.
    const rl = await rateLimit(rlClient, {
      scope: 'owb-or-proxy',
      subject: user.id,
      maxPerWindow: 30,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      return jsonResponse({ error: 'Rate limit exceeded; try again shortly' }, 429, cors);
    }

    // ── Parse body ───────────────────────────────────────────────────
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    const body = JSON.parse(raw) as {
      endpoint?: string;
      org_id?: string;
      payload?: Record<string, unknown>;
    };

    const { endpoint, org_id, payload = {} } = body;
    if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
      return jsonResponse(
        { error: `endpoint must be one of: ${[...ALLOWED_ENDPOINTS].join(', ')}` },
        400,
        cors,
      );
    }
    if (!org_id) return jsonResponse({ error: 'org_id required' }, 400, cors);

    // ── Verify caller is a member of org_id ──────────────────────────
    const { data: membership } = await userClient
      .from('org_members')
      .select('org_id')
      .eq('org_id', org_id)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!membership) return jsonResponse({ error: 'Not a member of this org' }, 403, cors);

    // ── Build the OR request body ────────────────────────────────────
    let orBody: Record<string, unknown>;

    if (endpoint === 'or-provision') {
      // Provision uses org_id as external_user_id (one subaccount per org).
      orBody = { external_user_id: org_id };
    } else {
      // For everything else, subaccount_id must be present on the OR call.
      // Source of truth is organizations.or_subaccount_id (set by the
      // or-provision mirror below). The browser caches the value too but
      // a cleared cache used to surface as a 400; now the server resolves
      // it via service role on the verified org_id and injects it.
      // Always resolve subaccount_id server-side from the verified org_id.
      // Never trust a client-supplied value: an authenticated member of org A
      // could otherwise pass org B's subaccount_id and operate against B's
      // Orange Rails state.
      const resolverClient = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
      const { data: orgRow } = await resolverClient
        .from('organizations')
        .select('or_subaccount_id')
        .eq('id', org_id)
        .maybeSingle();
      const resolved = (orgRow as { or_subaccount_id?: unknown } | null)?.or_subaccount_id;
      if (typeof resolved !== 'string' || !resolved) {
        return jsonResponse(
          { error: 'org is not provisioned on Orange Rails (call or-provision first)' },
          400,
          cors,
        );
      }
      orBody = { ...payload, subaccount_id: resolved };
    }

    const orRes = await callOr(endpoint, orBody);
    const orJson = await orRes.json().catch(() => ({ error: 'OR returned non-JSON response' }));

    // After a successful or-provision call, mirror the subaccount_id to
    // organizations.or_subaccount_id so or-webhook-receiver can resolve
    // sync.completed events back to this org. The browser also caches it
    // in localStorage; the server-side row is the source of truth for
    // webhook processing.
    if (endpoint === 'or-provision' && orRes.status >= 200 && orRes.status < 300) {
      const subId = (orJson as { subaccount_id?: unknown }).subaccount_id;
      if (typeof subId === 'string' && subId.length > 0) {
        // Use service-role client so the UPDATE doesn't trip RLS. The
        // caller already proved org membership above; this is safe.
        const adminClient = createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
          { auth: { autoRefreshToken: false, persistSession: false } },
        );
        const { error: mapErr } = await adminClient
          .from('organizations')
          .update({ or_subaccount_id: subId })
          .eq('id', org_id);
        if (mapErr) {
          // Don't fail the request — the browser localStorage cache still
          // works and the receiver will return 202 (accepted_no_org) if
          // the mapping isn't found. Surface as a server log for now.
          console.error(
            '[owb-or-proxy] failed to mirror subaccount_id to organizations:',
            mapErr.message,
          );
        }
      }
    }

    return jsonResponse(orJson, orRes.status, cors);
  } catch (err) {
    console.error('[owb-or-proxy] fatal:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});
