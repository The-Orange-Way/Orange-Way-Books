/**
 * Reverse a journal entry by writing a new JE that nets the original to zero.
 *
 * Track 7 — parallel to voidTransaction (T3 v1) but operates directly on a
 * journal_entries row rather than walking via a parent transactions row.
 * Used by the Journal Entries page's Reverse action and Bulk Reverse.
 *
 *   1. Load original JE + lines.
 *   2. Decrypt via decryptJournalEntry / decryptJournalEntryLine.
 *   3. Create a new journal_entries row with source_type='VOID_REVERSAL' and
 *      reversal_of_id pointing at the original. Status starts POSTED (a
 *      reversal is meant to be live the moment it's written; the
 *      handleReverse).
 *   4. Insert N reversed lines (debit ↔ credit swapped). Encryption + dual-
 *      currency via buildJournalEntryLineInsert.
 *   5. Flip the original journal_entries.status to encrypted 'VOID'.
 *
 * Limitations:
 *   - Reverse-JE always lands in the current period (T3.b lock). When period-
 *     lock enforcement ships, this can branch on original_period vs
 *     current_period.
 *   - Reversing entries created by this helper themselves cannot be reversed
 *     (canReverse check on the UI already filters source_type='VOID_REVERSAL').
 */

import { supabase } from '@/lib/supabase';
import {
  encryptJournalEntry,
  decryptJournalEntry,
  decryptJournalEntryLine,
} from '@/lib/crypto-fields';
import { buildJournalEntryLineInsert } from '@/lib/exchange/build-je-line-insert';
import { writeAuditLog } from '@/lib/audit-logger';

type EncryptFn = (plaintext: string) => Promise<string>;
type DecryptFn = (ciphertext: string) => Promise<string>;

const KEY_VERSION = 2;

export interface ReverseJournalEntryParams {
  journalEntryId: string;
  orgId: string;
  /** Date for the reversing JE. Today in YYYY-MM-DD. */
  date: string;
  /** Optional reason; recorded in the reversing JE's memo. */
  reason?: string;
  encryptText: EncryptFn;
  decryptText: DecryptFn;
}

export interface ReverseJournalEntryResult {
  reversalJournalEntryId: string;
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

  const { data: origLines, error: linesErr } = await supabase
    .from('journal_entry_lines')
    .select('*')
    .eq('journal_entry_id', p.journalEntryId);
  if (linesErr) throw linesErr;
  if (!origLines | origLines.length === 0) {
    throw new Error('Journal entry has no lines to reverse.');
  }

  // ── Decrypt ──────────────────────────────────────────────────────────
  const origJeDec = await decryptJournalEntry(origJe as any, p.decryptText);
  const origLineDecs = await Promise.all(
    origLines.map((l: any) => decryptJournalEntryLine(l, p.decryptText)),
  );

  // ── Build reversing wrapper JE ───────────────────────────────────────
  const reversalMemo = `Reversal of ${origJeDec.ref_number | origJeDec.memo | `JE ${p.journalEntryId.slice(0, 8)}`}${
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
      source_type: 'VOID_REVERSAL',
      period_locked: false,
    },
    p.encryptText,
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

  // ── Build reversed lines (debit ↔ credit swapped) ────────────────────
  const reversedLineInserts = await Promise.all(
    origLineDecs.map(async (dec) => {
      const buildRes = await buildJournalEntryLineInsert({
        wallet_currency: dec.wallet_currency ?? origJeDec.currency,
        primary_currency: origJeDec.currency,
        date: p.date,
        debit: dec.credit,
        credit: dec.debit,
        account_name: dec.account_name,
        account_code: dec.account_code,
        description: `Reversal of: ${dec.description ?? ''}`.trim(),
        encrypt: p.encryptText,
      });
      return { journal_entry_id: reversalId, ...buildRes.insert };
    }),
  );
  const { error: reversedLinesErr } = await supabase
    .from('journal_entry_lines')
    .insert(reversedLineInserts as any);
  if (reversedLinesErr) throw reversedLinesErr;

  // ── Flip original to VOID ────────────────────────────────────────────
  // Post-Phase 1: status is plaintext. The immutability trigger's
  // workflow-meta whitelist permits the status column to change while
  // locking business fields.
  const { error: voidErr } = await supabase
    .from('journal_entries')
    .update({ status: 'VOID' } as any)
    .eq('id', p.journalEntryId);
  if (voidErr) throw voidErr;

  // ── Audit ────────────────────────────────────────────────────────────
  writeAuditLog({
    orgId: p.orgId,
    // audit_logs.action CHECK doesn't include 'REVERSE'; 'VOID' is the right
    // semantic match here (the original JE just got voided, and a new JE
    // counter-balances it). The reversal_of_id linkage carries the full story.
    action: 'VOID',
    entityType: 'journal_entry',
    entityId: p.journalEntryId,
    summary: `Reversed JE ${p.journalEntryId.slice(0, 8)}${p.reason ? `: ${p.reason}` : ''}`,
    after: { reversal_journal_entry_id: reversalId, reason: p.reason ?? null },
    encrypt: p.encryptText,
  });

  return { reversalJournalEntryId: reversalId };
}
