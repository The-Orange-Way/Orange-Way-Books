// @vitest-environment node
//
// Unit tests for recordPlaceholderPayment — the producer end of the placeholder-merge
// Wave Pattern A merge flow.
//
// Covers:
//   1. Happy path: signs the mutation, inserts a synthetic transaction,
//      calls apply_invoice_payment, then UPDATEs the resulting row to
//      flag is_placeholder=TRUE + carry the signing key signature.
//   2. Missing A/R configuration: surfaces warnArMissing=true so the
//      caller can toast a "configure A/R" hint, but the placeholder
//      row still gets created.
//   3. mutation signing returns null → throws and never writes anything
//      (defense-in-depth alongside the RLS / RPC checks).
//   4. Idempotent double-click: re-calling with the same
//      (invoice, wallet, date, amount) returns the existing placeholder
//      row id and does NOT spawn a second synthetic transaction.
//   5. Amount > remaining: refuses with AmountExceedsRemainingError
//      before any write.
//
// End-to-end integration with mergeWithPlaceholder is exercised
// in a separate spec (recordAndMerge.test.ts) that wires the same fake
// supabase client through both helpers.

import { beforeEach, describe, expect, it, vi } from 'vitest';

type TableName = 'invoice_payments' | 'transactions' | 'invoices';

interface FakeIp {
  id: string;
  invoice_id: string;
  transaction_id: string;
  amount_applied: number;
  applied_at?: string;
  is_placeholder?: boolean;
  signature_b64?: string | null;
  signature_key_version?: number | null;
}

interface FakeTx {
  id: string;
  org_id: string;
  account_id: string;
  amount: number;
  date: string;
  status?: string;
  memo?: string | null;
  encrypted_amount?: string | null;
}

interface FakeInvoice {
  id: string;
  org_id: string;
  amount: number;
  status: string;
}

interface FakeStore {
  invoice_payments: FakeIp[];
  transactions: FakeTx[];
  invoices: FakeInvoice[];
}

let store: FakeStore;
let rpcCalls: Array<{ fn: string; args: Record<string, unknown> }>;
let rpcImpl: (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;
let authUserId: string | null;

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}-${++idCounter}`;

function makeSupabase() {
  return {
    auth: {
      getUser: async () => ({
        data: { user: authUserId ? { id: authUserId } : null },
        error: null,
      }),
    },
    from(table: string) {
      const t = table as TableName;
      let filterEq: Record<string, unknown> = {};
      let filterIn: { col: string; values: unknown[] } | null = null;
      let mode: 'list' | 'maybeSingle' | 'single' = 'list';
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
      let insertRow: any = null;
      let updatePatch: any = null;

      const api: any = {
        select(_cols?: string) { return api; },
        eq(col: string, val: unknown) { filterEq[col] = val; return api; },
        in(col: string, vals: unknown[]) {
          filterIn = { col, values: vals };
          return api;
        },
        maybeSingle() { mode = 'maybeSingle'; return runRead(); },
        single() { mode = 'single'; return runWriteOrRead(); },
        insert(row: any) { op = 'insert'; insertRow = row; return api; },
        update(patch: any) { op = 'update'; updatePatch = patch; return api; },
        delete() { op = 'delete'; return runDelete(); },
        then(onFulfilled: (v: any) => unknown) {
          // Default terminal — list-select or fire-and-forget write.
          if (op === 'insert' && mode === 'list') {
            return runInsert().then(onFulfilled);
          }
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

      async function runRead(): Promise<{ data: any; error: null }> {
        const rows = (store[t] as any[]).filter(matches);
        if (mode === 'maybeSingle') return { data: rows[0] ?? null, error: null };
        if (mode === 'single') return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
      }

      async function runInsert(): Promise<{ data: any; error: null }> {
        const row = { id: insertRow.id ?? nextId(t), ...insertRow };
        (store[t] as any[]).push(row);
        if (mode === 'single') return { data: row, error: null };
        return { data: [row], error: null };
      }

      async function runWriteOrRead(): Promise<{ data: any; error: null }> {
        if (op === 'insert') return runInsert();
        return runRead();
      }

      async function runUpdate(): Promise<{ data: any; error: null }> {
        const rows = (store[t] as any[]).filter(matches);
        for (const r of rows) Object.assign(r, updatePatch);
        return { data: rows, error: null };
      }

      async function runDelete(): Promise<{ data: any; error: null }> {
        const before = (store[t] as any[]).length;
        store[t] = (store[t] as any[]).filter((r) => !matches(r)) as any;
        return { data: { deleted: before - (store[t] as any[]).length }, error: null };
      }

      return api;
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      return rpcImpl(fn, args);
    },
  };
}

vi.mock('@/lib/supabase', () => ({
  get supabase() { return makeSupabase(); },
}));

// Stable, predictable "encryption" so tests can assert on the
// ciphertext format without crypto in scope. The shape matches what
// encryptNumber / encryptText return at the call site — strings.
vi.mock('@/lib/crypto-fields', async () => {
  const real = await vi.importActual<typeof import('@/lib/crypto-fields')>(
    '@/lib/crypto-fields',
  );
  return {
    ...real,
    encryptTransaction: vi.fn(async (fields: any, _enc: any) => ({
      memo: `enc:${fields.memo ?? ''}`,
      encrypted_amount: `enc:amount:${fields.amount}`,
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
    encryptNumber: vi.fn(async (v: number | null) =>
      v == null ? null : `enc:num:${v}`,
    ),
  };
});

import {
  recordPlaceholderPayment,
  AmountExceedsRemainingError,
} from '../recordPlaceholderPayment';

const ORG = 'org-1';
const INV = 'inv-1';
const WALLET = 'wallet-1';
const USER = 'user-1';

const encryptText = vi.fn(async (s: string) => `enc:${s}`);
const decryptText = vi.fn(async (s: string) => s.replace(/^enc:/, ''));
const loadOrgSigningKey = vi.fn(async (_o: string) => ({}));
const signMutation = vi.fn(
  (_p: Uint8Array, _o: string) => ({ signature_b64: 'sig-placeholder', key_version: 3 }),
);

function makeCall(over: Partial<Parameters<typeof recordPlaceholderPayment>[0]> = {}) {
  return {
    invoiceId: INV,
    amount: 100,
    walletId: WALLET,
    walletlegacy ledger backendAccountId: 'legacy-wallet-1',
    asset: 'USD',
    appliedAt: '2026-05-21',
    memo: 'Cash payment',
    orgId: ORG,
    invoiceAmount: 100,
    invoiceNumber: 'INV-001',
    encryptText,
    decryptText,
    loadOrgSigningKey,
    signMutation,
    ...over,
  };
}

beforeEach(() => {
  store = {
    invoice_payments: [],
    transactions: [],
    invoices: [{ id: INV, org_id: ORG, amount: 100, status: 'SENT' }],
  };
  rpcCalls = [];
  authUserId = USER;
  idCounter = 0;

  // Default RPC: insert the invoice_payments row + return success.
  rpcImpl = async (fn, args) => {
    if (fn !== 'apply_invoice_payment') return { data: null, error: null };
    const ipId = nextId('ip');
    store.invoice_payments.push({
      id: ipId,
      invoice_id: args.p_invoice_id as string,
      transaction_id: args.p_transaction_id as string,
      amount_applied: Number(args.p_amount_applied),
      applied_at: '2026-05-21T00:00:00Z',
      is_placeholder: false,
    });
    // Mark invoice PAID/PARTIAL based on sum.
    const inv = store.invoices.find((i) => i.id === args.p_invoice_id);
    const sum = store.invoice_payments
      .filter((r) => r.invoice_id === args.p_invoice_id)
      .reduce((a, r) => a + r.amount_applied, 0);
    if (inv) inv.status = sum >= inv.amount ? 'PAID' : 'PARTIAL';
    return {
      data: [{
        payment_id: ipId,
        invoice_status: inv?.status ?? 'PARTIAL',
        total_applied: sum,
        invoice_amount: inv?.amount ?? 0,
        je_posted: true,
        je_id: 'je-1',
      }],
      error: null,
    };
  };

  encryptText.mockClear();
  decryptText.mockClear();
  loadOrgSigningKey.mockClear();
  signMutation.mockClear();
  signMutation.mockImplementation(() => ({ signature_b64: 'sig-placeholder', key_version: 3 }));
});

describe('recordPlaceholderPayment', () => {
  it('happy path: signs, inserts synthetic tx, calls RPC, flags placeholder', async () => {
    const result = await recordPlaceholderPayment(makeCall());

    expect(loadOrgSigningKey).toHaveBeenCalledWith(ORG);
    expect(signMutation).toHaveBeenCalledTimes(1);

    // The synthetic tx exists, anchored to the chosen wallet + date,
    // with encrypted_amount populated and plaintext mirror matching.
    expect(store.transactions).toHaveLength(1);
    const tx = store.transactions[0];
    expect(tx.account_id).toBe(WALLET);
    expect(tx.date).toBe('2026-05-21');
    expect(tx.amount).toBe(100);
    expect(tx.encrypted_amount).toBe('enc:amount:100');
    expect(tx.status).toBe('enc:PLACEHOLDER');

    // RPC fired with the encrypted amount + notes.
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('apply_invoice_payment');
    expect(rpcCalls[0].args.p_encrypted_amount_applied).toBe('enc:num:100');
    expect(rpcCalls[0].args.p_encrypted_notes).toBe('enc:Cash payment');

    // The resulting invoice_payments row is flagged placeholder + sig.
    expect(store.invoice_payments).toHaveLength(1);
    const ip = store.invoice_payments[0];
    expect(ip.is_placeholder).toBe(true);
    expect(ip.signature_b64).toBe('sig-placeholder');
    expect(ip.signature_key_version).toBe(3);

    expect(result.paymentId).toBe(ip.id);
    expect(result.invoiceStatus).toBe('PAID');
    expect(result.reused).toBe(false);
    expect(result.warnArMissing).toBe(false);
  });

  it('surfaces warnArMissing when A/R config absent (je_posted=false)', async () => {
    rpcImpl = async (_fn, args) => {
      const ipId = nextId('ip');
      store.invoice_payments.push({
        id: ipId,
        invoice_id: args.p_invoice_id as string,
        transaction_id: args.p_transaction_id as string,
        amount_applied: Number(args.p_amount_applied),
        is_placeholder: false,
      });
      return {
        data: [{
          payment_id: ipId,
          invoice_status: 'PAID',
          total_applied: Number(args.p_amount_applied),
          invoice_amount: 100,
          je_posted: false, // ← A/R not configured
          je_id: null,
        }],
        error: null,
      };
    };

    const result = await recordPlaceholderPayment(makeCall());

    expect(result.warnArMissing).toBe(true);
    expect(result.jePosted).toBe(false);
    // Row still flagged placeholder so the merge UX can find it later.
    expect(store.invoice_payments[0].is_placeholder).toBe(true);
  });

  it('throws when mutation signing returns null — no writes occur', async () => {
    signMutation.mockImplementationOnce(() => null);

    await expect(recordPlaceholderPayment(makeCall())).rejects.toThrow(/signing key/i);

    expect(store.transactions).toHaveLength(0);
    expect(store.invoice_payments).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
  });

  it('idempotent double-click: reuses existing placeholder, no new tx', async () => {
    // Seed an existing placeholder for the same (invoice, wallet, date,
    // amount). The helper should find it and short-circuit before
    // signing or inserting anything.
    const existingTxId = 'tx-existing';
    store.transactions.push({
      id: existingTxId,
      org_id: ORG,
      account_id: WALLET,
      amount: 100,
      date: '2026-05-21',
    });
    store.invoice_payments.push({
      id: 'ip-existing',
      invoice_id: INV,
      transaction_id: existingTxId,
      amount_applied: 100,
      is_placeholder: true,
      signature_b64: 'sig-prior',
      signature_key_version: 3,
    });
    // Invoice currently PARTIAL (we mocked a half-paid state pre-call)
    store.invoices[0].status = 'PARTIAL';

    const result = await recordPlaceholderPayment(makeCall());

    expect(result.reused).toBe(true);
    expect(result.paymentId).toBe('ip-existing');
    expect(result.transactionId).toBe(existingTxId);
    // No new tx, no new ip, no RPC, no signing.
    expect(store.transactions).toHaveLength(1);
    expect(store.invoice_payments).toHaveLength(1);
    expect(rpcCalls).toHaveLength(0);
    expect(signMutation).not.toHaveBeenCalled();
  });

  it('refuses when amount exceeds remaining balance', async () => {
    // Pre-existing payment already covers 60 of the 100 invoice.
    store.invoice_payments.push({
      id: 'ip-prior',
      invoice_id: INV,
      transaction_id: 'tx-prior',
      amount_applied: 60,
      is_placeholder: false,
    });

    await expect(
      recordPlaceholderPayment(makeCall({ amount: 50 })), // 50 > remaining 40
    ).rejects.toBeInstanceOf(AmountExceedsRemainingError);

    expect(store.transactions).toHaveLength(0);
    expect(rpcCalls).toHaveLength(0);
    expect(signMutation).not.toHaveBeenCalled();
  });
});
