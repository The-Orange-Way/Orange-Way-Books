/**
 * Fill late exchange rates on a POSTED journal entry (OWB-T0238 step 9).
 *
 * A posted entry's lines cannot be updated directly, so a line saved with
 * rate_pending = true stays pending unless the rate is filled through
 * owb_edit_posted_entry. That keeps the entry's id and number and saves the
 * earlier version in its history, with the reason "Exchange rate filled in".
 *
 * A line is waiting when rate_pending is set or dual_amounts_backfilled is
 * false. Only waiting lines are rebuilt, with the entry's date and the primary
 * currency the line was posted under, keeping the line's stored metadata.
 * Every other line is sent back exactly as stored, so a rate that is already
 * pinned never changes here. When no waiting line can be resolved, nothing is
 * sent and no history is written.
 *
 * The edit function writes every line with dual_amounts_backfilled = true, so
 * a waiting line that is sent back unresolved is marked rate_pending, which
 * the edit keeps. That way the next run still finds it.
 *
 * The edit carries the entry's updated_at as read here. If the entry changed
 * while the rates were being looked up, the database refuses it under the
 * row lock, so a person's edit is never overwritten with the lines read
 * before it.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptJournalEntryLine } from '@/lib/crypto-fields';
import {
  buildJournalEntryLineInsert,
  type BuildJeLineInsertParams,
  type BuildJeLineInsertResult,
  type ManualRate,
} from './build-je-line-insert';
import { editPostedEntry, type EditLine } from '@/lib/journal-entry-edit-posted';

type EncryptFn = (plaintext: string) => Promise<string>;
type DecryptFn = (ciphertext: string) => Promise<string>;

export const RATE_FILL_REASON = 'Exchange rate filled in';

export interface FillPendingRatesDeps {
  encrypt: EncryptFn;
  decrypt: DecryptFn;
  /** Rates entered by hand, by line id. Used instead of the resolver for those lines. */
  manualRates?: Record<string, ManualRate>;
  /** Injected in tests. */
  build?: (p: BuildJeLineInsertParams) => Promise<BuildJeLineInsertResult>;
}

export interface FillPendingRatesResult {
  /** Waiting lines found on the entry. */
  waiting: number;
  filled: number;
  stillPending: number;
  /** The history version written, or null when nothing was sent. */
  version: number | null;
}

export async function fillPendingRatesOnPostedEntry(
  client: SupabaseClient,
  entryId: string,
  deps: FillPendingRatesDeps,
): Promise<FillPendingRatesResult> {
  const build = deps.build ?? buildJournalEntryLineInsert;

  const { data: entry, error: eErr } = await client
    .from('journal_entries')
    .select('id, status, date, updated_at, key_version, encrypted_memo, encrypted_currency')
    .eq('id', entryId)
    .single();
  if (eErr || !entry) throw new Error(eErr?.message ?? 'Entry not found.');
  const je = entry as {
    status: string;
    date: string;
    updated_at: string;
    key_version: number | null;
    encrypted_memo: string | null;
    encrypted_currency: string;
  };
  if (je.status !== 'POSTED') {
    throw new Error('Only a posted entry is filled through the edit path.');
  }

  const { data: lineRows, error: lErr } = await client
    .from('journal_entry_lines')
    .select('*')
    .eq('journal_entry_id', entryId)
    .order('created_at', { ascending: true });
  if (lErr) throw new Error(lErr.message);
  const rows = (lineRows ?? []) as Array<EditLine & { id: string }>;

  let waiting = 0;
  let filled = 0;
  let stillPending = 0;
  const lines: EditLine[] = [];
  const amounts: Array<{ debit: number; credit: number }> = [];

  for (const row of rows) {
    const d = await decryptJournalEntryLine(row, deps.decrypt);
    amounts.push({ debit: d.debit, credit: d.credit });
    if (!row.rate_pending && row.dual_amounts_backfilled !== false) {
      lines.push(row);
      continue;
    }
    waiting++;
    // Sent back unresolved: keep it findable by the next run.
    const keep = { ...row, rate_pending: true };
    // A line with no readable currency or no stored amount is left as it is:
    // guessing either would put a wrong number in the books.
    if (
      !d.wallet_currency ||
      !d.primary_currency_at_posting ||
      (row.encrypted_debit == null && row.encrypted_credit == null)
    ) {
      stillPending++;
      lines.push(keep);
      continue;
    }
    let built: BuildJeLineInsertResult;
    try {
      built = await build({
        wallet_currency: d.wallet_currency,
        primary_currency: d.primary_currency_at_posting,
        date: je.date,
        debit: d.debit,
        credit: d.credit,
        account_id: row.account_id,
        account_name: d.account_name,
        account_code: d.account_code,
        description: d.description,
        book_value: d.book_value,
        manualRate: deps.manualRates?.[row.id],
        encrypt: deps.encrypt,
      });
    } catch {
      // The rate lookup failed: keep the stored line, still pending.
      stillPending++;
      lines.push(keep);
      continue;
    }
    if (built.pending) {
      stillPending++;
      lines.push(keep);
    } else {
      filled++;
      const meta = (row as { encrypted_metadata?: string | null }).encrypted_metadata ?? null;
      lines.push({ ...built.insert, encrypted_metadata: meta } as EditLine);
    }
  }

  if (filled === 0) return { waiting, filled, stillPending, version: null };

  const version = await editPostedEntry(client, {
    entryId,
    entryKeyVersion: je.key_version ?? 0,
    date: je.date,
    header: { encrypted_memo: je.encrypted_memo, encrypted_currency: je.encrypted_currency },
    lines,
    amounts,
    encryptedReason: await deps.encrypt(RATE_FILL_REASON),
    reasonText: RATE_FILL_REASON,
    expectedUpdatedAt: je.updated_at,
  });
  return { waiting, filled, stillPending, version };
}
