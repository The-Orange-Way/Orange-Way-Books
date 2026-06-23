/**
 * Security-event audit logger for Orange Way Books vaults.
 *
 * Distinct from audit-logger.ts (which tracks business-entity CRUD like
 * transactions and journal entries under org-level RLS). This logger
 * captures user-level vault key-management events, setup, unlock,
 * recover, password change.
 *
 * Events are written to public.vault_security_events with user-scoped
 * RLS. The metadata field is a JSONB blob for low-sensitivity context
 * (key_version, etc.), never put plaintext, PII, or long strings here.
 *
 * All calls are non-fatal: a logging failure is swallowed so that the
 * underlying auth flow never breaks because of an audit write.
 */

import { supabase } from '@/lib/supabase';

export type VaultSecurityEvent =
  | 'vault_setup'
  | 'vault_unlock'
  | 'vault_unlock_failed'
  | 'vault_recover'
  | 'vault_password_changed';

/**
 * Append a vault security event for the given user.
 * Non-fatal, any error is logged to console and swallowed.
 */
export async function logSecurityEvent(
  userId: string,
  event: VaultSecurityEvent,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await (supabase as any)
      .from('vault_security_events')
      .insert({ user_id: userId, event, metadata: metadata ?? null });
    if (error) {
      // Supabase returns HTTP errors in the response object, not as thrown
      // exceptions, so this catch-block-without-check would miss RLS failures.
      console.warn('[VaultSecurityAudit] Insert rejected:', event, error);
    }
  } catch (err) {
    console.warn('[VaultSecurityAudit] Failed to write event:', event, err);
  }
}
