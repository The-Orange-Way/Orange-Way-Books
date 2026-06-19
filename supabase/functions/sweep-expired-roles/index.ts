/**
 * sweep-expired-roles — Supabase Edge Function.
 *
 * Fallback sweep path for Supabase projects where pg_cron is not
 * available. Calls the SQL `expire_time_boxed_roles()` function, which:
 *   - ends every `support_sessions` row whose expires_at has elapsed
 *   - flips revoked_at on every `org_member_roles` row whose expires_at
 *     has elapsed (the Phase 4.2 D9 trigger handles org_keys cleanup)
 *   - writes vault_security_events for both paths
 *
 * Invocation: Supabase scheduled function (every minute). Authenticated
 * via a shared secret header (`x-cron-secret`) matching the
 * `CRON_SWEEP_SECRET` env var — NOT via user JWT.
 *
 * Response (200):
 *   { ok: true, expired_roles: number, expired_sessions: number }
 *
 * If pg_cron IS enabled the database schedules the same function every
 * minute internally; this edge function then behaves as a no-op when
 * there's nothing to sweep, and an at-most-once safety net when the
 * two paths race briefly.
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse } from '../_shared/http.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const CRON_SWEEP_SECRET = Deno.env.get('CRON_SWEEP_SECRET') ?? '';

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

serve(async (req) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  try {
    // Shared-secret auth. Supabase scheduled functions can attach custom
    // headers; we refuse every request whose x-cron-secret does not match
    // the configured env var. Unconfigured secret = refuse everything.
    const provided = req.headers.get('x-cron-secret') ?? '';
    if (!CRON_SWEEP_SECRET || provided !== CRON_SWEEP_SECRET) {
      return jsonResponse({ error: 'Forbidden' }, 403, cors);
    }

    const { data, error } = await adminClient.rpc('expire_time_boxed_roles');
    if (error) {
      console.error('sweep-expired-roles rpc failed:', error);
      return jsonResponse({ error: 'Sweep failed' }, 500, cors);
    }

    // The function RETURNS TABLE — Supabase surfaces that as an array.
    const first = Array.isArray(data) ? data[0] : data;
    const expiredRoles = Number((first as { expired_roles?: unknown })?.expired_roles ?? 0);
    const expiredSessions = Number((first as { expired_sessions?: unknown })?.expired_sessions ?? 0);

    return jsonResponse({
      ok: true,
      expired_roles: expiredRoles,
      expired_sessions: expiredSessions,
    }, 200, cors);
  } catch (err) {
    console.error('sweep-expired-roles error:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});
