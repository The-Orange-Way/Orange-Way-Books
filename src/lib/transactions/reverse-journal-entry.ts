/**
 * Reverse a journal entry by writing a new JE that nets the original to zero.
 *
 * Track 7 — parallel to voidTransaction (T3 v1) but operates directly on a
 * journal_entries row rather than walking via a parent transactions row.
 * Used by the Journal Entries page's Reverse action and Bulk Reverse.
 *
 *   1. Load original JE + lines.
 *   2. Decrypt via decryptJournalEntry / decryptJournalEntryLine.
 *   3. Create a new journal_entries row with source_type='void_reversal' and
 *      reversal_of_id pointing at the original. Status starts POSTED (a
 *      reversal is meant to be live the moment it's written; the
 *      handleReverse).
 *   4. Insert N reversed lines (debit ↔ credit swapped). Encryption + dual-
 *      currency via buildJournalEntryLineInsert.
 *   5. Flip the original journal_entries.status to encrypted 'VOID'.
 *
 * A reversed line that the original priced is written at the original line's
 * rate, primary currency and value, so the reversal cancels the original in
 * the primary currency as well as in the wallet currency. Only a line the
 * original never priced (rate still pending, or an older line without a value
 * in the primary currency) is priced afresh at the reversal date.
 *
 * Limitations:
 *   - The caller picks the reversal date. The Journal screen uses today, or the
 *     first open day when the entry sits in a closed month.
 *   - Reversing entries created by this helper themselves cannot be reversed
 *     (canReverse check on the UI already filters source_type='void_reversal').
 */

import { supabase } from '@/lib/supabase';
import {
  encryptJournalEntry,
  encryptJournalEntryLine,
  decryptJournalEntry,
  decryptJournalEntryLine,
  type JournalEntryLineEncrypted,
} from '@/lib/crypto-fields';
import { buildJournalEntryLineInsert } from '@/lib/exchange/build-je-line-insert';
import { writeAuditLog } from '@/lib/audit-logger';
import { loadOrgPrimaryCurrency } from '@/lib/transactions/org-primary-currency';

type EncryptFn = (plaintext: string) => Promise<string>;
type DecryptFn = (ciphertext: string) => Promise<string>;

const KEY_VERSION = 2;

export interface ReverseJournalEntryParams {
  journalEntryId: string;
  orgId: string;
  /** Date for the reversing JE, YYYY-MM-DD: today, or the first open day when the original is in a closed month. */
  date: string;
  /** Optional reason; recorded in the reversing JE's memo. */
  reason?: string;
  encryptText: EncryptFn;
  decryptText: DecryptFn;
}

type DecryptedLine = Awaited<ReturnType<typeof decryptJournalEntryLine>>;

/**
 * The reversing line for one original line, carrying the original line's
 * stored value in the primary currency, negated, so the pair cancels. Returns
 * null only when the original line has no value in the primary currency (its
 * rate is still pending, or it is an older line), so the caller prices it
 * afresh. Throws when the posting currency cannot be read, because the value
 * could not be labelled; nothing has been written at that point.
 */
export async function reversalLineAtOriginalRate(
  row: { rate_pending?: boolean | null; rate_asof?: string | null; pinned_rate_id?: string | null },
  dec: DecryptedLine,
  encrypt: EncryptFn,
): Promise<JournalEntryLineEncrypted | null> {
  if (row.rate_pending || dec.amount_primary == null) return null;
  if (dec.primary_currency_at_posting_unreadable) {
    throw new Error(
      'A line of this entry has a posting currency that cannot be read, so it cannot be reversed at its original value. Nothing was changed.',
    );
  }
  const debit = dec.credit;
  const credit = dec.debit;
  return encryptJournalEntryLine(
    {
      account_name: dec.account_name,
      account_code: dec.account_code,
      description: `Reversal of: ${dec.description ?? ''}`.trim(),
      debit,
      credit,
      book_value: null,
      amount_native: dec.amount_native != null ? -dec.amount_native : debit > 0 ? debit : -credit,
      amount_primary: -dec.amount_primary,
      posted_rate: dec.posted_rate ?? null,
      wallet_currency: dec.wallet_currency ?? null,
    },
    encrypt,
    {
      primary_currency_at_posting: dec.primary_currency_at_posting ?? null,
      rate_pending: false,
      rate_asof: row.rate_asof ?? null,
      pinned_rate_id: row.pinned_rate_id ?? null,
    },
  );
}

export interface ReverseJournalEntryResult {
  reversalJournalEntryId: string;
  /**
   * False when the original stays POSTED because its month is closed. The
   * reversal still cancels it in the books, and reversal_of_id links the two.
   */
  originalVoided: boolean;
}

export async function reverseJournalEntry(
  p: ReverseJournalEntryParams,
): Promise<ReverseJournalEntryResult> {
  // ── Load original ────────────────────────────────────────────────────
  const { data: origJe, error: jeErr } = await supabase
    .from('journal_entries')
    .select('*')
    .eq('id', p.journalEntryId)
    .single();
  if (jeErr) throw jeErr;
  if (!origJe) throw new Error('Journal entry not found.');

  // An entry left POSTED in a closed month can be selected again. Refuse a
  // second reversal before anything is written.
  const { data: existing, error: existingErr } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('reversal_of_id', p.journalEntryId)
    .limit(1);
  if (existingErr) throw existingErr;
  if ((existing ?? []).length > 0) {
    throw new Error('This entry has already been reversed. Nothing was changed.');
  }

  const { data: origLines, error: linesErr } = await supabase
    .from('journal_entry_lines')
    .select('*')
    .eq('journal_entry_id', p.journalEntryId);
  if (linesErr) throw linesErr;
  if (!origLines || origLines.length === 0) {
    throw new Error('Journal entry has no lines to reverse.');
  }

  // ── Decrypt ──────────────────────────────────────────────────────────
  const origJeDec = await decryptJournalEntry(origJe as any, p.decryptText);
  const origLineDecs = await Promise.all(
    origLines.map((l: any) =>
      decryptJournalEntryLine(l, p.decryptText).then((dec) => ({
        dec,
        row: l,
        accountId: l.account_id as string,
      })),
    ),
  );

  // Reversal lines are valued in the org's primary currency, not the original
  // entry's header currency. Read it before anything is written.
  const orgPrimary = await loadOrgPrimaryCurrency(supabase, p.orgId, p.decryptText);

  // ── Build reversing wrapper JE ───────────────────────────────────────
  const reversalMemo = `Reversal of ${origJeDec.ref_number || origJeDec.memo || `JE ${p.journalEntryId.slice(0, 8)}`}${
    p.reason ? `: ${p.reason}` : ''
  }`;
  const encReversing = await encryptJournalEntry(
    {
      memo: reversalMemo,
      ref_number: null,
      currency: origJeDec.currency,
      exchange_rate: origJeDec.exchange_rate,
      // Reversals post immediately — they're meant to live the moment they're
      // written, same as the reverse behavior in the JE module.
      status: 'POSTED',
      source_type: 'void_reversal',
      period_locked: false,
    },
    p.encryptText,
  );

  // ── Build reversed lines (debit ↔ credit swapped) ────────────────────
  // Built before anything is written, so a line that cannot be reversed
  // stops the reversal with nothing saved.
  const reversedLines = await Promise.all(
    origLineDecs.map(async ({ dec, row, accountId }) => {
      const atOriginal = await reversalLineAtOriginalRate(row, dec, p.encryptText);
      if (atOriginal) {
        return { account_id: accountId, ...atOriginal };
      }
      const buildRes = await buildJournalEntryLineInsert({
        wallet_currency: dec.wallet_currency ?? origJeDec.currency,
        primary_currency: orgPrimary,
        date: p.date,
        debit: dec.credit,
        credit: dec.debit,
        // The reversing line posts to the same account as the line it reverses.
        account_id: accountId,
        account_name: dec.account_name,
        account_code: dec.account_code,
        description: `Reversal of: ${dec.description ?? ''}`.trim(),
        encrypt: p.encryptText,
      });
      return buildRes.insert;
    }),
  );

  const { data: reversalRow, error: reversalErr } = await supabase
    .from('journal_entries')
    .insert({
      org_id: p.orgId,
      date: p.date,
      reversal_of_id: p.journalEntryId,
      ...encReversing,
    } as any)
    .select('id')
    .single();
  if (reversalErr) throw reversalErr;
  const reversalId = (reversalRow as any).id;

  const reversedLineInserts = reversedLines.map((l) => ({ journal_entry_id: reversalId, ...l }));
  const { error: reversedLinesErr } = await supabase
    .from('journal_entry_lines')
    .insert(reversedLineInserts as any);
  if (reversedLinesErr) throw reversedLinesErr;

  // ── Flip original to VOID ────────────────────────────────────────────
  // Post-Phase 1: status is plaintext. The immutability trigger's
  // workflow-meta whitelist permits the status column to change while
  // locking business fields.
  // In a closed month the period lock lets no row change, without an error.
  // The original then stays POSTED; the reversal still cancels it.
  const { data: voided, error: voidErr } = await supabase
    .from('journal_entries')
    .update({ status: 'VOID' } as any)
    .eq('id', p.journalEntryId)
    .select('id');
  if (voidErr) throw voidErr;
  const originalVoided = (voided ?? []).length > 0;

  // ── Audit ────────────────────────────────────────────────────────────
  writeAuditLog({
    orgId: p.orgId,
    // audit_logs.action CHECK doesn't include 'REVERSE'; 'VOID' is the right
    // semantic match here (the original JE just got voided, and a new JE
    // counter-balances it). The reversal_of_id linkage carries the full story.
    action: 'VOID',
    entityType: 'journal_entry',
    entityId: p.journalEntryId,
    summary: `Reversed JE ${p.journalEntryId.slice(0, 8)}${
      originalVoided ? '' : ' (closed month, original left posted)'
    }${p.reason ? `: ${p.reason}` : ''}`,
    after: {
      reversal_journal_entry_id: reversalId,
      original_voided: originalVoided,
      reason: p.reason ?? null,
    },
    encrypt: p.encryptText,
  });

  return { reversalJournalEntryId: reversalId, originalVoided };
}
