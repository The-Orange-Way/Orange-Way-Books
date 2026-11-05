/**
 * Edit a POSTED journal entry in place (OWB-T0238).
 *
 * The database function owb_edit_posted_entry does the work in one
 * transaction: it copies the old header and lines into the history tables,
 * replaces the lines and updates the header, keeping the entry's id and ref
 * number. It refuses closed months (unless the owner has unlocked them),
 * reversals, reversed entries and callers without permission.
 *
 * Line amounts are encrypted, so the server cannot check that debits equal
 * credits. This helper checks it on the plaintext amounts before anything is
 * sent, and refuses a missing reason.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  decryptJournalEntry,
  decryptJournalEntryLine,
  type JournalEntryLineEncrypted,
} from '@/lib/crypto-fields';

type DecryptFn = (ciphertext: string) => Promise<string>;

/** Line columns owb_edit_posted_entry reads. Anything else is dropped. */
export const EDIT_LINE_KEYS = [
  'account_id',
  'account_code',
  'account_name',
  'description',
  'encrypted_debit',
  'encrypted_credit',
  'encrypted_amount_native',
  'encrypted_amount_primary',
  'encrypted_book_value',
  'encrypted_manual_rate_reason',
  'encrypted_manual_rate_source',
  'encrypted_metadata',
  'encrypted_posted_rate',
  'encrypted_primary_currency_at_posting',
  'encrypted_wallet_currency',
  'pinned_rate_id',
  'rate_asof',
  'rate_pending',
] as const;

export type EditLine = JournalEntryLineEncrypted & { account_id: string };

export interface EditPostedEntryInput {
  entryId: string;
  /** journal_entries.key_version of the entry being edited. */
  entryKeyVersion: number;
  /** yyyy-MM-dd */
  date: string;
  header: { encrypted_memo: string | null; encrypted_currency: string };
  lines: EditLine[];
  /** Plaintext amounts of the same lines, used only for the balance check. */
  amounts: Array<{ debit: number; credit: number }>;
  encryptedReason: string;
  reasonText: string;
}

export interface EditPostedEntryArgs {
  p_je_id: string;
  p_date: string;
  p_header: Record<string, string | null>;
  p_lines: Array<Record<string, unknown>>;
  p_txs: unknown[];
  p_encrypted_reason: string;
  p_key_version: number;
}

/** Builds the RPC arguments, or throws with a message the user can act on. */
export function buildEditPostedEntryArgs(input: EditPostedEntryInput): EditPostedEntryArgs {
  if (!input.reasonText.trim()) {
    throw new Error('Say why this posted entry is being changed.');
  }
  if (input.lines.length < 2 || input.amounts.length !== input.lines.length) {
    throw new Error('A journal entry needs at least two lines.');
  }
  const debits = input.amounts.reduce((s, a) => s + a.debit, 0);
  const credits = input.amounts.reduce((s, a) => s + a.credit, 0);
  if (!(debits > 0) || Math.abs(debits - credits) >= 0.001) {
    throw new Error('Debits and credits must be equal before the entry can be saved.');
  }
  for (const line of input.lines) {
    if (line.key_version !== input.entryKeyVersion) {
      throw new Error(
        'This entry was saved with an older encryption key. Re-encrypt the books before editing it.',
      );
    }
    if (!line.account_id) throw new Error('Every line needs an account.');
  }
  const p_lines = input.lines.map((line) => {
    const out: Record<string, unknown> = {};
    for (const k of EDIT_LINE_KEYS) {
      const v = (line as unknown as Record<string, unknown>)[k];
      if (v !== undefined) out[k] = v;
    }
    return out;
  });
  return {
    p_je_id: input.entryId,
    p_date: input.date,
    p_header: {
      encrypted_memo: input.header.encrypted_memo,
      encrypted_currency: input.header.encrypted_currency,
    },
    p_lines,
    // Linked transactions are not changed from the Journal screen: it only
    // edits manual entries, which have none.
    p_txs: [],
    p_encrypted_reason: input.encryptedReason,
    p_key_version: input.entryKeyVersion,
  };
}

/** Sends the edit. Returns the new version number. */
export async function editPostedEntry(
  client: SupabaseClient,
  input: EditPostedEntryInput,
): Promise<number> {
  const args = buildEditPostedEntryArgs(input);
  const { data, error } = await client.rpc('owb_edit_posted_entry' as never, args as never);
  if (error) throw new Error(error.message);
  return data as unknown as number;
}

export interface EntryVersionLine {
  accountName: string | null;
  debit: number;
  credit: number;
  description: string | null;
}

export interface EntryVersion {
  versionNo: number;
  editedAt: string;
  editedBy: string;
  periodOverride: boolean;
  reason: string | null;
  /** The entry as it was before this edit. */
  date: string;
  memo: string | null;
  lines: EntryVersionLine[];
}

/** Earlier versions of one entry, newest first, decrypted. */
export async function fetchEntryHistory(
  client: SupabaseClient,
  entryId: string,
  decrypt: DecryptFn,
): Promise<EntryVersion[]> {
  const [vRes, lRes] = await Promise.all([
    client
      .from('journal_entry_versions' as never)
      .select('*')
      .eq('journal_entry_id', entryId)
      .order('version_no', { ascending: false }),
    client
      .from('journal_entry_line_versions' as never)
      .select('*')
      .eq('journal_entry_id', entryId)
      .order('line_created_at', { ascending: true }),
  ]);
  if (vRes.error) throw new Error(vRes.error.message);
  if (lRes.error) throw new Error(lRes.error.message);
  const versions = (vRes.data ?? []) as Array<Record<string, unknown>>;
  const lineRows = (lRes.data ?? []) as Array<Record<string, unknown>>;
  return Promise.all(
    versions.map(async (v) => {
      const header = await decryptJournalEntry(v, decrypt);
      const lines = await Promise.all(
        lineRows
          .filter((l) => l.version_id === v.id)
          .map(async (l) => {
            const d = await decryptJournalEntryLine(l, decrypt);
            return {
              accountName: d.account_name,
              debit: d.debit ?? 0,
              credit: d.credit ?? 0,
              description: d.description,
            };
          }),
      );
      return {
        versionNo: v.version_no as number,
        editedAt: v.edited_at as string,
        editedBy: v.edited_by as string,
        periodOverride: v.period_override as boolean,
        reason: v.encrypted_reason ? await decrypt(v.encrypted_reason as string) : null,
        date: v.date as string,
        memo: header.memo,
        lines,
      };
    }),
  );
}
