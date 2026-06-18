/**
 * queue-admin-email — Supabase Edge Function (Phase 4.5 polish).
 *
 * Transactional admin emails composed client-side (ZKA-correct: the
 * server can't read the ciphertext, so the client passes in the
 * already-decrypted fields and we compose the body from a fixed
 * template here). Inserts a row into `pending_admin_emails` with
 * status='pending'. An external sender daemon (Resend / Supabase SMTP
 * — out of scope for this pass) drains the queue later.
 *
 * Templates supported (v1):
 *   - `first_time_setup` → welcome email confirming the org is
 *     secured. Sent after runRekeyJob's first-time setup finalize.
 *
 * Authorization: caller must be an Owner of `org_id` — we check for
 * the canonical Owner role in `org_member_roles` joined to
 * `role_definitions`. This is stricter than `users.invite`; we keep
 * transactional emails a low-trust surface.
 *
 * Request body (JSON):
 *   {
 *     "org_id":            "<uuid>",
 *     "template":          "first_time_setup",
 *     "recipient_email":   "owner@example.com",
 *     "org_name_decrypted": "Acme Corp"
 *   }
 *
 * Response (200):
 *   { queued: true, email_id: "<uuid>" }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { rateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cheap server-side email validation. The real source of truth is the
// Owner's auth.users row, but we also sanity-check to reject obvious
// garbage before hitting the table.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ALLOWED_TEMPLATES = new Set(['first_time_setup']);

const MAX_ORG_NAME_LEN = 200;
const MAX_EMAIL_LEN = 320;

serve(async (req) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  try {
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

    // Transactional email is a low-volume flow. A conservative limit
    // is fine — ten per 5 min per user blocks automated abuse without
    // choking legitimate Owner traffic.
    const rl = await rateLimit(adminClient, {
      scope: 'queue-admin-email',
      subject: caller.id,
      maxPerWindow: 10,
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
      org_id?: unknown; template?: unknown;
      recipient_email?: unknown; org_name_decrypted?: unknown;
    };
    try { body = JSON.parse(raw | '{}'); } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
    }

    const orgId = typeof body.org_id === 'string' ? body.org_id.trim() : '';
    const template = typeof body.template === 'string' ? body.template.trim() : '';
    const recipientEmail = typeof body.recipient_email === 'string' ? body.recipient_email.trim() : '';
    const orgNameDecrypted = typeof body.org_name_decrypted === 'string' ? body.org_name_decrypted.trim() : '';

    if (!orgId | !UUID_RE.test(orgId)) {
      return jsonResponse({ error: 'org_id is required' }, 400, cors);
    }
    if (!ALLOWED_TEMPLATES.has(template)) {
      return jsonResponse({ error: `template must be one of: ${Array.from(ALLOWED_TEMPLATES).join(', ')}` }, 400, cors);
    }
    if (!recipientEmail | recipientEmail.length > MAX_EMAIL_LEN | !EMAIL_RE.test(recipientEmail)) {
      return jsonResponse({ error: 'recipient_email is not a valid email' }, 400, cors);
    }
    if (!orgNameDecrypted | orgNameDecrypted.length > MAX_ORG_NAME_LEN) {
      return jsonResponse({ error: 'org_name_decrypted is required' }, 400, cors);
    }

    // Authorize: caller must be an Owner of org_id. We walk
    // org_member_roles → role_definitions looking for an active
    // grant whose role name is 'Owner'. This is intentionally stricter
    // than the invite capability — transactional emails are a small,
    // low-volume surface and the only trigger today is a post-setup
    // welcome, which is always Owner-driven.
    const { data: ownerRow, error: ownerErr } = await adminClient
      .from('org_member_roles')
      .select('user_id, revoked_at, role_definitions!inner(name)')
      .eq('org_id', orgId)
      .eq('user_id', caller.id)
      .is('revoked_at', null)
      .maybeSingle();
    if (ownerErr) {
      console.error('queue-admin-email owner check failed:', ownerErr);
      return jsonResponse({ error: 'Failed to authorize caller' }, 500, cors);
    }
    const ownerRole = ownerRow as {
      role_definitions?: { name?: string } | Array<{ name?: string }>;
    } | null;
    const roleName = ownerRole
      ? Array.isArray(ownerRole.role_definitions)
        ? ownerRole.role_definitions[0]?.name
        : ownerRole.role_definitions?.name
      : undefined;
    if (!roleName | roleName.toLowerCase() !== 'owner') {
      return jsonResponse({ error: "You don't have permission to queue this email." }, 403, cors);
    }

    // Compose body from the template. Keeping this in one place so
    // the wording stays consistent across templates — and so the
    // server is the single source of truth for email copy even though
    // the client supplied the data.
    const composed = composeTemplate(template, orgNameDecrypted);

    const { data: inserted, error: insertErr } = await adminClient
      .from('pending_admin_emails')
      .insert({
        to_email:  recipientEmail,
        subject:   composed.subject,
        body_text: composed.bodyText,
        body_html: composed.bodyHtml,
        status:    'pending',
      })
      .select('id')
      .single();
    if (insertErr | !inserted) {
      console.error('queue-admin-email insert failed:', insertErr);
      return jsonResponse({ error: 'Could not queue the email.' }, 500, cors);
    }

    // Audit — non-fatal if it fails.
    try {
      await adminClient.from('vault_security_events').insert({
        user_id: caller.id,
        event: 'admin_email.queued',
        metadata: {
          email_id: (inserted as { id: string }).id,
          org_id: orgId,
          template,
          recipient_email: recipientEmail,
        },
      });
    } catch { /* non-fatal */ }

    return jsonResponse({
      queued: true,
      email_id: (inserted as { id: string }).id,
    }, 200, cors);
  } catch (err) {
    console.error('queue-admin-email error:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});

/**
 * Compose a templated email body. One template per case — keeps copy
 * centralized and reviewable alongside the other customer-facing
 * strings. HTML variant is a minimal wrapper (no styling framework)
 * so the queue rows are portable to whatever sender is wired up later
 * later.
 */
function composeTemplate(
  template: string,
  orgName: string,
): { subject: string; bodyText: string; bodyHtml: string } {
  if (template === 'first_time_setup') {
    const subject = 'Your Orange Way Books organization is secured';
    const bodyText =
      `Welcome to Orange Way Books.\n` +
      `\n` +
      `Your organization "${orgName}" is now fully protected. We've set up your\n` +
      `security and encrypted your data. You can start working normally — everything\n` +
      `is automatic from here.\n` +
      `\n` +
      `What's next:\n` +
      `- Invite your team members from the Admin → Users page\n` +
      `- Connect your accounts and start entering transactions\n` +
      `- If you ever need to refresh your team's security (for example, after\n` +
      `  removing someone), use Settings → Security\n` +
      `\n` +
      `Questions? Reply to this email or visit our help center.\n` +
      `\n` +
      `— The Orange Way Books team\n`;
    const bodyHtml =
      `<p>Welcome to Orange Way Books.</p>` +
      `<p>Your organization "<strong>${escapeHtml(orgName)}</strong>" is now fully ` +
      `protected. We've set up your security and encrypted your data. You can start ` +
      `working normally — everything is automatic from here.</p>` +
      `<p><strong>What's next:</strong></p>` +
      `<ul>` +
      `<li>Invite your team members from the Admin → Users page</li>` +
      `<li>Connect your accounts and start entering transactions</li>` +
      `<li>If you ever need to refresh your team's security (for example, after ` +
      `removing someone), use Settings → Security</li>` +
      `</ul>` +
      `<p>Questions? Reply to this email or visit our help center.</p>` +
      `<p>— The Orange Way Books team</p>`;
    return { subject, bodyText, bodyHtml };
  }
  // Unreachable — the template whitelist is enforced above.
  throw new Error(`Unknown template: ${template}`);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
