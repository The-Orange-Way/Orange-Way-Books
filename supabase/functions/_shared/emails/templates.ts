/**
 * Billing-lifecycle email templates.
 *
 * TODO: actual email delivery. queue-admin-email writes rows into a
 * `pending_admin_emails` table for an external sender daemon to drain.
 * Wave 1 of Flash uses the same model for lifecycle emails but the
 * sender daemon (Resend / Supabase SMTP) is not yet wired up — see
 * sendEmail() in this folder for the stub.
 */

export type LifecycleTemplateName =
  | 'trial-ending-7d'
  | 'trial-ending-1d'
  | 'trial-expired'
  | 'payment-due-3d'
  | 'payment-due-7d'
  | 'payment-due-14d'
  | 'payment-due-30d-warning'
  | 'read-only-notice'
  | 'locked-notice'
  | 'pre-delete-warning-30d'
  | 'deleted-confirmation';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface RenderContext {
  recipientEmail: string;
  recipientName?: string;
  amountFormatted?: string;
  daysRemaining?: number;
  payUrl?: string;
}

const LEGAL_FOOTER_TEXT =
  '\n\n--\nThe Orange Way Inc, 620 Veterans Drive Suite 12, Barrie, ON L4N9J4, Canada\nhello@orangeway.app';
const LEGAL_FOOTER_HTML =
  '<p style="color:#64748b;font-size:12px">The Orange Way Inc, 620 Veterans Drive Suite 12, Barrie, ON L4N9J4, Canada<br>hello@orangeway.app</p>';

function wrap(subject: string, body: string): RenderedEmail {
  const html = `<!doctype html><html><body style="font:14px/1.5 system-ui,sans-serif;color:#0f172a"><p>${body.replace(/\n\n/g, '</p><p>')}</p>${LEGAL_FOOTER_HTML}</body></html>`;
  return { subject, html, text: body + LEGAL_FOOTER_TEXT };
}

export function renderTemplate(name: LifecycleTemplateName, ctx: RenderContext): RenderedEmail {
  const payUrl = ctx.payUrl ?? 'https://books.orangeway.app/app/billing';
  const amount = ctx.amountFormatted ?? '$30';
  const greeting = ctx.recipientName ? `Hi ${ctx.recipientName},` : 'Hi there,';

  switch (name) {
    case 'trial-ending-7d':
      return wrap(
        'Your Orange Way Books trial ends in 7 days',
        `${greeting}\n\nYour 45-day Orange Way Books trial ends in 7 days. Pay ${amount} when you're ready to keep going: ${payUrl}\n\nThanks for trying Vault.`,
      );
    case 'trial-ending-1d':
      return wrap(
        'Your Orange Way Books trial ends tomorrow',
        `${greeting}\n\nYour trial ends tomorrow. Pay ${amount} here to avoid interruption: ${payUrl}`,
      );
    case 'trial-expired':
      return wrap(
        'Your Orange Way Books trial has ended',
        `${greeting}\n\nYour trial has ended. Pay ${amount} to continue using Vault: ${payUrl}\n\nYour data is safe — nothing is deleted while you decide.`,
      );
    case 'payment-due-3d':
      return wrap(
        'Reminder: Orange Way Books payment due',
        `${greeting}\n\nIt's been 3 days since your subscription went past due. Pay ${amount} to restore access: ${payUrl}`,
      );
    case 'payment-due-7d':
      return wrap(
        'Orange Way Books payment still due',
        `${greeting}\n\nWe haven't received payment. Pay ${amount} here: ${payUrl}`,
      );
    case 'payment-due-14d':
      return wrap(
        'Final reminder before read-only mode (in 31 days)',
        `${greeting}\n\nIn 31 days your workspace will switch to read-only. Pay ${amount} now to keep things normal: ${payUrl}`,
      );
    case 'payment-due-30d-warning':
      return wrap(
        'Heads up: 15 days until read-only',
        `${greeting}\n\nIn 15 days your Orange Way Books will go into read-only mode. Your data stays safe; you just won't be able to write to it. Pay ${amount}: ${payUrl}`,
      );
    case 'read-only-notice':
      return wrap(
        'Orange Way Books is now read-only',
        `${greeting}\n\nYour workspace is now read-only after 45 days unpaid. Export still works. Pay ${amount} any time to unlock: ${payUrl}\n\nYour data is safe.`,
      );
    case 'locked-notice':
      return wrap(
        'Orange Way Books is locked',
        `${greeting}\n\nYour account is locked after 90 days unpaid. Login still works but Vault renders a payment screen only. Pay ${amount} to restore access: ${payUrl}\n\nData stays on our servers for another 365 days.`,
      );
    case 'pre-delete-warning-30d':
      return wrap(
        'Final warning: Orange Way Books data will be deleted in 30 days',
        `${greeting}\n\nYour locked workspace will be permanently deleted in 30 days. Pay ${amount} to restore everything: ${payUrl}\n\nAfter deletion, restoration is not possible.`,
      );
    case 'deleted-confirmation':
      return wrap(
        'Your Orange Way Books data has been deleted',
        `${greeting}\n\nAs scheduled, your Orange Way Books data has been deleted after 365 days locked. We're sorry to see you go. If you'd like to start fresh: https://books.orangeway.app/signup`,
      );
    default:
      return wrap('Orange Way Books notice', `${greeting}\n\nUpdate on your subscription.`);
  }
}
