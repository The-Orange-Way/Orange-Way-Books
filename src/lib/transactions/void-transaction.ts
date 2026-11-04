/**
 * Void a transaction by writing a reversing JE in the current period.
 *
 * Always emits a reverse-JE in the current period (never edits the original):
 *
 *   1. Load the original transaction + its journal_entries wrapper + lines.
 *   2. Create a new journal_entries row with source_type='void_reversal' and
 *      reversal_of_id pointing at the original JE id. Date = current date
 *      (period-lock branching lands when P1 enforcement ships).
 *   3. Insert N+1 reversed journal_entry_lines (debit <-> credit swapped from
 *      the original). Encryption + dual-currency via buildJournalEntryLineInsert.
 *      Rate is pinned from the original line so the reversing entry uses the
 *      same exchange rate.
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
import {
  buildJournalEntryLineInsert,
  type PinnedRateInput,
} from '@/lib/exchange/build-je-line-insert';
// Phase 2 removal: the ledger reversal posting deleted; Postgres reversing JE
// is the single source of truth.
import { writeAuditLog } from '@/lib/audit-logger';
import { prepareMutationSigner } from '@/lib/transactions/mutation-signer';
import { loadOrgPrimaryCurrency } from '@/lib/transactions/org-primary-currency';

type EncryptFn = (plaintext: string) => Promise<string>;
type DecryptFn = (ciphertext: string) => Promise<string>;

/**
 * Phase 4.4 mutation signing: callers pass the same helpers from VaultContext
 * that the transaction modal uses. The signer is prepared before the first
 * write: signed when this user holds the org's key, unsigned when the org has
 * no key yet (as the database accepts), refused otherwise.
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
  /** Org's ledger blind-journal id. Null -> skip ledger reversals. */
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

/**
 * Shown when the transaction already has a reversing entry. The partial
 * unique index uq_journal_entries_reversal_of_id is the real guard: it refuses
 * a second reversal even when two voids race past the check below.
 */
export const ALREADY_VOID_MESSAGE = 'This transaction is already void.';

/** Shown when someone tries to edit a voided transaction. */
export const VOID_NOT_EDITABLE_MESSAGE = 'This transaction is void, so it cannot be edited.';

export interface VoidTransactionResult {
  reversalJournalEntryId: string;
  voidedTransactionIds: string[];
}

export async function voidTransaction(p: VoidTransactionParams): Promise<VoidTransactionResult> {
  // -- Phase 1: load original ------------------------------------------
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

  const { data: existingReversal, error: existingErr } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('reversal_of_id', origTx.journal_entry_id)
    .maybeSingle();
  if (existingErr) throw existingErr;
  if (existingReversal) throw new Error(ALREADY_VOID_MESSAGE);

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

  // -- Phase 2: decrypt original entries --------------------------------
  const origJeDec = await decryptJournalEntry(origJe, p.decryptText);
  const origLineDecs = await Promise.all(
    origLines.map((l: any) =>
      decryptJournalEntryLine(l, p.decryptText).then((dec) => ({
        dec,
        accountId: l.account_id as string,
        rawLine: l,
      })),
    ),
  );

  // Reversal lines are valued in the org's primary currency, not the original
  // entry's header currency. Read it before anything is written.
  const orgPrimary = await loadOrgPrimaryCurrency(supabase, p.orgId, p.decryptText);

  // Decide how the status flip will be signed before anything is written,
  // so a refusal leaves no reversing entry behind (see mutation-signer.ts).
  const signer = await prepareMutationSigner({
    client: supabase,
    orgId: p.orgId,
    loadOrgSigningKey: p.loadOrgSigningKey,
    signMutation: p.signMutation,
  });

  // -- Phase 3: create reversing JE ------------------------------------
  const reversalMemo = `Reversal of ${origJeDec.memo || `tx ${p.txId.slice(0, 8)}`}${
    p.reason ? `: ${p.reason}` : ''
  }`;
  const encReversingEntry = await encryptJournalEntry(
    {
      memo: reversalMemo,
      ref_number: null,
      currency: origJeDec.currency,
      exchange_rate: origJeDec.exchange_rate,
      status: 'DRAFT',
      source_type: 'void_reversal',
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
  // 23505 = unique_violation on uq_journal_entries_reversal_of_id: another
  // void got there first.
  if (reversalJeErr?.code === '23505') throw new Error(ALREADY_VOID_MESSAGE);
  if (reversalJeErr) throw reversalJeErr;
  const reversalJeId = (reversalJeRow as any).id;

  // -- Phase 4: insert reversed lines (debit <-> credit swapped) -------
  const reversedLineInserts = await Promise.all(
    origLineDecs.map(async ({ dec, accountId, rawLine }) => {
      // Decrypt the encrypted primary_currency_at_posting field so the
      // reversing line records the same primary currency as the original.
      const primaryCurrencyAtPosting = rawLine.primary_currency_at_posting
        ? await p.decryptText(rawLine.primary_currency_at_posting as string)
        : orgPrimary;

      // Build a PinnedRateInput to replay the original rate exactly.
      // Fallback: if rate_pending=false but posted_rate is null (rate not
      // readable), skip pinnedRate and let the resolver run with today's date.
      let pinnedRate: PinnedRateInput | undefined;
      if (rawLine.rate_pending) {
        pinnedRate = {
          posted_rate: null,
          pinned_rate_id: null,
          rate_asof: null,
          manual_rate_reason: null,
          manual_rate_source: null,
          amount_primary: null,
          rate_pending: true,
        };
      } else if (dec.posted_rate != null) {
        pinnedRate = {
          posted_rate: dec.posted_rate,
          pinned_rate_id: (rawLine.pinned_rate_id as string | null) ?? null,
          rate_asof: (rawLine.rate_asof as string | null) ?? null,
          manual_rate_reason: (rawLine.manual_rate_reason as string | null) ?? null,
          manual_rate_source: (rawLine.manual_rate_source as string | null) ?? null,
          // Sign-flip: the reversing line runs opposite to the original.
          amount_primary: dec.amount_primary != null ? -dec.amount_primary : null,
          rate_pending: false,
        };
      }
      // else: rate_pending=false, posted_rate===null -> no pinnedRate,
      // resolver will run with today's date (existing fallback behavior).

      const buildRes = await buildJournalEntryLineInsert({
        wallet_currency: dec.wallet_currency ?? origJeDec.currency,
        primary_currency: primaryCurrencyAtPosting,
        date: p.date,
        debit: dec.credit,
        credit: dec.debit,
        // The reversing line posts to the same account as the line it reverses.
        account_id: accountId,
        account_name: dec.account_name,
        account_code: dec.account_code,
        description: `Reversal of: ${dec.description ?? ''}`.trim(),
        pinnedRate,
        encrypt: p.encryptText,
      });
      return { journal_entry_id: reversalJeId, ...buildRes.insert };
    }),
  );
  const { error: reversedLinesErr } = await supabase
    .from('journal_entry_lines')
    .insert(reversedLineInserts as any);
  if (reversedLinesErr) throw reversedLinesErr;

  // -- Phase 5: flip original transactions to VOID status ---------------
  // Phase 4.4: sign the status flip. We compute one signature over the
  // reversal JE id + the void status, then stamp it on each affected row.
  // The verifier reads each row and can reconstruct the same payload bytes.
  const voidSig = signer.sign(`void|${reversalJeId}|${p.date}`);

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
      ...voidSig,
    } as any)
    .in('id', voidedIds);
  if (voidErr) throw voidErr;

  // Phase 2 (external-ledger removal): the ledger reversing-posting block (~100 lines)
  // lived here. Postgres-side reversing journal_entries + reversed lines
  // already written earlier in this function are now the single source of
  // truth. No external-ledger dual-write required.

  // -- Phase 7: audit ---------------------------------------------------
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
