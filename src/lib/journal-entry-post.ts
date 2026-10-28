/**
 * Move a journal entry to POSTED.
 *
 * journal_entries.status is PLAINTEXT (the server reads it for the
 * immutability trigger and the status CHECK constraint). Writing an
 * encrypted value there is refused with a check-constraint error, so every
 * caller must go through this helper and must handle the returned error.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export async function postJournalEntry(
  client: SupabaseClient,
  id: string,
): Promise<{ error: { message: string } | null }> {
  const { error } = await client.from('journal_entries').update({ status: 'POSTED' }).eq('id', id);
  return { error };
}
