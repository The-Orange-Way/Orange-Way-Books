// @vitest-environment node
//
// End-to-end integration spec — recordPlaceholderPayment (this PR) feeds
// the merge_invoice_payment RPC consumed by mergeWithPlaceholder (PR
// #88). Without the producer in this PR, the merge surface is dead
// code. This test threads both helpers through the same fake supabase
// store to prove the full lifecycle.
//
// Flow exercised:
//   1. Create a Sent invoice (seeded).
//   2. Operator clicks "Mark paid" → recordPlaceholderPayment inserts a
//      synthetic tx + is_placeholder=TRUE invoice_payments row.
//   3. Bank import lands a real deposit → mergeWithPlaceholder is
//      called with the placeholder + the real deposit's transaction_id.
//   4. The placeholder row is superseded: transaction_id flips to the
//      real one, is_placeholder=FALSE, superseded_by_transaction_id
//      carries the old (synthetic) transaction id.
//
// The merge_invoice_payment server logic is exercised in a separate
// SQL test suite; here we stub the RPC to match its documented
// behavior (idempotent supersede + flag flip), so we cover the client
// contract end-to-end without spinning up Postgres.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeIp {
  id: string;
  invoice_id: string;
  transaction_id: string;
  amount_applied: number;
  is_placeholder?: boolean;
  superseded_by_transaction_id?: string | null;
  superseded_at?: string | null;
  signature_b64?: string | null;
  signature_key_version?: number | null;
  applied_at?: string;
}

interface FakeTx {
  id: string;
  org_id: string;
  account_id: string;
  amount: number;
  date: string;
}

interface FakeInvoice {
  id: string;
  org_id: string;
  amount: number;
  status: string;
}

let store: {
  invoice_payments: FakeIp[];
  transactions: FakeTx[];
  invoices: FakeInvoice[];
};

let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
let idCounter = 0;
const nextId = (p: string) => `${p}-${++idCounter}`;
let authUserId: string | null = 'user-1';

function makeSupabase() {
  return {
    auth: {
      getUser: async () => ({
        data: { user: authUserId ? { id: authUserId } : null },
        error: null,
      }),
    },
    from(table: string) {
      let filterEq: Record<string, unknown> = {};
      let filterIn: { col: string; values: unknown[] } | null = null;
      let mode: 'list' | 'maybeSingle' | 'single' = 'list';
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let insertRow: any = null;
      let updatePatch: any = null;

      const t = table as keyof typeof store;
      const api: any = {
        select() {
          return api;
        },
        eq(c: string, v: unknown) {
          filterEq[c] = v;
          return api;
        },
        in(c: string, v: unknown[]) {
          filterIn = { col: c, values: v };
          return api;
        },
        maybeSingle() {
          mode = 'maybeSingle';
          return runRead();
        },
        single() {
          mode = 'single';
          return runWriteOrRead();
        },
        insert(r: any) {
          op = 'insert';
          insertRow = r;
          return api;
        },
        update(p: any) {
          op = 'update';
          updatePatch = p;
          return api;
        },
        delete() {
          op = 'delete';
          return runDelete();
        },
        then(onFulfilled: (v: any) => unknown) {
          if (op === 'insert' && mode === 'list') return runInsert().then(onFulfilled);
          if (op === 'update') return runUpdate().then(onFulfilled);
          if (op === 'delete') return runDelete().then(onFulfilled);
          return runRead().then(onFulfilled);
        },
      };

      function matches(r: any) {
        for (const [k, v] of Object.entries(filterEq)) {
          if ((r as any)[k] !== v) return false;
        }
        if (filterIn && !filterIn.values.includes((r as any)[filterIn.col])) return false;
        return true;
      }
      async function runRead() {
        const rows = (store[t] as any[]).filter(matches);
        if (mode === 'maybeSingle' || mode === 'single') {
          return { data: rows[0] ?? null, error: null };
        }
        return { data: rows, error: null };
      }
      async function runInsert() {
        const row = { id: insertRow.id ?? nextId(t), ...insertRow };
        (store[t] as any[]).push(row);
        return { data: mode === 'single' ? row : [row], error: null };
      }
      async function runWriteOrRead() {
        if (op === 'insert') return runInsert();
        return runRead();
      }
      async function runUpdate() {
        const rows = (store[t] as any[]).filter(matches);
        for (const r of rows) Object.assign(r, updatePatch);
        return { data: rows, error: null };
      }
      async function runDelete() {
        store[t] = (store[t] as any[]).filter((r) => !matches(r)) as any;
        return { data: null, error: null };
      }
      return api;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      if (fn === 'apply_invoice_payment') {
        const ipId = nextId('ip');
        store.invoice_payments.push({
          id: ipId,
          invoice_id: args.p_invoice_id as string,
          transaction_id: args.p_transaction_id as string,
          amount_applied: Number(args.p_amount_applied),
          is_placeholder: false,
        });
        const inv = store.invoices.find((i) => i.id === args.p_invoice_id);
        const sum = store.invoice_payments
          .filter((r) => r.invoice_id === args.p_invoice_id)
          .reduce((a, r) => a + r.amount_applied, 0);
        if (inv) inv.status = sum >= inv.amount ? 'PAID' : 'PARTIAL';
        return Promise.resolve({
          data: [
            {
              payment_id: ipId,
              invoice_status: inv?.status ?? 'PARTIAL',
              total_applied: sum,
              invoice_amount: inv?.amount ?? 0,
              je_posted: true,
              je_id: 'je-x',
            },
          ],
          error: null,
        });
      }
      if (fn === 'merge_invoice_payment') {
        // Mirrors the server RPC: idempotent supersede.
        const ip = store.invoice_payments.find((r) => r.id === args.p_invoice_payment_id);
        if (!ip) return Promise.resolve({ data: null, error: { message: 'not found' } });
        if (ip.transaction_id === args.p_new_transaction_id && ip.is_placeholder === false) {
          return Promise.resolve({
            data: [
              {
                payment_id: ip.id,
                invoice_id: ip.invoice_id,
                new_transaction_id: args.p_new_transaction_id,
                superseded_transaction_id: null,
                je_reversed_id: null,
                je_posted_id: null,
                noop: true,
              },
            ],
            error: null,
          });
        }
        const oldTx = ip.transaction_id;
        ip.transaction_id = args.p_new_transaction_id as string;
        ip.superseded_by_transaction_id = oldTx;
        ip.superseded_at = new Date().toISOString();
        ip.is_placeholder = false;
        ip.signature_b64 = args.p_signature_b64 as string;
        ip.signature_key_version = args.p_signature_key_version as number;
        return Promise.resolve({
          data: [
            {
              payment_id: ip.id,
              invoice_id: ip.invoice_id,
              new_transaction_id: args.p_new_transaction_id,
              superseded_transaction_id: oldTx,
              je_reversed_id: 'je-rev',
              je_posted_id: 'je-fresh',
              noop: false,
            },
          ],
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
}

vi.mock('@/lib/supabase', () => ({
  get supabase() {
    return makeSupabase();
  },
}));

vi.mock('@/lib/crypto-fields', async () => {
  const real = await vi.importActual<typeof import('@/lib/crypto-fields')>('@/lib/crypto-fields');
  return {
    ...real,
    encryptTransaction: vi.fn(async (fields: any) => ({
      memo: `enc:${fields.memo}`,
      encrypted_amount: `enc:${fields.amount}`,
      encrypted_usd_value: null,
      encrypted_exchange_rate: null,
      asset: `enc:${fields.asset}`,
      type: `enc:${fields.type}`,
      status: `enc:${fields.status}`,
      cleared_status: `enc:${fields.cleared_status}`,
      amount: 0,
      usd_value: null,
      exchange_rate: null,
      key_version: 2,
    })),
    encryptNumber: vi.fn(async (v: number | null) => (v == null ? null : `enc:n:${v}`)),
  };
});

import { recordPlaceholderPayment } from '../recordPlaceholderPayment';
import { mergeWithPlaceholder } from '../mergeInvoicePayment';

const ORG = 'org-1';
const INV = 'inv-1';
const WALLET = 'wallet-1';

const ctx = {
  encryptText: vi.fn(async (s: string) => `enc:${s}`),
  decryptText: vi.fn(async (s: string) => s.replace(/^enc:/, '')),
  loadOrgSigningKey: vi.fn(async (_o: string) => ({})),
  signMutation: vi.fn(() => ({ signature_b64: 'sig', key_version: 3 })),
};

beforeEach(() => {
  store = {
    invoice_payments: [],
    transactions: [],
    invoices: [{ id: INV, org_id: ORG, amount: 100, status: 'SENT' }],
  };
  rpcCalls = [];
  idCounter = 0;
  authUserId = 'user-1';
  ctx.encryptText.mockClear();
  ctx.decryptText.mockClear();
  ctx.loadOrgSigningKey.mockClear();
  ctx.signMutation.mockClear();
  ctx.signMutation.mockImplementation(() => ({ signature_b64: 'sig', key_version: 3 }));
});

describe('record + merge integration', () => {
  it('mark paid → import deposit → merge: full lifecycle ends in one canonical row', async () => {
    // 1. Mark paid creates the placeholder.
    const recorded = await recordPlaceholderPayment({
      invoiceId: INV,
      amount: 100,
      walletId: WALLET,
      walletLegacyAccountId: 'legacy-w-1',
      asset: 'USD',
      appliedAt: '2026-05-20',
      memo: 'Customer confirmed by email',
      orgId: ORG,
      invoiceAmount: 100,
      invoiceNumber: 'INV-001',
      encryptText: ctx.encryptText,
      decryptText: ctx.decryptText,
      loadOrgSigningKey: ctx.loadOrgSigningKey,
      signMutation: ctx.signMutation,
    });
    expect(recorded.reused).toBe(false);
    expect(store.invoice_payments).toHaveLength(1);
    expect(store.invoice_payments[0].is_placeholder).toBe(true);
    expect(store.invoices[0].status).toBe('PAID');

    const syntheticTxId = store.transactions[0].id;

    // 2. Bank import lands the real deposit. We just shove a row into
    //    the fake store — the real import path is out of scope.
    const realTxId = 'tx-bank-import';
    store.transactions.push({
      id: realTxId,
      org_id: ORG,
      account_id: WALLET,
      amount: 100,
      date: '2026-05-21',
    });

    // 3. Merge UI fires.
    const merged = await mergeWithPlaceholder({
      placeholderPaymentId: recorded.paymentId,
      transactionId: realTxId,
      orgId: ORG,
      depositAmount: 100,
      loadOrgSigningKey: ctx.loadOrgSigningKey,
      signMutation: ctx.signMutation,
    });

    expect(merged.noop).toBe(false);
    expect(merged.supersededTransactionId).toBe(syntheticTxId);

    // 4. The same invoice_payments row now points at the real tx,
    //    is_placeholder=FALSE, and remembers the synthetic tx for audit.
    expect(store.invoice_payments).toHaveLength(1);
    const ip = store.invoice_payments[0];
    expect(ip.transaction_id).toBe(realTxId);
    expect(ip.is_placeholder).toBe(false);
    expect(ip.superseded_by_transaction_id).toBe(syntheticTxId);
    expect(ip.signature_b64).toBe('sig');

    // 5. Re-running merge is a no-op.
    const again = await mergeWithPlaceholder({
      placeholderPaymentId: recorded.paymentId,
      transactionId: realTxId,
      orgId: ORG,
      loadOrgSigningKey: ctx.loadOrgSigningKey,
      signMutation: ctx.signMutation,
    });
    expect(again.noop).toBe(true);
  });
});
