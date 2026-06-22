/**
 * mergeInvoicePayment — Wave Pattern A merge.
 *
 * When the InvoiceMatchPanel ranks a new bank-import / wallet-sync
 * deposit against open invoices, the invoice may already have a
 * "placeholder" invoice_payments row created by the manual "Mark paid"
 * flow. Applying as a fresh payment would double-count. Merging folds
 * the placeholder + real deposit into one canonical record.
 *
 * The actual SQL work runs server-side in merge_invoice_payment() —
 * see `supabase/migrations/20260523000000_invoice_payment_merge.sql`.
 * This module is the client wrapper: it
 *
 *   1. Pulls the placeholder row to compare amounts client-side, since
 *      the canonical amount lives in the encrypted column and the
 *      server only sees a coarse plaintext mirror.
 *   2. Refuses to merge when the new deposit's amount disagrees with
 *      the placeholder by more than `MERGE_AMOUNT_TOLERANCE_PCT` (0.5%
 *      by default) — the caller is expected to surface a confirmation
 *      dialog and call again with `confirmAmountMismatch: true`.
 *   3. Signs the merge payload with the org mutation signing key
 *      so the server can record an attestation alongside the row.
 *   4. Calls the RPC. Idempotent: a repeat call after a successful
 *      merge returns `noop: true`.
 */

import { supabase } from '@/lib/supabase';

export const MERGE_AMOUNT_TOLERANCE_PCT = 0.005;

export type SignMutationFn = (
  payloadBytes: Uint8Array,
  orgId: string,
) => { signature_b64: string; key_version: number } | null;

export type LoadOrgSigningKeyFn = (orgId: string) => Promise<unknown>;

export interface MergeWithPlaceholderParams {
  /** UUID of the placeholder invoice_payments row to fold in. */
  placeholderPaymentId: string;
  /** UUID of the real (bank-import / wallet-sync) transaction. */
  transactionId: string;
  /** org_id of the invoice — passed through to mutation signing. */
  orgId: string;
  /**
   * Optional. If provided, used as the deposit's amount for the
   * amount-mismatch tolerance check against the placeholder's
   * recorded amount_applied. When omitted we skip the client-side
   * check and rely on the user already having confirmed.
   */
  depositAmount?: number;
  /**
   * If true, skip the amount-mismatch guard. Callers pass this only
   * after the user dismissed a confirmation dialog.
   */
  confirmAmountMismatch?: boolean;
  loadOrgSigningKey: LoadOrgSigningKeyFn;
  signMutation: SignMutationFn;
}

export interface MergeResult {
  paymentId: string;
  invoiceId: string;
  newTransactionId: string;
  supersededTransactionId: string | null;
  jeReversedId: string | null;
  jePostedId: string | null;
  /** True when the row already pointed at the new tx — re-run no-op. */
  noop: boolean;
}

export class MergeAmountMismatchError extends Error {
  readonly placeholderAmount: number;
  readonly depositAmount: number;
  readonly tolerancePct: number;
  constructor(placeholderAmount: number, depositAmount: number, tolerancePct: number) {
    super(
      `Deposit amount ${depositAmount} differs from placeholder ` +
        `${placeholderAmount} by more than ${(tolerancePct * 100).toFixed(2)}%. ` +
        `Confirm to merge anyway.`,
    );
    this.name = 'MergeAmountMismatchError';
    this.placeholderAmount = placeholderAmount;
    this.depositAmount = depositAmount;
    this.tolerancePct = tolerancePct;
  }
}

/**
 * Merge a placeholder invoice payment with a real deposit transaction.
 * Returns the RPC result on success; throws MergeAmountMismatchError
 * when the deposit and placeholder amounts diverge beyond tolerance.
 */
export async function mergeWithPlaceholder(p: MergeWithPlaceholderParams): Promise<MergeResult> {
  // 1. Load the placeholder row (we need invoice_id + amount_applied
  //    to (a) decide tolerance and (b) build the signing payload).
  const { data: placeholderRow, error: phErr } = await (supabase as any)
    .from('invoice_payments')
    .select('id, invoice_id, transaction_id, amount_applied, is_placeholder')
    .eq('id', p.placeholderPaymentId)
    .maybeSingle();
  if (phErr) throw phErr;
  if (!placeholderRow) {
    throw new Error('Placeholder invoice payment not found.');
  }

  // 2. Amount-tolerance guard, when the caller passed a deposit amount.
  if (
    typeof p.depositAmount === 'number' &&
    !p.confirmAmountMismatch &&
    placeholderRow.is_placeholder !== false
  ) {
    const placeholderAmount = Number(placeholderRow.amount_applied ?? 0);
    if (placeholderAmount > 0) {
      const ratio = Math.abs(p.depositAmount - placeholderAmount) / placeholderAmount;
      if (ratio > MERGE_AMOUNT_TOLERANCE_PCT) {
        throw new MergeAmountMismatchError(
          placeholderAmount,
          p.depositAmount,
          MERGE_AMOUNT_TOLERANCE_PCT,
        );
      }
    }
  }

  // 3. Phase 4.4 signing-key signature. Payload = canonical, deterministic
  //    bytes binding the merge to (org, invoice, old tx, new tx).
  await p.loadOrgSigningKey(p.orgId);
  const payloadStr =
    `${p.orgId}|merge|${placeholderRow.invoice_id}|` +
    `${placeholderRow.transaction_id}|${p.transactionId}`;
  const sig = p.signMutation(new TextEncoder().encode(payloadStr), p.orgId);
  if (!sig) {
    throw new Error(
      'No signing key available for this org. ' +
        'Refresh the page; if it persists contact support.',
    );
  }

  // 4. Server-side merge.
  const { data, error } = await (supabase as any).rpc('merge_invoice_payment', {
    p_invoice_payment_id: p.placeholderPaymentId,
    p_new_transaction_id: p.transactionId,
    p_signature_b64: sig.signature_b64,
    p_signature_key_version: sig.key_version,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    throw new Error('Merge RPC returned no row.');
  }

  return {
    paymentId: row.payment_id,
    invoiceId: row.invoice_id,
    newTransactionId: row.new_transaction_id,
    supersededTransactionId: row.superseded_transaction_id ?? null,
    jeReversedId: row.je_reversed_id ?? null,
    jePostedId: row.je_posted_id ?? null,
    noop: row.noop === true,
  };
}

/**
 * Discover open placeholder payments for a list of invoice ids, used
 * by the InvoiceMatchPanel to decide whether to surface the "Merge"
 * action per candidate. Returns a map of invoice_id → placeholder row
 * (when present). Most invoices have no placeholder so the map is
 * usually small.
 */
export interface PlaceholderInfo {
  id: string;
  invoice_id: string;
  transaction_id: string;
  amount_applied: number;
  applied_at: string;
}

export async function fetchPlaceholderPayments(
  invoiceIds: string[],
): Promise<Map<string, PlaceholderInfo>> {
  const result = new Map<string, PlaceholderInfo>();
  if (invoiceIds.length === 0) return result;
  const { data, error } = await (supabase as any)
    .from('invoice_payments')
    .select('id, invoice_id, transaction_id, amount_applied, applied_at, is_placeholder')
    .in('invoice_id', invoiceIds)
    .eq('is_placeholder', true);
  if (error) {
    console.warn('[merge] placeholder fetch failed', error);
    return result;
  }
  for (const row of (data ?? []) as any[]) {
    result.set(row.invoice_id, {
      id: row.id,
      invoice_id: row.invoice_id,
      transaction_id: row.transaction_id,
      amount_applied: Number(row.amount_applied ?? 0),
      applied_at: row.applied_at,
    });
  }
  return result;
}
