/**
 * Deletes a transaction, and the draft journal entry the transaction screen
 * wrote for it (OWB-T0241). Without this, deleting a standard or split draft
 * left its entry on the Journal page, where it could still be posted.
 *
 * Only a DRAFT entry of type TRANSACTION_STANDARD or TRANSACTION_SPLIT is
 * removed: those belong to one transaction. A posted entry, a transfer (shared
 * by two transactions) or an entry made elsewhere is left alone. Its lines go
 * with it (ON DELETE CASCADE).
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function deleteTxWithDraftEntry(
  client: SupabaseClient,
  tx: { id: string; journal_entry_id?: string | null },
): Promise<void> {
  const { error } = await client.from('transactions').delete().eq('id', tx.id);
  if (error) throw new Error(error.message);
  if (!tx.journal_entry_id) return;
  const { error: jeErr } = await client
    .from('journal_entries')
    .delete()
    .eq('id', tx.journal_entry_id)
    .eq('status', 'DRAFT')
    .in('source_type', ['TRANSACTION_STANDARD', 'TRANSACTION_SPLIT']);
  if (jeErr) throw new Error(jeErr.message);
}
