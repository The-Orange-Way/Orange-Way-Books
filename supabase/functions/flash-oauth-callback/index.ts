/**
 * flash-oauth-callback, Supabase Edge Function
 *
 * Completes the Flash Connect OAuth handshake for the Orange Way Books platform
 * connection. The frontend (/admin/flash/callback) POSTs { code, state }
 * after Flash redirects the user back. This function:
 *
 *   1. Validates the caller has a Supabase session and is OWNER on at
 *      least one org (basic gate, the actual single-merchant model
 *      means only an authorized operator should ever reach this in production).
 *   2. Looks up state in flash_oauth_state, single-use (deleted on read),
 *      not expired.
 *   3. Exchanges the authorization code at Flash /oauth/token (or
 *      returns mock tokens when MOCK_FLASH=true, Flash hasn't shipped
 *      the base URL yet, so the rest of the flow can be wired up
 *      end-to-end against the mock).
 *   4. Upserts the singleton flash_platform_tokens row with the new
 *      access_token / refresh_token / expires_at / scopes.
 *
 * Env vars:
 *   FLASH_OAUTH_TOKEN_URL , full URL to Flash /oauth/token. Required
 *                            unless MOCK_FLASH=true.
 *   FLASH_CLIENT_ID       , confidential client id
 *   FLASH_CLIENT_SECRET   , confidential client secret
 *   FLASH_REDIRECT_URI    , the redirect URI registered with Flash
 *                            (must match the one used by the browser)
 *   MOCK_FLASH            , when 'true', returns deterministic fake
 *                            tokens without calling Flash. Dev only.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const adminSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface FlashTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

async function exchangeCodeMock(): Promise<FlashTokenResponse> {
  // Deterministic enough for local testing; expires in 1 hour so the
  // refresh flow can be exercised.
  return {
    access_token: 'mock-access-' + crypto.randomUUID(),
    refresh_token: 'mock-refresh-' + crypto.randomUUID(),
    expires_in: 3600,
    scope: 'read_write',
  };
}

async function exchangeCodeReal(code: string): Promise<FlashTokenResponse> {
  const tokenUrl = Deno.env.get('FLASH_OAUTH_TOKEN_URL');
  const clientId = Deno.env.get('FLASH_CLIENT_ID');
  const clientSecret = Deno.env.get('FLASH_CLIENT_SECRET');
  const redirectUri = Deno.env.get('FLASH_REDIRECT_URI');
  if (!tokenUrl || !clientId || !clientSecret || !redirectUri) {
    throw new Error('Flash OAuth env vars are not fully configured');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Flash token exchange failed: ${res.status} ${detail.slice(0, 400)}`);
  }
  return (await res.json()) as FlashTokenResponse;
}

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  // 1) Authenticate the caller.
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

  // 2) Parse + validate body.
  const rawBody = await readBoundedText(req);
  if (rawBody === null) {
    return jsonResponse({ error: 'Request body too large' }, 413, cors);
  }
  let parsed: { code?: string; state?: string };
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: 'Body must be JSON' }, 400, cors);
  }
  const code = typeof parsed.code === 'string' ? parsed.code : '';
  const state = typeof parsed.state === 'string' ? parsed.state : '';
  if (!code || !state) {
    return jsonResponse({ error: 'Missing code or state' }, 400, cors);
  }

  // 3) Validate state: must exist, not be expired, and belong to the
  // same user that initiated the flow. Single-use: delete after lookup.
  const { data: stateRow, error: stateErr } = await adminSupabase
    .from('flash_oauth_state')
    .select('state, purpose, user_id, expires_at')
    .eq('state', state)
    .maybeSingle();
  if (stateErr) {
    console.error('flash-oauth-callback state lookup error:', stateErr);
    return jsonResponse({ error: 'State lookup failed' }, 500, cors);
  }
  if (!stateRow) {
    return jsonResponse({ error: 'Invalid or expired state' }, 400, cors);
  }
  if (new Date(stateRow.expires_at).getTime() < Date.now()) {
    await adminSupabase.from('flash_oauth_state').delete().eq('state', state);
    return jsonResponse({ error: 'Invalid or expired state' }, 400, cors);
  }
  if (stateRow.user_id && stateRow.user_id !== caller.id) {
    return jsonResponse({ error: 'State does not belong to caller' }, 403, cors);
  }
  // Single-use: delete now to prevent replay even if the exchange below fails.
  await adminSupabase.from('flash_oauth_state').delete().eq('state', state);

  // 4) Exchange the code for tokens.
  let tokens: FlashTokenResponse;
  const mock = (Deno.env.get('MOCK_FLASH') ?? '').toLowerCase() === 'true';
  try {
    tokens = mock ? await exchangeCodeMock() : await exchangeCodeReal(code);
  } catch (err) {
    console.error('flash-oauth-callback exchange error:', err);
    return jsonResponse({ error: 'Token exchange failed' }, 502, cors);
  }

  // 5) Persist tokens as the singleton platform-token row.
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
  const scopes = (tokens.scope ?? 'read_write').split(/\s+/).filter(Boolean);

  const { error: upsertErr } = await adminSupabase.from('flash_platform_tokens').upsert({
    id: 'singleton',
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: expiresAt,
    scopes,
    updated_at: new Date().toISOString(),
  });
  if (upsertErr) {
    console.error('flash-oauth-callback token upsert error:', upsertErr);
    return jsonResponse({ error: 'Failed to store tokens' }, 500, cors);
  }

  console.log(`flash-oauth-callback ok mock=${mock} caller=${caller.id} expires_at=${expiresAt}`);
  return jsonResponse({ ok: true, expires_at: expiresAt, scopes, mock }, 200, cors);
});
