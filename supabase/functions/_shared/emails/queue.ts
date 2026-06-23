/**
 * queueLifecycleEmail, write a rendered lifecycle email into the
 * pending_admin_emails outbox so the drain-email-outbox cron can send
 * it via Resend.
 *
 * Kept separate from sendEmail() (which still console-logs) because the
 * lifecycle path is the only caller that needs persistent queueing;
 * everywhere else that calls sendEmail (currently none) should opt in
 * to queueing explicitly.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import type { LifecycleTemplateName, RenderedEmail } from './templates.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

export async function queueLifecycleEmail(
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
    console.error(`[email-queue] failed for template=${template} to=${to}:`, error);
  }
}
