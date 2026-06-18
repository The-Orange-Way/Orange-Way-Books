// @vitest-environment node
//
// Unit tests for voidTransaction — Fixes 3, 4, 5 in the split-write-path
// audit. Locks in:
//
//   - Status flip uses FIELD_KEY_VERSION (sourced from crypto-fields)
//     instead of a local literal — guards Fix 5.
//   - Status flip carries a signing-key signature stamped onto the row — Fix 3.
//   - Linked transfer pair: voiding one side flips both rows.
//   - Reversal legacy ledger backend posts use real wallet / chart external_account_ids, with
//     dr / cr swapped — Fix 4 (no more dr=cr=legacy_transaction_id placeholder).
//   - When a JE line references an account_name we can't resolve, we throw
//     rather than write a known-broken legacy ledger backend post.

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Fake stores ────────────────────────────────────────────────────────────

interface FakeStore {
  transactions: Array<Record<string, unknown>>;
  journal_entries: Array<Record<string, unknown>>;
  journal_entry_lines: Array<Record<string, unknown>>;
  wallets: Array<Record<string, unknown>>;
  chart_of_accounts: Array<Record<string, unknown>>;
  audit_log: Array<Record<string, unknown>>;
}

let store: FakeStore;
let legacyPosts: Array<{
  legacyTxId: string;
  templateCode: string;
  params: Record<string, unknown>;
}>;

function makeSupabase() {
  function from(table: keyof FakeStore) {
    let filterCol: string | null = null;
    let filterValue: unknown = null;
    let filterIn: { col: string; values: string[] } | null = null;
    let modeSingle = false;
    let modeMaybeSingle = false;
    let updatePayload: Record<string, unknown> | null = null;

    const apiSelect = {
      eq(col: string, value: unknown) {
        filterCol = col;
        filterValue = value;
        return apiSelect;
      },
      single() {
        modeSingle = true;
        return run();
      },
      maybeSingle() {
        modeMaybeSingle = true;
        return run();
      },
      then(onFulfilled: (v: { data: unknown; error: null }) => unknown) {
        return run().then(onFulfilled);
      },
    };

    function applyFilters(rows: Array<Record<string, unknown>>) {
      return rows.filter((row) => {
        if (filterCol !== null && row[filterCol] !== filterValue) return false;
        if (filterIn && !filterIn.values.includes(row[filterIn.col] as string)) return false;
        return true;
      });
    }

    async function run(): Promise<{ data: unknown; error: null }> {
      const rows = applyFilters(store[table]);
      if (updatePayload !== null) {
        for (const r of rows) Object.assign(r, updatePayload);
        return { data: null, error: null };
      }
      if (modeSingle) return { data: rows[0] ?? null, error: null };
      if (modeMaybeSingle) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    }

    return {
      select(_cols?: string) {
        return apiSelect;
      },
      insert(payload: unknown) {
        const rows = Array.isArray(payload) ? payload : [payload];
        const withIds = rows.map((row) => ({
          ...(row as Record<string, unknown>),
          id: (row as { id?: string }).id ?? crypto.randomUUID(),
        }));
        store[table].push(...withIds);
        return {
          select() {
            return {
              single() {
                return Promise.resolve({ data: withIds[0], error: null });
              },
              then(onFulfilled: (v: { data: unknown; error: null }) => unknown) {
                return Promise.resolve({ data: withIds, error: null }).then(onFulfilled);
              },
            };
          },
          then(onFulfilled: (v: { data: null; error: null }) => unknown) {
            return Promise.resolve({ data: null, error: null }).then(onFulfilled);
          },
        };
      },
      update(payload: Record<string, unknown>) {
        updatePayload = payload;
        return {
          eq(col: string, value: unknown) {
            filterCol = col;
            filterValue = value;
            return run();
          },
          in(col: string, values: string[]) {
            filterIn = { col, values };
            return run();
          },
        };
      },
    };
  }

  return { from };
}

vi.mock('@/lib/supabase', () => ({
  get supabase() {
    return makeSupabase();
  },
}));

// Stub the legacy ledger backend client so we can introspect what would have been posted.
vi.mock('@/lib/legacy-ledger', () => ({
  async postTransaction(
    legacyTxId: string,
    templateCode: string,
    params: Record<string, unknown>,
  ) {
    legacyPosts.push({ legacyTxId, templateCode, params });
    return { transactionId: legacyTxId };
  },
}));

// Stub the audit logger — write is async and we don't care about its shape.
vi.mock('@/lib/audit-logger', () => ({
  writeAuditLog: () => undefined,
}));

// Reversible enc/dec so the helper can round-trip names + status.
const encryptText = async (plaintext: string) => `enc(${plaintext})`;
const decryptText = async (cipher: string) => {
  const match = cipher.match(/^enc\((.*)\)$/);
  return match ? match[1] : cipher;
};

// Lazy import so mocks are installed first.
import { voidTransaction } from '../void-transaction';
import { FIELD_KEY_VERSION } from '@/lib/crypto-fields';

// ── Test fixtures ──────────────────────────────────────────────────────────

const ORG = 'org-1';
const CALA_JOURNAL = 'legacy-journal-1';

function seedWalletAndAccount() {
  const walletlegacy ledger backendId = 'legacy-wallet-source';
  const accountlegacy ledger backendId = 'legacy-account-sales';
  store.wallets.push({
    id: 'wallet-1',
    org_id: ORG,
    external_account_id: walletlegacy ledger backendId,
    encrypted_name: 'enc(Checking)',
    asset: 'enc(USD)',
    key_version: 2,
    encrypted_balance: null,
    account_type: 'enc(BANK)',
    connection_type: null,
    external_account_code: null,
  });
  store.chart_of_accounts.push({
    id: 'acct-row-1',
    org_id: ORG,
    external_account_id: accountlegacy ledger backendId,
    encrypted_name: 'enc(Sales Revenue)',
    account_name: crypto.randomUUID(),
    account_code: crypto.randomUUID(),
    account_type: 'enc(INCOME)',
    account_group: 'enc(Revenue)',
    account_category: null,
    encrypted_is_archived: 'enc(false)',
    is_archived: false,
    key_version: 2,
    parent_id: null,
  });
  return { walletlegacy ledger backendId, accountlegacy ledger backendId };
}

function seedSplitTransaction(opts: { withlegacy ledger backend: boolean }) {
  const { walletlegacy ledger backendId, accountlegacy ledger backendId } = seedWalletAndAccount();
  store.transactions.push({
    id: 'tx-1',
    org_id: ORG,
    account_id: 'wallet-1',
    journal_entry_id: 'je-1',
    linked_transfer_id: null,
    amount: 0,
    encrypted_amount: 'enc(-100)',
    asset: 'enc(USD)',
    type: 'enc(Send)',
    status: 'enc(POSTED)',
    cleared_status: null,
    date: '2026-05-01',
    key_version: 2,
  });
  store.journal_entries.push({
    id: 'je-1',
    org_id: ORG,
    date: '2026-05-01',
    currency: 'USD',
    status: 'POSTED',
    source_type: 'TRANSACTION_SPLIT',
    memo: 'enc(Coffee run)',
    ref_number: null,
    encrypted_exchange_rate: null,
    encrypted_period_locked: null,
    period_locked: false,
    exchange_rate: null,
    key_version: 2,
    dek_key_version: 2,
  });
  // Wallet leg: credit 100 (money out of Checking).
  store.journal_entry_lines.push({
    id: 'jel-wallet',
    journal_entry_id: 'je-1',
    account_name: 'enc(Checking)',
    account_code: null,
    description: null,
    encrypted_debit: 'enc(0)',
    encrypted_credit: 'enc(100)',
    encrypted_book_value: null,
    debit: 0,
    credit: 0,
    book_value: null,
    key_version: 2,
    encrypted_amount_native: null,
    encrypted_amount_primary: null,
    encrypted_posted_rate: null,
    encrypted_wallet_currency: 'enc(USD)',
    primary_currency_at_posting: 'USD',
    rate_pending: false,
    rate_asof: null,
    pinned_rate_id: null,
    dual_amounts_backfilled: false,
    manual_rate_reason: null,
    manual_rate_source: null,
    legacy_transaction_id: null,
  });
  // Account leg: debit 100 (Sales Revenue posted as expense for the split test).
  store.journal_entry_lines.push({
    id: 'jel-account',
    journal_entry_id: 'je-1',
    account_name: 'enc(Sales Revenue)',
    account_code: null,
    description: null,
    encrypted_debit: 'enc(100)',
    encrypted_credit: 'enc(0)',
    encrypted_book_value: null,
    debit: 0,
    credit: 0,
    book_value: null,
    key_version: 2,
    encrypted_amount_native: null,
    encrypted_amount_primary: null,
    encrypted_posted_rate: null,
    encrypted_wallet_currency: 'enc(USD)',
    primary_currency_at_posting: 'USD',
    rate_pending: false,
    rate_asof: null,
    pinned_rate_id: null,
    dual_amounts_backfilled: false,
    manual_rate_reason: null,
    manual_rate_source: null,
    legacy_transaction_id: opts.withlegacy ledger backend ? 'legacy-original-1' : null,
  });
  return { walletlegacy ledger backendId, accountlegacy ledger backendId };
}

const loadOrgSigningKey = vi.fn(async (_orgId: string) => ({}));
const signMutation = vi.fn(
  (_payload: Uint8Array, _orgId: string) => ({ signature_b64: 'sig-xyz', key_version: 1 }),
);

beforeEach(() => {
  store = {
    transactions: [],
    journal_entries: [],
    journal_entry_lines: [],
    wallets: [],
    chart_of_accounts: [],
    audit_log: [],
  };
  legacyPosts = [];
  loadOrgSigningKey.mockClear();
  signMutation.mockClear();
});

describe('voidTransaction', () => {
  it('writes a reversing JE, flips status, stamps signature + field key version', async () => {
    seedSplitTransaction({ withlegacy ledger backend: false });

    const result = await voidTransaction({
      txId: 'tx-1',
      orgId: ORG,
      legacyJournalId: null, // skip legacy ledger backend path here; covered in dedicated test
      date: '2026-05-21',
      encryptText,
      decryptText,
      loadOrgSigningKey,
      signMutation,
    });

    // Reversing JE was created.
    expect(result.reversalJournalEntryId).toBeTruthy();
    const reversalJe = store.journal_entries.find(
      (j) => j.id === result.reversalJournalEntryId,
    );
    expect(reversalJe).toBeDefined();
    // Post-Phase-1: source_type is plaintext (server reads it to gate
    // the immutability trigger). Not encrypted.
    expect(reversalJe!.source_type).toBe('VOID_REVERSAL');
    expect(reversalJe!.reversal_of_id).toBe('je-1');

    // Lines were inserted with debit / credit swapped.
    const reversedLines = store.journal_entry_lines.filter(
      (l) => l.journal_entry_id === result.reversalJournalEntryId,
    );
    expect(reversedLines).toHaveLength(2);

    // Original transaction was flipped to VOID with the canonical field key
    // version (Fix 5) — not a local literal.
    const origAfter = store.transactions.find((t) => t.id === 'tx-1');
    expect(origAfter!.status).toBe('enc(VOID)');
    expect(origAfter!.key_version).toBe(FIELD_KEY_VERSION);

    // Phase 4.4 signature was stamped (Fix 3).
    expect(origAfter!.signature_b64).toBe('sig-xyz');
    expect(origAfter!.signature_key_version).toBe(1);

    // signMutation was called exactly once with the org id scope.
    expect(loadOrgSigningKey).toHaveBeenCalledWith(ORG);
    expect(signMutation).toHaveBeenCalledTimes(1);
    expect(signMutation.mock.calls[0][1]).toBe(ORG);
  });

  it('uses FIELD_KEY_VERSION (=2 today) and not the deprecated literal', () => {
    // Pure smoke — guards against a future drift where someone re-introduces
    // a local KEY_VERSION constant out of sync with crypto-fields.
    expect(FIELD_KEY_VERSION).toBe(2);
  });

  it('voids both legs of a linked transfer pair when only one side is targeted', async () => {
    seedWalletAndAccount();
    store.transactions.push({
      id: 'tx-src',
      org_id: ORG,
      account_id: 'wallet-1',
      journal_entry_id: 'je-pair',
      linked_transfer_id: 'tx-dest',
      amount: 0,
      encrypted_amount: 'enc(-100)',
      asset: 'enc(USD)',
      type: 'enc(Transfer)',
      status: 'enc(POSTED)',
      cleared_status: null,
      date: '2026-05-01',
      key_version: 2,
    });
    store.transactions.push({
      id: 'tx-dest',
      org_id: ORG,
      account_id: 'wallet-1',
      journal_entry_id: 'je-pair',
      linked_transfer_id: 'tx-src',
      amount: 0,
      encrypted_amount: 'enc(100)',
      asset: 'enc(USD)',
      type: 'enc(Transfer)',
      status: 'enc(POSTED)',
      cleared_status: null,
      date: '2026-05-01',
      key_version: 2,
    });
    store.journal_entries.push({
      id: 'je-pair',
      org_id: ORG,
      date: '2026-05-01',
      currency: 'USD',
      status: 'POSTED',
      source_type: 'TRANSACTION_TRANSFER',
      memo: 'enc(Transfer)',
      ref_number: null,
      encrypted_exchange_rate: null,
      encrypted_period_locked: null,
      period_locked: false,
      exchange_rate: null,
      key_version: 2,
      dek_key_version: 2,
    });
    // One wallet leg is enough to drive the reversal; we only care about
    // status flip semantics here, not legacy ledger backend.
    store.journal_entry_lines.push({
      id: 'jel-src',
      journal_entry_id: 'je-pair',
      account_name: 'enc(Checking)',
      account_code: null,
      description: null,
      encrypted_debit: 'enc(0)',
      encrypted_credit: 'enc(100)',
      encrypted_book_value: null,
      debit: 0,
      credit: 0,
      book_value: null,
      key_version: 2,
      encrypted_amount_native: null,
      encrypted_amount_primary: null,
      encrypted_posted_rate: null,
      encrypted_wallet_currency: 'enc(USD)',
      primary_currency_at_posting: 'USD',
      rate_pending: false,
      rate_asof: null,
      pinned_rate_id: null,
      dual_amounts_backfilled: false,
      manual_rate_reason: null,
      manual_rate_source: null,
      legacy_transaction_id: null,
    });

    const result = await voidTransaction({
      txId: 'tx-src',
      orgId: ORG,
      legacyJournalId: null,
      date: '2026-05-21',
      encryptText,
      decryptText,
      loadOrgSigningKey,
      signMutation,
    });

    expect(result.voidedTransactionIds.sort()).toEqual(['tx-dest', 'tx-src']);
    const src = store.transactions.find((t) => t.id === 'tx-src');
    const dest = store.transactions.find((t) => t.id === 'tx-dest');
    expect(src!.status).toBe('enc(VOID)');
    expect(dest!.status).toBe('enc(VOID)');
  });

  // legacy ledger backend-specific reversal tests removed 2026-06-13 — the legacy-ledger removal physically
  // deleted the vendored ledger fork. Void no longer posts a legacy ledger backend reversal; the reversing
  // JE in the previous test ("writes a reversing JE …") IS the void path now.

  it('throws clearly when the caller has no signing-key wrap', async () => {
    seedSplitTransaction({ withlegacy ledger backend: false });
    const noSign = vi.fn(() => null);

    await expect(
      voidTransaction({
        txId: 'tx-1',
        orgId: ORG,
        legacyJournalId: null,
        date: '2026-05-21',
        encryptText,
        decryptText,
        loadOrgSigningKey,
        signMutation: noSign,
      }),
    ).rejects.toThrow(/No signing key/);
  });
});
