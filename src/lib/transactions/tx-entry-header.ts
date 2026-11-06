/**
 * Writes the journal entry header behind a split or transfer saved from the
 * transaction screen.
 *
 * A new entry gets the next JE-YYYY-NNNN reference from next_je_ref_number,
 * the same way an entry made on the Journal page does, so it can be cited
 * and found by Ref #. An existing entry keeps the reference it has: the
 * update leaves that column out rather than writing it empty.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { encryptJournalEntry, type JournalEntryFields } from '@/lib/crypto-fields';
import { mintInternalJeRefNumber } from '@/lib/journal-entry-ref-numbers';

type EncryptFn = (plaintext: string) => Promise<string>;

export interface TxEntryHeaderInput {
  orgId: string;
  /** yyyy-MM-dd */
  date: string;
  /** The entry already behind the transaction, or null for a new one. */
  existingId: string | null;
  fields: Omit<JournalEntryFields, 'ref_number'>;
  encrypt: EncryptFn;
  /** Injected in tests. Defaults to the next_je_ref_number RPC. */
  mintRef?: (year: number) => Promise<string>;
}

/** Returns the id of the entry written. */
export async function saveTxEntryHeader(
  client: SupabaseClient,
  input: TxEntryHeaderInput,
): Promise<string> {
  if (input.existingId) {
    const enc: Partial<Awaited<ReturnType<typeof encryptJournalEntry>>> = await encryptJournalEntry(
      { ...input.fields, ref_number: null },
      input.encrypt,
    );
    delete enc.encrypted_ref_number;
    const { error } = await client
      .from('journal_entries')
      .update(enc as never)
      .eq('id', input.existingId);
    if (error) throw error;
    return input.existingId;
  }

  const mint =
    input.mintRef ?? ((year: number) => mintInternalJeRefNumber(client, input.orgId, year));
  // The same year rule as the Journal page, so both screens share one sequence.
  const ref = await mint(new Date().getUTCFullYear());
  const enc = await encryptJournalEntry({ ...input.fields, ref_number: ref }, input.encrypt);
  const { data, error } = await client
    .from('journal_entries')
    .insert({ org_id: input.orgId, date: input.date, ...enc } as never)
    .select('id')
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}
