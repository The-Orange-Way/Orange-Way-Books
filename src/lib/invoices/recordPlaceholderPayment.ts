/**
 * recordPlaceholderPayment, manual "Mark invoice paid" flow.
 *
 * When the operator marks an invoice paid BEFORE the matching bank
 * deposit lands in OWB (a/k/a Wave "Add a payment"), we record a
 * placeholder invoice_payments row. The row is anchored to a synthetic
 * `transactions` placeholder (an in-band wallet movement with no real
 * bank import behind it) so:
 *
 *   1. The invoice's status flips PARTIAL/PAID immediately and JE
 *      posts (Dr Wallet / Cr A/R) via the existing apply_invoice_payment
 *      RPC, bookkeeping is correct from the moment the operator says
 *      "I got paid".
 *   2. When the real deposit eventually lands, the InvoiceMatchPanel
 *      the merge helper recognizes the placeholder via `is_placeholder=TRUE`
 *      and offers the "Merge" action that folds the placeholder into
 *      the real deposit (see `mergeWithPlaceholder`).
 *
 * Without this helper, the merge surface has nothing to merge with
 *, placeholders never exist. This wires the producer end.
 *
 * ZKA invariants:
 *   - Amount + memo encrypted CLIENT-side before reaching Supabase.
 *     The encrypted_amount column on transactions is canonical; the
 *     plaintext `amount` mirror is what the server uses for SUM(),
 *     matching every other write path in OWB.
 *   - The invoice_payments row carries an encrypted_amount_applied
 *     ciphertext alongside the coarse plaintext.
 *   - Phase 4.4 signing-key signature attached on the update that flags the
 *     row as placeholder, binding the mutation to a writer-key holder.
 *   - apply_invoice_payment RPC handles the JE post + status flip
 *     server-side, gated by org membership + transaction same-org
 *     check, so a confused-deputy cross-org write is impossible.
 *
 * Idempotency:
 *   - Re-clicking "Mark paid" with the same (invoice, wallet, date,
 *     amount) returns the existing placeholder row id rather than
 *     spawning a duplicate placeholder transaction. The match is
 *     done CLIENT-side on the decrypted amount because the server
 *     can't compare encrypted ciphertexts.
 */

import { supabase } from '@/lib/supabase';
import { encryptNumber, encryptTransaction } from '@/lib/crypto-fields';

export type EncryptTextFn = (plaintext: string) => Promise<string>;
export type DecryptTextFn = (ciphertext: string) => Promise<string>;

export type SignMutationFn = (
  payloadBytes: Uint8Array,
  orgId: string,
) => { signature_b64: string; key_version: number } | null;

export type LoadOrgSigningKeyFn = (orgId: string) => Promise<unknown>;

export interface RecordPlaceholderPaymentParams {
  invoiceId: string;
  /** Plaintext amount the user is recording (must be > 0). */
  amount: number;
  /** Wallet that "received" the payment (drives JE Dr-account). */
  walletId: string;
  /** Wallet's external_account_id, used to label the synthetic tx. */
  walletLegacyAccountId: string | null;
  /** Currency / asset symbol (BTC, USD, ...). */
  asset: string;
  /** ISO date string (yyyy-MM-dd) the user recorded the payment for. */
  appliedAt: string;
  /** Optional memo, encrypted. */
  memo: string | null;
  orgId: string;
  /** Plaintext invoice total, used for amount > remaining guard. */
  invoiceAmount: number;
  /** Optional invoice number for the synthetic transaction memo. */
  invoiceNumber?: string;
  encryptText: EncryptTextFn;
  decryptText: DecryptTextFn;
  loadOrgSigningKey: LoadOrgSigningKeyFn;
  signMutation: SignMutationFn;
}

export interface RecordPlaceholderResult {
  /** The invoice_payments row id (placeholder, is_placeholder=TRUE). */
  paymentId: string;
  /** The synthetic transactions row id created (or reused on idempotent). */
  transactionId: string;
  /** Invoice status after applying (PARTIAL or PAID). */
  invoiceStatus: string;
  /** True if a journal entry was posted (A/R configured). */
  jePosted: boolean;
  /** True on idempotent re-click, caller can show a softer toast. */
  reused: boolean;
  /** True when A/R is unconfigured and the JE didn't post. */
  warnArMissing: boolean;
}

export class ArNotConfiguredWarning extends Error {
  constructor() {
    super(
      'Payment recorded, but no Accounts Receivable account is configured. ' +
        'Configure A/R in Settings so the JE can post.',
    );
    this.name = 'ArNotConfiguredWarning';
  }
}

export class AmountExceedsRemainingError extends Error {
  readonly remaining: number;
  constructor(remaining: number) {
    super(
      `Amount exceeds the invoice's remaining balance (${remaining.toFixed(2)}). ` +
        `Lower the amount or apply against a different invoice.`,
    );
    this.name = 'AmountExceedsRemainingError';
    this.remaining = remaining;
  }
}

/**
 * Idempotency tolerance: re-clicks within this ratio of the same
 * (invoice, wallet, date) are considered the same payment. We don't
 * compare ciphertexts (each encrypt produces a fresh nonce) so we
 * decrypt the candidate rows and compare plaintext amounts here.
 */
const IDEMPOTENT_AMOUNT_EPSILON = 0.0001;

export async function recordPlaceholderPayment(
  p: RecordPlaceholderPaymentParams,
): Promise<RecordPlaceholderResult> {
  if (!p.orgId) throw new Error('orgId required');
  if (!p.invoiceId) throw new Error('invoiceId required');
  if (!p.walletId) throw new Error('walletId required');
  if (!(Number.isFinite(p.amount) && p.amount > 0)) {
    throw new Error('Amount must be a positive number');
  }
  if (!p.appliedAt) throw new Error('appliedAt required');

  // 1. Pull existing invoice_payments rows. We need this for BOTH the
  //    idempotency check (return existing placeholder on rapid
  //    double-click) AND the remaining-balance guard. Run idempotency
  //    FIRST so a duplicate click on a fully-paid invoice doesn't
  //    falsely look like "amount > remaining".
  const { data: existingRows, error: sumErr } = await (supabase as any)
    .from('invoice_payments')
    .select('id, transaction_id, amount_applied, applied_at, is_placeholder')
    .eq('invoice_id', p.invoiceId);
  if (sumErr) throw sumErr;

  // 2. Idempotent short-circuit: same (invoice, wallet via tx, date,
  //    amount) → return existing placeholder. We match on the existing
  //    invoice_payments row's transaction (which carries account_id +
  //    date) so a rapid double-click doesn't spawn a duplicate
  //    synthetic transaction.
  const candidateIds = ((existingRows ?? []) as any[])
    .filter((r) => r.is_placeholder === true)
    .map((r) => r.transaction_id);
  if (candidateIds.length > 0) {
    const { data: txCandidates } = await (supabase as any)
      .from('transactions')
      .select('id, account_id, date')
      .in('id', candidateIds);
    const match = ((txCandidates ?? []) as any[]).find((t) => {
      if (t.account_id !== p.walletId) return false;
      if (t.date !== p.appliedAt) return false;
      const ipRow = (existingRows as any[]).find((r) => r.transaction_id === t.id);
      if (!ipRow) return false;
      return Math.abs(Number(ipRow.amount_applied ?? 0) - p.amount) <= IDEMPOTENT_AMOUNT_EPSILON;
    });
    if (match) {
      const ipRow = (existingRows as any[]).find((r) => r.transaction_id === match.id);
      // Pull invoice status so the caller can re-render correctly.
      const { data: invRow } = await (supabase as any)
        .from('invoices')
        .select('status')
        .eq('id', p.invoiceId)
        .maybeSingle();
      return {
        paymentId: ipRow.id,
        transactionId: match.id,
        invoiceStatus: (invRow as any)?.status ?? 'PARTIAL',
        jePosted: false,
        reused: true,
        warnArMissing: false,
      };
    }
  }

  // 2b. Remaining-balance guard. Runs AFTER the idempotency
  //     short-circuit so a duplicate click on an already-paid invoice
  //     resolves cleanly. The plaintext amount_applied mirror is the
  //     server's source of truth for SUM() (same column the RPC uses).
  const sumApplied = ((existingRows ?? []) as Array<{ amount_applied: number }>).reduce(
    (acc, r) => acc + Number(r.amount_applied ?? 0),
    0,
  );
  const remaining = Math.max(0, p.invoiceAmount - sumApplied);
  if (p.amount > remaining + 0.0001) {
    throw new AmountExceedsRemainingError(remaining);
  }

  // 3. Phase 4.4 signing-key signature. Sign before any write so a missing key
  //    aborts cleanly without partial state. Payload binds (org,
  //    invoice, wallet, date, amount) so the attestation can be
  //    verified by replaying canonical bytes.
  await p.loadOrgSigningKey(p.orgId);
  const payloadStr =
    `${p.orgId}|placeholder|${p.invoiceId}|${p.walletId}|` +
    `${p.appliedAt}|${p.amount.toFixed(8)}`;
  const sig = p.signMutation(new TextEncoder().encode(payloadStr), p.orgId);
  if (!sig) {
    throw new Error(
      'No signing key available for this org. ' +
        'Refresh the page; if it persists contact support.',
    );
  }

  // 4. Get the auth user, required by invoice_payments RLS
  //    (applied_by = auth.uid()) AND by the apply_invoice_payment RPC.
  const { data: userRes, error: userErr } = await supabase.auth.getUser();
  if (userErr) throw userErr;
  const userId = userRes?.user?.id;
  if (!userId) throw new Error('Not authenticated');

  // 5. Create the synthetic placeholder transaction. ZKA L2, amount,
  //    memo, asset, type all encrypted. The plaintext `amount` mirror
  //    is what the server can SUM(); same shape as imported tx.
  const memoText = p.invoiceNumber
    ? `Placeholder, invoice ${p.invoiceNumber}`
    : 'Placeholder, invoice payment';
  const txEnc = await encryptTransaction(
    {
      memo: memoText,
      amount: p.amount,
      usd_value: null,
      exchange_rate: null,
      asset: p.asset,
      type: 'income',
      status: 'PLACEHOLDER',
      cleared_status: 'NOT_CLEARED',
    },
    p.encryptText,
  );

  const txInsert: any = {
    org_id: p.orgId,
    account_id: p.walletId,
    type: txEnc.type,
    asset: txEnc.asset,
    amount: p.amount, // plaintext mirror (matches imported-tx shape)
    usd_value: null,
    date: p.appliedAt,
    memo: txEnc.memo,
    exchange_rate: null,
    encrypted_amount: txEnc.encrypted_amount,
    encrypted_usd_value: txEnc.encrypted_usd_value,
    encrypted_exchange_rate: txEnc.encrypted_exchange_rate,
    status: txEnc.status,
    cleared_status: txEnc.cleared_status,
    key_version: txEnc.key_version,
  };

  const { data: txRow, error: txErr } = await (supabase as any)
    .from('transactions')
    .insert(txInsert)
    .select('id')
    .single();
  if (txErr) throw txErr;
  const transactionId = (txRow as any).id;

  // 6. Encrypt amount_applied + memo for the invoice_payments row,
  //    then call the apply_invoice_payment RPC. The RPC inserts the
  //    row, recomputes invoice status, and (if A/R configured) posts
  //    the Dr Wallet / Cr A/R JE. We capture je_posted so we can
  //    surface the "configure A/R" warning on miss.
  const encryptedApplied = await encryptNumber(p.amount, p.encryptText);
  const encryptedMemo = p.memo ? await p.encryptText(p.memo) : null;

  const { data: applyRes, error: applyErr } = await (supabase as any).rpc('apply_invoice_payment', {
    p_invoice_id: p.invoiceId,
    p_transaction_id: transactionId,
    p_amount_applied: p.amount,
    p_encrypted_amount_applied: encryptedApplied,
    p_applied_rate: null,
    p_encrypted_notes: encryptedMemo,
  });
  if (applyErr) {
    // Best-effort cleanup: drop the orphaned synthetic tx so a retry
    // doesn't leak a phantom transaction in the wallet. RLS scopes
    // delete to org members.
    await (supabase as any).from('transactions').delete().eq('id', transactionId);
    throw applyErr;
  }
  const applyRow = Array.isArray(applyRes) ? applyRes[0] : applyRes;
  if (!applyRow?.payment_id) {
    throw new Error('apply_invoice_payment returned no payment_id');
  }

  // 7. Flag the row as placeholder + stamp signing-key signature. We do this as
  //    a follow-up UPDATE because the RPC predates the merge migration
  //    and doesn't accept the placeholder flag. RLS allows org members
  //    to UPDATE their org's invoice_payments rows.
  const { error: flagErr } = await (supabase as any)
    .from('invoice_payments')
    .update({
      is_placeholder: true,
      signature_b64: sig.signature_b64,
      signature_key_version: sig.key_version,
    })
    .eq('id', applyRow.payment_id);
  if (flagErr) throw flagErr;

  return {
    paymentId: applyRow.payment_id,
    transactionId,
    invoiceStatus: String(applyRow.invoice_status ?? 'PARTIAL'),
    jePosted: applyRow.je_posted === true,
    reused: false,
    warnArMissing: applyRow.je_posted !== true,
  };
}
