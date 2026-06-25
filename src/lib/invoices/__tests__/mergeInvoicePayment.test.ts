// @vitest-environment node
//
// Unit tests for mergeWithPlaceholder — Wave Pattern A merge.
//
// Covers:
//   1. Happy path: signs the merge, invokes the RPC, returns the row.
//   2. Amount mismatch > 0.5%: throws MergeAmountMismatchError without
//      hitting the RPC, so the caller can surface a confirmation.
//   3. Amount mismatch + confirmAmountMismatch=true: proceeds.
//   4. Idempotent re-run: RPC returns noop=true and we propagate it.
//   5. fetchPlaceholderPayments lookup helper: filters non-placeholder
//      rows and keys by invoice_id.
//   6. Signature unavailable (signMutation → null): throws clearly,
//      RPC never invoked.
//   7. Missing placeholder row: throws "not found".

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeRow {
  id: string;
  invoice_id: string;
  transaction_id: string;
  amount_applied: number;
  is_placeholder: boolean;
  applied_at?: string;
}

let phRows: FakeRow[] = [];
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
let rpcResponse: { data: unknown; error: unknown } = { data: null, error: null };

function makeSupabase() {
  return {
    from(table: string) {
      const filterEq: Record<string, unknown> = {};
      let filterIn: { col: string; values: unknown[] } | null = null;
      let mode: 'list' | 'maybeSingle' = 'list';

      const api = {
        select(_cols?: string) {
          return api;
        },
        eq(col: string, val: unknown) {
          filterEq[col] = val;
          return api;
        },
        in(col: string, vals: unknown[]) {
          filterIn = { col, values: vals };
          return api;
        },
        maybeSingle() {
          mode = 'maybeSingle';
          return run();
        },
        then(onFulfilled: (v: { data: unknown; error: null }) => unknown) {
          return run().then(onFulfilled);
        },
      };

      async function run(): Promise<{ data: unknown; error: null }> {
        if (table !== 'invoice_payments') return { data: null, error: null };
        const rows = phRows.filter((r) => {
          for (const [k, v] of Object.entries(filterEq)) {
            if ((r as any)[k] !== v) return false;
          }
          if (filterIn && !filterIn.values.includes((r as any)[filterIn.col])) return false;
          return true;
        });
        if (mode === 'maybeSingle') return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      }

      return api;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      return Promise.resolve(rpcResponse);
    },
  };
}

vi.mock('@/lib/supabase', () => ({
  get supabase() {
    return makeSupabase();
  },
}));

import {
  mergeWithPlaceholder,
  fetchPlaceholderPayments,
  MergeAmountMismatchError,
  MERGE_AMOUNT_TOLERANCE_PCT,
} from '../mergeInvoicePayment';

const ORG = 'org-1';
const loadOrgSigningKey = vi.fn(async (_orgId: string) => ({}));
const signMutation = vi.fn((_payload: Uint8Array, _orgId: string) => ({
  signature_b64: 'sig-merge',
  key_version: 3,
}));

beforeEach(() => {
  phRows = [];
  rpcCalls = [];
  rpcResponse = { data: null, error: null };
  loadOrgSigningKey.mockClear();
  signMutation.mockClear();
  signMutation.mockImplementation((_p, _o) => ({ signature_b64: 'sig-merge', key_version: 3 }));
});

describe('mergeWithPlaceholder', () => {
  it('happy path: signs + calls RPC + returns the row', async () => {
    phRows.push({
      id: 'ph-1',
      invoice_id: 'inv-1',
      transaction_id: 'tx-old',
      amount_applied: 100,
      is_placeholder: true,
    });
    rpcResponse = {
      data: [
        {
          payment_id: 'ph-1',
          invoice_id: 'inv-1',
          new_transaction_id: 'tx-new',
          superseded_transaction_id: 'tx-old',
          je_reversed_id: 'je-rev',
          je_posted_id: 'je-fresh',
          noop: false,
        },
      ],
      error: null,
    };

    const result = await mergeWithPlaceholder({
      placeholderPaymentId: 'ph-1',
      transactionId: 'tx-new',
      orgId: ORG,
      depositAmount: 100,
      loadOrgSigningKey,
      signMutation,
    });

    expect(loadOrgSigningKey).toHaveBeenCalledWith(ORG);
    expect(signMutation).toHaveBeenCalledTimes(1);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('merge_invoice_payment');
    expect(rpcCalls[0].args).toMatchObject({
      p_invoice_payment_id: 'ph-1',
      p_new_transaction_id: 'tx-new',
      p_signature_b64: 'sig-merge',
      p_signature_key_version: 3,
    });
    expect(result.noop).toBe(false);
    expect(result.supersededTransactionId).toBe('tx-old');
  });

  it('refuses when amount diverges > 0.5%', async () => {
    phRows.push({
      id: 'ph-2',
      invoice_id: 'inv-2',
      transaction_id: 'tx-old',
      amount_applied: 100,
      is_placeholder: true,
    });

    await expect(
      mergeWithPlaceholder({
        placeholderPaymentId: 'ph-2',
        transactionId: 'tx-new',
        orgId: ORG,
        depositAmount: 110, // 10% off
        loadOrgSigningKey,
        signMutation,
      }),
    ).rejects.toBeInstanceOf(MergeAmountMismatchError);

    expect(rpcCalls).toHaveLength(0);
    expect(signMutation).not.toHaveBeenCalled();
  });

  it('proceeds with confirmAmountMismatch=true', async () => {
    phRows.push({
      id: 'ph-3',
      invoice_id: 'inv-3',
      transaction_id: 'tx-old',
      amount_applied: 100,
      is_placeholder: true,
    });
    rpcResponse = {
      data: [
        {
          payment_id: 'ph-3',
          invoice_id: 'inv-3',
          new_transaction_id: 'tx-new',
          superseded_transaction_id: 'tx-old',
          je_reversed_id: null,
          je_posted_id: null,
          noop: false,
        },
      ],
      error: null,
    };

    const result = await mergeWithPlaceholder({
      placeholderPaymentId: 'ph-3',
      transactionId: 'tx-new',
      orgId: ORG,
      depositAmount: 110,
      confirmAmountMismatch: true,
      loadOrgSigningKey,
      signMutation,
    });

    expect(rpcCalls).toHaveLength(1);
    expect(result.paymentId).toBe('ph-3');
  });

  it('idempotent re-run: RPC returns noop=true and we propagate it', async () => {
    // Row already merged: not a placeholder anymore.
    phRows.push({
      id: 'ph-4',
      invoice_id: 'inv-4',
      transaction_id: 'tx-new',
      amount_applied: 100,
      is_placeholder: false,
    });
    rpcResponse = {
      data: [
        {
          payment_id: 'ph-4',
          invoice_id: 'inv-4',
          new_transaction_id: 'tx-new',
          superseded_transaction_id: null,
          je_reversed_id: null,
          je_posted_id: null,
          noop: true,
        },
      ],
      error: null,
    };

    const result = await mergeWithPlaceholder({
      placeholderPaymentId: 'ph-4',
      transactionId: 'tx-new',
      orgId: ORG,
      // No depositAmount → tolerance guard is skipped, mirrors the
      // panel's behavior when the user re-clicks Merge after success.
      loadOrgSigningKey,
      signMutation,
    });

    expect(result.noop).toBe(true);
    expect(rpcCalls).toHaveLength(1);
  });

  it('throws clearly when no signing key is available', async () => {
    phRows.push({
      id: 'ph-5',
      invoice_id: 'inv-5',
      transaction_id: 'tx-old',
      amount_applied: 100,
      is_placeholder: true,
    });
    signMutation.mockImplementationOnce(() => null);

    await expect(
      mergeWithPlaceholder({
        placeholderPaymentId: 'ph-5',
        transactionId: 'tx-new',
        orgId: ORG,
        depositAmount: 100,
        loadOrgSigningKey,
        signMutation,
      }),
    ).rejects.toThrow(/signing key/i);
    expect(rpcCalls).toHaveLength(0);
  });

  it('throws when placeholder row is missing', async () => {
    await expect(
      mergeWithPlaceholder({
        placeholderPaymentId: 'does-not-exist',
        transactionId: 'tx-new',
        orgId: ORG,
        loadOrgSigningKey,
        signMutation,
      }),
    ).rejects.toThrow(/not found/i);
  });
});

describe('fetchPlaceholderPayments', () => {
  it('returns only placeholder rows keyed by invoice_id', async () => {
    phRows.push(
      {
        id: 'a',
        invoice_id: 'inv-a',
        transaction_id: 'tx-a',
        amount_applied: 50,
        is_placeholder: true,
        applied_at: '2026-05-01',
      },
      {
        id: 'b',
        invoice_id: 'inv-b',
        transaction_id: 'tx-b',
        amount_applied: 60,
        is_placeholder: false,
        applied_at: '2026-05-02',
      },
      {
        id: 'c',
        invoice_id: 'inv-c',
        transaction_id: 'tx-c',
        amount_applied: 70,
        is_placeholder: true,
        applied_at: '2026-05-03',
      },
    );

    const map = await fetchPlaceholderPayments(['inv-a', 'inv-b', 'inv-c']);
    expect(map.size).toBe(2);
    expect(map.get('inv-a')?.id).toBe('a');
    expect(map.get('inv-c')?.id).toBe('c');
    expect(map.has('inv-b')).toBe(false);
  });

  it('returns empty map when no invoice ids given', async () => {
    const map = await fetchPlaceholderPayments([]);
    expect(map.size).toBe(0);
  });
});

describe('MERGE_AMOUNT_TOLERANCE_PCT', () => {
  it('is 0.5% per the design spec', () => {
    expect(MERGE_AMOUNT_TOLERANCE_PCT).toBe(0.005);
  });
});
