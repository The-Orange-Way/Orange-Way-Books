/**
 * drain-email-outbox, sends queued lifecycle + admin emails via Resend.
 *
 * Polls `pending_admin_emails` for `status='pending'` rows, sends each
 * through Resend, and updates the row to 'sent' (with sent_at) or
 * 'failed'. Designed to be invoked by pg_cron every minute:
 *
 *   select cron.schedule(
 *     'drain-email-outbox', '* * * * *',
 *     $$ select net.http_post(
 *          url    := 'https://<project>.supabase.co/functions/v1/drain-email-outbox',
 *          headers:= '{"X-Cron-Secret":"<CRON_SECRET>"}'::jsonb
 *        ) $$);
 *
 * Auth: requires X-Cron-Secret matching env CRON_SECRET, OR a service-role
 * bearer token. Anonymous calls are rejected so a leaked URL can't drain
 * the queue from outside.
 *
 * Env:
 *   RESEND_API_KEY   , Resend secret key (re_xxx)
 *   RESEND_FROM      , sender, e.g. 'Orange Way Books <support@orangeway.app>'
 *   CRON_SECRET      , shared secret for pg_cron / external schedulers
 *   DRAIN_BATCH_SIZE , optional, default 25 per run
 *
 * Notes:
 * - Resend's free tier is 100/day, paid is 50/sec. A batch of 25 keeps us
 *   under both. Failures don't block the rest of the batch.
 * - We do NOT retry inside this function. Failed rows stay 'failed' for
 *   a human to inspect, automatic retry is a follow-up.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse } from '../_shared/http.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM = Deno.env.get('RESEND_FROM') ?? 'Orange Way Books <support@orangeway.app>';
const CRON_SECRET = Deno.env.get('CRON_SECRET') ?? '';
const BATCH_SIZE = Math.max(1, Math.min(100, Number(Deno.env.get('DRAIN_BATCH_SIZE') ?? '25')));

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

interface OutboxRow {
  id: string;
  to_email: string;
  subject: string;
  body_text: string;
  body_html: string | null;
}

interface Report {
  scanned: number;
  sent: number;
  failed: number;
  errors: string[];
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(req: Request): boolean {
  const cronHeader = req.headers.get('X-Cron-Secret');
  if (CRON_SECRET && cronHeader && constantTimeEqual(cronHeader, CRON_SECRET)) return true;
  const auth = req.headers.get('Authorization') ?? '';
  if (auth.startsWith('Bearer ') && constantTimeEqual(auth.slice(7), SUPABASE_SERVICE_KEY)) {
    return true;
  }
  return false;
}

async function resendSend(
  to: string,
  subject: string,
  text: string,
  html: string | null,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const body: Record<string, unknown> = {
    from: RESEND_FROM,
    to: [to],
    subject,
    text,
  };
  if (html) body.html = html;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => 'unknown');
    return { ok: false, error: `resend ${r.status}: ${errText.slice(0, 300)}` };
  }
  const data = await r.json().catch(() => ({}));
  return { ok: true, id: data?.id ?? '' };
}

async function drain(): Promise<Report> {
  const report: Report = { scanned: 0, sent: 0, failed: 0, errors: [] };

  if (!RESEND_API_KEY) {
    report.errors.push('RESEND_API_KEY not set; refusing to drain.');
    return report;
  }

  const { data: rows, error } = await admin
    .from('pending_admin_emails')
    .select('id, to_email, subject, body_text, body_html')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(BATCH_SIZE);
  if (error) throw error;

  for (const row of (rows ?? []) as OutboxRow[]) {
    report.scanned++;
    const result = await resendSend(row.to_email, row.subject, row.body_text, row.body_html);
    if (result.ok) {
      await admin
        .from('pending_admin_emails')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', row.id);
      report.sent++;
    } else {
      await admin.from('pending_admin_emails').update({ status: 'failed' }).eq('id', row.id);
      report.failed++;
      report.errors.push(`${row.id}: ${result.error}`);
    }
  }

  return report;
}

Deno.serve(async (req: Request) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  if (!authorized(req)) return jsonResponse({ error: 'Unauthorized' }, 401, cors);

  try {
    const report = await drain();
    return jsonResponse({ ok: true, ...report }, 200, cors);
  } catch (err) {
    // Full error stays server-side. Don't echo `detail` to the client, it
    // leaks library names + file paths.
    console.error('drain-email-outbox error:', err);
    return jsonResponse({ error: 'Drain failed' }, 500, cors);
  }
});
