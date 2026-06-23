/**
 * Shared rate-limit helper for Edge Functions.
 *
 * Uses the Postgres-backed token bucket created in
 * 20260418000100_rate_limits.sql. Call at the top of an Edge Function
 * after the caller has been identified:
 *
 *     const rl = await rateLimit(admin, {
 *       scope: 'invite-org-member',
 *       subject: caller.id,
 *       maxPerWindow: 10,
 *       windowSeconds: 60,
 *     });
 *     if (!rl.allowed) {
 *       return jsonResponse({ error: 'Rate limit exceeded' }, 429, cors);
 *     }
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

export interface RateLimitArgs {
  scope: string;
  subject: string;
  maxPerWindow: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** True when the DB call itself failed, we fail-open on errors so a
   *  Postgres hiccup doesn't take down the whole Edge Function. The call
   *  is logged for observability. */
  degraded: boolean;
}

export async function rateLimit(
  admin: SupabaseClient,
  args: RateLimitArgs,
): Promise<RateLimitResult> {
  try {
    const { data, error } = await admin.rpc('rate_limit_try', {
      scope_in: args.scope,
      subject_in: args.subject,
      max_per_window: args.maxPerWindow,
      window_seconds: args.windowSeconds,
    });
    if (error) {
      console.error(`[rate-limit] rpc failed for ${args.scope}:`, error);
      return { allowed: true, degraded: true };
    }
    return { allowed: Boolean(data), degraded: false };
  } catch (err) {
    console.error(`[rate-limit] unexpected error for ${args.scope}:`, err);
    return { allowed: true, degraded: true };
  }
}
