/**
 * send-invoice-email — sends a transactional invoice email via Resend.
 *
 * ZKA boundary: the client composes the full email body (subject + text +
 * HTML) from the decrypted invoice payload and the share URL. The server
 * never reads ciphertext. The plaintext lives in memory only for the
 * duration of the Resend API call; the only thing we persist is a
 * vault_security_events audit row keyed by invoice_id + recipient email +
 * Resend message id. The share URL (which contains the decryption key in
 * its fragment) is NOT persisted server-side.
 *
 * Auth: caller must have SELECT access to `invoices.id = invoice_id`
 * under their own JWT. RLS is the gate. If the SELECT returns no row,
 * the caller is not authorized.
 *
 * Request body:
 *   {
 *     "invoice_id": "<uuid>",
 *     "to":         "customer@example.com",
 *     "subject":    "Invoice INV-007 from Acme Corp",
 *     "body_text":  "Hi Jane, ...",
 *     "body_html":  "<p>Hi Jane, ...</p>",   // optional
 *     "reply_to":   "owner@acme.com"          // optional, defaults to caller's email
 *   }
 *
 * Response: { sent: true, resend_message_id: "..." }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { rateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM = Deno.env.get('RESEND_FROM') ?? 'Orange Way Books <support@orangeway.app>';

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_EMAIL_LEN = 320;
const MAX_SUBJECT_LEN = 300;
const MAX_BODY_LEN = 64 * 1024;

serve(async (req) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    if (!RESEND_API_KEY) {
      return jsonResponse(
        { error: 'Email sending is not configured. Contact support.' },
        503, cors,
      );
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

    // Conservative rate limit. Invoice sending is interactive — 20 per
    // 5 min per user is enough for batch sends without enabling abuse.
    const rl = await rateLimit(adminClient, {
      scope: 'send-invoice-email',
      subject: caller.id,
      maxPerWindow: 20,
      windowSeconds: 300,
    });
    if (!rl.allowed) {
      return jsonResponse({ error: 'Rate limit exceeded; try again shortly' }, 429, cors);
    }

    const raw = await readBoundedText(req);
    if (raw === null) {
      return jsonResponse({ error: 'Request body too large' }, 413, cors);
    }
    let body: {
      invoice_id?: unknown; to?: unknown; subject?: unknown;
      body_text?: unknown; body_html?: unknown; reply_to?: unknown;
    };
    try { body = JSON.parse(raw | '{}'); } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
    }

    const invoiceId = typeof body.invoice_id === 'string' ? body.invoice_id.trim() : '';
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
    const bodyText = typeof body.body_text === 'string' ? body.body_text : '';
    const bodyHtml = typeof body.body_html === 'string' ? body.body_html : '';
    const replyTo = typeof body.reply_to === 'string' ? body.reply_to.trim() : '';

    if (!invoiceId || !UUID_RE.test(invoiceId)) {
      return jsonResponse({ error: 'invoice_id is required' }, 400, cors);
    }
    if (!to || to.length > MAX_EMAIL_LEN || !EMAIL_RE.test(to)) {
      return jsonResponse({ error: 'to is not a valid email' }, 400, cors);
    }
    // Per-invoice cap on top of the per-user rate limit above. A
    // compromised user could otherwise mail-bomb 20 different external
    // addresses every 5 min — this caps each invoice to 5 sends per 24h.
    // (M7 — 2026-05-19 audit.)
    const perInvoice = await rateLimit(adminClient, {
      scope: 'send-invoice-email-by-invoice',
      subject: invoiceId,
      maxPerWindow: 5,
      windowSeconds: 24 * 3600,
    });
    if (!perInvoice.allowed) {
      return jsonResponse({ error: 'Per-invoice send limit reached (5 / 24h)' }, 429, cors);
    }
    if (!subject || subject.length > MAX_SUBJECT_LEN) {
      return jsonResponse({ error: 'subject is required (<=300 chars)' }, 400, cors);
    }
    if (!bodyText || bodyText.length > MAX_BODY_LEN) {
      return jsonResponse({ error: 'body_text is required (<=64KB)' }, 400, cors);
    }
    if (bodyHtml.length > MAX_BODY_LEN) {
      return jsonResponse({ error: 'body_html exceeds 64KB' }, 400, cors);
    }
    if (replyTo && (replyTo.length > MAX_EMAIL_LEN || !EMAIL_RE.test(replyTo))) {
      return jsonResponse({ error: 'reply_to is not a valid email' }, 400, cors);
    }

    // Auth gate: RLS check by selecting the invoice via the caller's JWT.
    // If the invoice isn't visible to the caller, RLS returns no row and
    // we reject. We also pull the invoice_number for the audit row.
    const { data: invRow, error: invErr } = await callerClient
      .from('invoices')
      .select('id, org_id, invoice_number, status')
      .eq('id', invoiceId)
      .maybeSingle();
    if (invErr) {
      console.error('send-invoice-email select failed:', invErr);
      return jsonResponse({ error: 'Failed to load invoice' }, 500, cors);
    }
    if (!invRow) {
      return jsonResponse({ error: 'Invoice not found or not accessible' }, 404, cors);
    }

    // Call Resend. We use the HTTP API directly — no SDK, no extra
    // bundle weight. Failure surfaces as { error: ... } to the UI so
    // the operator can fix the address and retry.
    const resendBody: Record<string, unknown> = {
      from: RESEND_FROM,
      to: [to],
      subject,
      text: bodyText,
    };
    if (bodyHtml) resendBody.html = bodyHtml;
    if (replyTo) resendBody.reply_to = replyTo;
    else if (caller.email) resendBody.reply_to = caller.email;

    const resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(resendBody),
    });
    const resendJson: { id?: string; message?: string; name?: string } =
      await resendResp.json().catch(() => ({}));

    if (!resendResp.ok || !resendJson.id) {
      console.error('Resend send failed', resendResp.status, resendJson);
      const msg = resendJson.message | 'Resend rejected the send';
      return jsonResponse({ error: msg }, 502, cors);
    }

    // Audit. Metadata only — no email body, no share URL. Non-fatal.
    try {
      await adminClient.from('vault_security_events').insert({
        user_id: caller.id,
        event: 'invoice.email_sent',
        metadata: {
          invoice_id: invoiceId,
          invoice_number: (invRow as { invoice_number?: string }).invoice_number,
          org_id: (invRow as { org_id?: string }).org_id,
          to_email: to,
          resend_message_id: resendJson.id,
        },
      });
    } catch (auditErr) {
      console.warn('send-invoice-email audit insert failed (non-fatal):', auditErr);
    }

    return jsonResponse({ sent: true, resend_message_id: resendJson.id }, 200, cors);
  } catch (err) {
    console.error('send-invoice-email error:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});
