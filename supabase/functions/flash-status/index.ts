/**
 * flash-status — Supabase Edge Function
 *
 * Owner-gated GET returning whether the platform Flash connection is
 * live. Reads flash_platform_tokens (service-role only, RLS blocks
 * clients) and reports {connected, expiresAt, scopes}.
 *
 * Owner gate: caller must be OWNER on at least one organization. Wave 1
 * is single-merchant so any OWNER in the project is treated as an
 * admin for this surface.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse } from '../_shared/http.ts';
import { rateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401, cors);
  }
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
  if (authErr || !caller) {
    return jsonResponse({ error: 'Unauthorized' }, 401, cors);
  }

  // M5 — 2026-05-19 audit. 60 status polls per user per minute; admin
  // pages typically poll once on mount + on demand.
  const rl = await rateLimit(admin, {
    scope: 'flash-status',
    subject: caller.id,
    maxPerWindow: 60,
    windowSeconds: 60,
  });
  if (!rl.allowed) {
    return jsonResponse({ error: 'Rate limit exceeded; try again shortly' }, 429, cors);
  }

  const { data: ownerRows, error: ownerErr } = await admin
    .from('org_members')
    .select('role')
    .eq('user_id', caller.id)
    .eq('role', 'OWNER')
    .limit(1);
  if (ownerErr) {
    console.error('flash-status owner lookup error:', ownerErr);
    return jsonResponse({ error: 'Authorization check failed' }, 500, cors);
  }
  if (!ownerRows || ownerRows.length === 0) {
    return jsonResponse({ error: 'Owner role required' }, 403, cors);
  }

  const { data: tokenRow, error: tokenErr } = await admin
    .from('flash_platform_tokens')
    .select('expires_at, scopes, updated_at')
    .eq('id', 'singleton')
    .maybeSingle();
  if (tokenErr) {
    console.error('flash-status token lookup error:', tokenErr);
    return jsonResponse({ error: 'Token lookup failed' }, 500, cors);
  }

  if (!tokenRow) {
    return jsonResponse({ connected: false, expiresAt: null, scopes: null }, 200, cors);
  }
  const connected = new Date(tokenRow.expires_at).getTime() > Date.now();
  return jsonResponse({
    connected,
    expiresAt: tokenRow.expires_at,
    scopes: tokenRow.scopes ?? [],
    updatedAt: tokenRow.updated_at,
  }, 200, cors);
});
