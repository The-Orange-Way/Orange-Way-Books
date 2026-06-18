/**
 * Client-side audit logger — writes encrypted audit entries to Supabase.
 * All summary/snapshot fields are encrypted via VaultContext (ZKA L2).
 */
import { supabase } from '@/lib/supabase';
import { encryptAuditLog } from '@/lib/crypto-fields';

type EncryptFn = (plaintext: string) => Promise<string>;

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE' | 'ARCHIVE' | 'UNARCHIVE' | 'POST' | 'VOID' | 'RECONCILE';

export type AuditEntityType =
  | 'organization' | 'wallet' | 'transaction' | 'journal_entry'
  | 'contact' | 'payment_request' | 'chart_of_account'
  | 'connector' | 'org_settings' | 'member';

export interface WriteAuditLogArgs {
  orgId: string;
  action: AuditAction;
  entityType: AuditEntityType;
  entityId: string;
  summary?: string;
  before?: unknown;
  after?: unknown;
  encrypt: EncryptFn;
}

/**
 * Write an audit log entry. Fire-and-forget — errors are logged but don't block.
 */
export async function writeAuditLog({
  orgId, action, entityType, entityId, summary, before, after, encrypt,
}: WriteAuditLogArgs): Promise<void> {
  try {
    const { data: { user } } = await supabase.auth.getUser();

    const enc = await encryptAuditLog({
      summary: summary | null,
      before_snapshot: before ? JSON.stringify(before) : null,
      after_snapshot: after ? JSON.stringify(after) : null,
    }, encrypt);

    await supabase.from('audit_logs').insert({
      org_id: orgId,
      user_id: user?.id | null,
      action,
      entity_type: entityType,
      entity_id: entityId,
      ...enc,
    });
  } catch (err) {
    console.warn('[AuditLog] Failed to write audit entry:', err);
  }
}
