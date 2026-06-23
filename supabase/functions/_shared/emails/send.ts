/**
 * sendEmail, queues a rendered lifecycle email into pending_admin_emails.
 *
 * The same outbox table that queue-admin-email writes to. An external
 * sender daemon (Resend / Supabase SMTP) drains rows where status='pending'
 * and updates them to 'sent' / 'failed' once delivered. Daemon wiring is
 * tracked in the Pay with Flash design doc under "Email delivery".
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { LifecycleTemplateName, RenderedEmail } from './templates.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export async function sendEmail(
  to: string,
  template: LifecycleTemplateName,
  rendered: RenderedEmail,
): Promise<void> {
  const { error } = await admin.from('pending_admin_emails').insert({
    to_email: to,
    subject: rendered.subject,
    body_text: rendered.text,
    body_html: rendered.html,
    status: 'pending',
  });
  if (error) {
    console.error(`[email-queue] failed to enqueue template=${template} to=${to}:`, error);
  }
}
