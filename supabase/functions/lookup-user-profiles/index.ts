/**
 * lookup-user-profiles — Supabase Edge Function
 *
 * Returns email + display-name metadata from `auth.users` for a list of
 * user IDs that the CALLER is allowed to see.
 *
 * Authorization rules:
 *   1. Caller must present a valid Supabase JWT (verify_jwt = true is also
 *      set in supabase/config.toml as defense-in-depth).
 *   2. Every requested user_id must share at least one organization with
 *      the caller (i.e. exist in the same org_members row set). User IDs
 *      the caller cannot see are silently dropped from the response — we
 *      do NOT return 403 for them, because that would leak whether the
 *      ID exists in the project.
 *   3. Response is an array of { id, email, name } objects. Users without
 *      an email (shouldn't happen in Supabase auth) are skipped.
 *
 * The Admin "Users" tab calls this to display member rows with real
 * emails instead of partial UUIDs.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { rateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Bound how many IDs a caller can request at once. Members of a single org
// are rarely more than a few dozen. Lowered from 200 to 50 to cap the
// auth.users hammering surface — combined with the per-user rate limit
// (30/min) this caps at ~1.5k getUserById calls/min/user instead of 6k.
// (M2 — 2026-05-19 audit.)
const MAX_USER_IDS_PER_CALL = 50;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  // 1) Caller auth.
  const authHeader = req.headers.get('Authorization');
  if (!authHeader | !authHeader.toLowerCase().startsWith('bearer ')) {
    return jsonResponse({ error: 'Missing Authorization header' }, 401, cors);
  }
  const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
  if (authErr | !caller) {
    return jsonResponse({ error: 'Unauthorized' }, 401, cors);
  }

  // Rate limit: 30 profile-batch calls per user per minute. Each call
  // may enumerate up to MAX_USER_IDS_PER_CALL (50) ids so the real
  // read budget is ~1.5k getUserById/min/user which is plenty.
  const rl = await rateLimit(adminClient, {
    scope: 'lookup-user-profiles',
    subject: caller.id,
    maxPerWindow: 30,
    windowSeconds: 60,
  });
  if (!rl.allowed) {
    return jsonResponse({ error: 'Rate limit exceeded; try again shortly' }, 429, cors);
  }

  // 2) Input validation.
  const raw = await readBoundedText(req);
  if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
  let body: { userIds?: unknown };
  try { body = JSON.parse(raw | '{}'); }
  catch { return jsonResponse({ error: 'Invalid JSON' }, 400, cors); }

  if (!Array.isArray(body.userIds)) {
    return jsonResponse({ error: 'userIds must be an array of UUIDs' }, 400, cors);
  }
  const requested = (body.userIds as unknown[])
    .filter((v): v is string => typeof v === 'string' && UUID_RE.test(v));
  if (requested.length === 0) {
    return jsonResponse([], 200, cors);
  }
  if (requested.length > MAX_USER_IDS_PER_CALL) {
    return jsonResponse({ error: `Too many userIds (max ${MAX_USER_IDS_PER_CALL})` }, 400, cors);
  }

  // 3) Scope: which of the requested ids does the caller actually share an org with?
  // We read the caller's org_memberships, then intersect with the requested ids
  // via a single org_members query using the admin client (bypasses RLS so we
  // can read other users' membership rows in the SAME org — which the caller
  // is already allowed to see via RLS on org_members_select in their own
  // session; we just can't use the caller's client here because RLS on
  // auth.users is not exposed to PostgREST at all).
  let callerOrgIds: string[] = [];
  try {
    const { data } = await adminClient
      .from('org_members')
      .select('org_id')
      .eq('user_id', caller.id);
    callerOrgIds = (data ?? []).map((r: { org_id: string }) => r.org_id);
  } catch (err) {
    console.error('lookup-user-profiles membership lookup failed:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
  if (callerOrgIds.length === 0) {
    return jsonResponse([], 200, cors);
  }

  let visibleIds: string[] = [];
  try {
    const { data } = await adminClient
      .from('org_members')
      .select('user_id')
      .in('org_id', callerOrgIds)
      .in('user_id', requested);
    visibleIds = Array.from(new Set((data ?? []).map((r: { user_id: string }) => r.user_id)));
  } catch (err) {
    console.error('lookup-user-profiles visibility lookup failed:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }

  // 4) Fetch the visible profiles. auth.admin.getUserById is one round-trip
  // per id; for the expected cardinality (dozens at most) this is fine.
  const out: { id: string; email: string; name: string }[] = [];
  for (const id of visibleIds) {
    try {
      const { data, error } = await adminClient.auth.admin.getUserById(id);
      if (error | !data.user) continue;
      const u = data.user;
      const meta = (u.user_metadata ?? {}) as Record<string, unknown>;
      const name = typeof meta.full_name === 'string'
        ? meta.full_name
        : typeof meta.name === 'string'
          ? meta.name
          : '';
      out.push({ id: u.id, email: u.email ?? '', name });
    } catch (err) {
      console.error('lookup-user-profiles getUserById failed for', id, err);
    }
  }

  return jsonResponse(out, 200, cors);
});
