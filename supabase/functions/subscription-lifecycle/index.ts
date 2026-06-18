/**
 * subscription-lifecycle — daily cron that advances subscription status
 * based on the lifecycle table:
 *
 *   trialing past trial_ends_at         → past_due (set past_due_since)
 *   active past current_period_end      → past_due (set past_due_since)
 *   past_due  45+ days                  → read_only
 *   read_only 45+ days (= 90 past_due)  → locked (set locked_at)
 *   locked    365+ days                 → deleted (set scheduled_deletion_at)
 *
 * Every transition appends to subscription_lifecycle_events and queues
 * a stubbed email via sendEmail() (see _shared/emails/).
 *
 * Auth: service-role only. The function refuses to run unless the
 * incoming request carries the SERVICE_ROLE key or a known cron secret
 * via the X-Cron-Secret header (env CRON_SECRET).
 *
 * Scheduling — pick ONE of:
 *   1. Supabase pg_cron:
 *        select cron.schedule(
 *          'flash-lifecycle-daily', '17 4 * * *',
 *          $$ select net.http_post(
 *               url    := 'https://<project>.supabase.co/functions/v1/subscription-lifecycle',
 *               headers:= '{"X-Cron-Secret":"<CRON_SECRET>"}'::jsonb
 *             ) $$);
 *   2. External cron (GitHub Actions, Cloudflare cron, etc.):
 *        curl -X POST -H "X-Cron-Secret: <CRON_SECRET>" \
 *             https://<project>.supabase.co/functions/v1/subscription-lifecycle
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse } from '../_shared/http.ts';
import { renderTemplate, type LifecycleTemplateName } from '../_shared/emails/templates.ts';
import { queueLifecycleEmail } from '../_shared/emails/queue.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const DAY_MS = 24 * 3600 * 1000;
const READ_ONLY_AFTER_DAYS = 45;
const LOCKED_AFTER_DAYS = 90;
const DELETED_AFTER_LOCKED_DAYS = 365;

interface Sub {
  id: string;
  status: string;
  trial_ends_at: string | null;
  current_period_end: string | null;
  past_due_since: string | null;
  locked_at: string | null;
  billing_account_id: string;
}

async function recipientFor(billingAccountId: string): Promise<string | null> {
  const { data } = await admin
    .from('billing_accounts')
    .select('owner_user_id')
    .eq('id', billingAccountId)
    .maybeSingle();
  if (!data?.owner_user_id) return null;
  const { data: user } = await admin.auth.admin.getUserById(data.owner_user_id);
  return user?.user?.email ?? null;
}

async function transition(sub: Sub, toStatus: string, reason: string, patch: Record<string, unknown>, email?: LifecycleTemplateName) {
  await admin
    .from('subscriptions')
    .update({ ...patch, status: toStatus, updated_at: new Date().toISOString() })
    .eq('id', sub.id);
  await admin.from('subscription_lifecycle_events').insert({
    subscription_id: sub.id,
    from_status: sub.status,
    to_status: toStatus,
    reason,
  });
  if (email) {
    const to = await recipientFor(sub.billing_account_id);
    if (to) {
      const rendered = renderTemplate(email, { recipientEmail: to });
      await queueLifecycleEmail(to, email, rendered);
    }
  }
}

interface Report {
  scanned: number;
  trialing_to_past_due: number;
  active_to_past_due: number;
  past_due_to_read_only: number;
  read_only_to_locked: number;
  locked_to_deleted: number;
}

async function runOnce(): Promise<Report> {
  const now = Date.now();
  const report: Report = {
    scanned: 0,
    trialing_to_past_due: 0,
    active_to_past_due: 0,
    past_due_to_read_only: 0,
    read_only_to_locked: 0,
    locked_to_deleted: 0,
  };

  const { data: subs, error } = await admin
    .from('subscriptions')
    .select('id, status, trial_ends_at, current_period_end, past_due_since, locked_at, billing_account_id')
    .in('status', ['trialing', 'active', 'past_due', 'read_only', 'locked']);
  if (error) throw error;

  for (const sub of (subs ?? []) as Sub[]) {
    report.scanned++;
    const pastDueSince = sub.past_due_since ? new Date(sub.past_due_since).getTime() : null;
    const lockedAt = sub.locked_at ? new Date(sub.locked_at).getTime() : null;

    if (sub.status === 'trialing' && sub.trial_ends_at && new Date(sub.trial_ends_at).getTime() < now) {
      await transition(sub, 'past_due', 'trial_expired',
        { past_due_since: new Date().toISOString() }, 'trial-expired');
      report.trialing_to_past_due++;
      continue;
    }

    if (sub.status === 'active' && sub.current_period_end && new Date(sub.current_period_end).getTime() < now) {
      await transition(sub, 'past_due', 'period_expired',
        { past_due_since: new Date().toISOString() }, 'payment-due-3d');
      report.active_to_past_due++;
      continue;
    }

    if (sub.status === 'past_due' && pastDueSince !== null
      && now - pastDueSince >= READ_ONLY_AFTER_DAYS * DAY_MS) {
      await transition(sub, 'read_only', 'past_due_45d', {}, 'read-only-notice');
      report.past_due_to_read_only++;
      continue;
    }

    if (sub.status === 'read_only' && pastDueSince !== null
      && now - pastDueSince >= LOCKED_AFTER_DAYS * DAY_MS) {
      await transition(sub, 'locked', 'read_only_45d',
        { locked_at: new Date().toISOString() }, 'locked-notice');
      report.read_only_to_locked++;
      continue;
    }

    if (sub.status === 'locked' && lockedAt !== null
      && now - lockedAt >= DELETED_AFTER_LOCKED_DAYS * DAY_MS) {
      await transition(sub, 'deleted', 'locked_365d',
        { scheduled_deletion_at: new Date().toISOString() }, 'deleted-confirmation');
      report.locked_to_deleted++;
      continue;
    }
  }

  return report;
}

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST' && req.method !== 'GET') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  const cronSecret = Deno.env.get('CRON_SECRET');
  const presentedCron = req.headers.get('X-Cron-Secret');
  const authHeader = req.headers.get('Authorization') ?? '';
  const isServiceCaller = authHeader.toLowerCase().startsWith('bearer ')
    && authHeader.slice(7) === SUPABASE_SERVICE_KEY;
  const isCronCaller = !!cronSecret && presentedCron === cronSecret;
  if (!isServiceCaller && !isCronCaller) {
    return jsonResponse({ error: 'Unauthorized' }, 401, cors);
  }

  try {
    const report = await runOnce();
    return jsonResponse({ ok: true, report }, 200, cors);
  } catch (err) {
    // Full error stays server-side. Don't echo `detail` to the client — it
    // leaks library names + file paths.
    console.error('subscription-lifecycle error:', err);
    return jsonResponse({ error: 'Run failed' }, 500, cors);
  }
});
