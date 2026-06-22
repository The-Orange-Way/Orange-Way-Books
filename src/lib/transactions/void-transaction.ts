/**
 * Void a transaction by writing a reversing JE in the current period.
 *
 * Always emits a reverse-JE in the current period (never edits the original):
 *
 *   1. Load the original transaction + its journal_entries wrapper + lines.
 *   2. Create a new journal_entries row with source_type='VOID_REVERSAL' and
 *      reversal_of_id pointing at the original JE id. Date = current date
 *      (period-lock branching lands when P1 enforcement ships).
 *   3. Insert N+1 reversed journal_entry_lines (debit ↔ credit swapped from
 *      the original). Encryption + dual-currency via buildJournalEntryLineInsert.
 *   4. Flip the original transactions row(s) to encrypted status='VOID'. For
 *      transfer pairs, both linked rows get flipped.
 *   5. (Phase 3 removed the ledger, the reversing posts are now purely client-side.)
 *      set (account legs for split, both legs for transfer). the ledger posting is
 *      best-effort, non-blocking, OWB's encrypted JE lines are the source of
 *      truth that ledger-engine reads.
 *
 * Limitations at v1:
 *   - Only voids transactions that have a journal_entry_id (split + transfer).
 *     Standard-mode txs don't write a JE wrapper today (deferred to T4 status
 *     state-machine unification); voiding them requires retroactive JE
 *     creation, which is a follow-up.
 *   - Reverse-JE always lands in the current period, regardless of the
 *     original date. When period-lock enforcement ships, this branches
 *     to "void in original period if open; in current period if closed."
 *   - When legacy-server-minimal exposes the transactionVoid GraphQL mutation,
 *     the ledger reversal path will switch to the direction-flip primitive
 *     instead of posting fresh reversing transactions.
 */

import { supabase } from '@/lib/supabase';
import {
  encryptJournalEntry,
  decryptJournalEntry,
  decryptJournalEntryLine,
  decryptChartOfAccount,
  decryptWallet,
  FIELD_KEY_VERSION,
} from '@/lib/crypto-fields';
import { buildJournalEntryLineInsert } from '@/lib/exchange/build-je-line-insert';
// Phase 2 removal: the ledger reversal posting deleted; Postgres reversing JE
// is the single source of truth.
import { writeAuditLog } from '@/lib/audit-logger';

type EncryptFn = (plaintext: string) => Promise<string>;
type DecryptFn = (ciphertext: string) => Promise<string>;

/**
 * Phase 4.4 mutation signing: callers pass the same helpers from VaultContext
 * that the transaction modal uses. We throw if the caller has no signing-key wrap.
 * Phase 4.2 RLS already blocks unsigned writes for non-writers, and
 * voiding is a writer action.
 */
type LoadOskFn = (orgId: string) => Promise<unknown>;
type SignMutationFn = (
  payloadBytes: Uint8Array,
  orgId: string,
) => { signature_b64: string; key_version: number } | null;

export interface VoidTransactionParams {
  /** transactions.id of the row to void. */
  txId: string;
  orgId: string;
  /** Org's ledger blind-journal id. Null → skip ledger reversals. */
  legacyJournalId: string | null;
  /** Date for the reversing JE. Today's date in YYYY-MM-DD. */
  date: string;
  /** Optional reason; recorded in the reversing JE's memo. */
  reason?: string;
  encryptText: EncryptFn;
  decryptText: DecryptFn;
  loadOrgSigningKey: LoadOskFn;
  signMutation: SignMutationFn;
}

export interface VoidTransactionResult {
  reversalJournalEntryId: string;
  voidedTransactionIds: string[];
}

export async function voidTransaction(p: VoidTransactionParams): Promise<VoidTransactionResult> {
  // ── Phase 1: load original ───────────────────────────────────────────
  const { data: origTx, error: origTxErr } = await supabase
    .from('transactions')
    .select('*')
    .eq('id', p.txId)
    .single();
  if (origTxErr) throw origTxErr;
  if (!origTx) throw new Error('Transaction not found.');
  if (!origTx.journal_entry_id) {
    throw new Error(
      'Cannot void: this transaction has no journal-entry wrapper. ' +
        'Standard-mode transactions need to be re-saved through the unified ' +
        'JE write path (Track 2 T4) before they can be voided.',
    );
  }

  const { data: origJe, error: jeErr } = await supabase
    .from('journal_entries')
    .select('*')
    .eq('id', origTx.journal_entry_id)
    .single();
  if (jeErr) throw jeErr;
  if (!origJe) throw new Error('Original journal entry not found.');

  const { data: origLines, error: linesErr } = await supabase
    .from('journal_entry_lines')
    .select('*')
    .eq('journal_entry_id', origTx.journal_entry_id);
  if (linesErr) throw linesErr;
  if (!origLines || origLines.length === 0) {
    throw new Error('Original journal entry has no lines to reverse.');
  }

  // ── Phase 2: decrypt original entries ─────────────────────────────────
  const origJeDec = await decryptJournalEntry(origJe, p.decryptText);
  const origLineDecs = await Promise.all(
    origLines.map((l: any) => decryptJournalEntryLine(l, p.decryptText).then((dec) => ({ dec }))),
  );

  // ── Phase 3: create reversing JE ──────────────────────────────────────
  const reversalMemo = `Reversal of ${origJeDec.memo | `tx ${p.txId.slice(0, 8)}`}${
    p.reason ? `: ${p.reason}` : ''
  }`;
  const encReversingEntry = await encryptJournalEntry(
    {
      memo: reversalMemo,
      ref_number: null,
      currency: origJeDec.currency,
      exchange_rate: origJeDec.exchange_rate,
      status: 'DRAFT',
      source_type: 'VOID_REVERSAL',
      period_locked: false,
    },
    p.encryptText,
  );

  const { data: reversalJeRow, error: reversalJeErr } = await supabase
    .from('journal_entries')
    .insert({
      org_id: p.orgId,
      date: p.date,
      reversal_of_id: origTx.journal_entry_id,
      ...encReversingEntry,
    } as any)
    .select('id')
    .single();
  if (reversalJeErr) throw reversalJeErr;
  const reversalJeId = (reversalJeRow as any).id;

  // ── Phase 4: insert reversed lines (debit ↔ credit swapped) ───────────
  const reversedLineInserts = await Promise.all(
    origLineDecs.map(async ({ dec }) => {
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
      return { journal_entry_id: reversalJeId, ...buildRes.insert };
    }),
  );
  const { error: reversedLinesErr } = await supabase
    .from('journal_entry_lines')
    .insert(reversedLineInserts as any);
  if (reversedLinesErr) throw reversedLinesErr;

  // ── Phase 5: flip original transactions to VOID status ────────────────
  // Phase 4.4: sign the status flip. We compute one signature over the
  // reversal JE id + the void status, then stamp it on each affected row.
  // The verifier reads each row and can reconstruct the same payload bytes.
  await p.loadOrgSigningKey(p.orgId);
  const voidSigBytes = new TextEncoder().encode(`${p.orgId}|void|${reversalJeId}|${p.date}`);
  const voidSig = p.signMutation(voidSigBytes, p.orgId);
  if (!voidSig) {
    throw new Error(
      'No signing key available for this org. ' +
        'Please refresh the page; if the problem persists contact support.',
    );
  }

  const encVoidStatus = await p.encryptText('VOID');
  const voidedIds: string[] = [origTx.id];
  if (origTx.linked_transfer_id) {
    voidedIds.push(origTx.linked_transfer_id);
  }
  const { error: voidErr } = await supabase
    .from('transactions')
    .update({
      status: encVoidStatus,
      key_version: FIELD_KEY_VERSION,
      signature_b64: voidSig.signature_b64,
      signature_key_version: voidSig.key_version,
    } as any)
    .in('id', voidedIds);
  if (voidErr) throw voidErr;

  // Phase 2 (external-ledger removal): the ledger reversing-posting block (~100 lines)
  // lived here. Postgres-side reversing journal_entries + reversed lines
  // already written earlier in this function are now the single source of
  // truth. No external-ledger dual-write required.

  // ── Phase 7: audit ────────────────────────────────────────────────────
  writeAuditLog({
    orgId: p.orgId,
    action: 'VOID',
    entityType: 'transaction',
    entityId: origTx.id,
    summary: `Voided transaction ${origTx.id.slice(0, 8)}${p.reason ? `: ${p.reason}` : ''}`,
    after: {
      reversal_journal_entry_id: reversalJeId,
      voided_transaction_ids: voidedIds,
      reason: p.reason ?? null,
    },
    encrypt: p.encryptText,
  });

  return { reversalJournalEntryId: reversalJeId, voidedTransactionIds: voidedIds };
}
