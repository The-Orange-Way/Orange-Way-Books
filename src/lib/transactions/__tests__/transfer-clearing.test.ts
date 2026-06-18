// @vitest-environment node
//
// Unit tests for the Transfer Clearing helper (Fix 1).
//
// What we lock in:
//   1. find returns null when no Transfer Clearing row exists.
//   2. ensure creates a fresh row when none exists, with name + code matching
//      the canonical naming (and tagged ASSET so reports group it correctly).
//   3. ensure is idempotent — calling twice doesn't create a duplicate.
//   4. find ignores archived rows so a deleted/restored sequence doesn't
//      return a dead pointer.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeStore {
  chart_of_accounts: Array<Record<string, unknown>>;
}

let store: FakeStore;

function makeSupabase() {
  function select(table: keyof FakeStore) {
    let filterOrg: string | null = null;
    const chain = {
      select() {
        return chain;
      },
      eq(col: string, value: string) {
        if (col === 'org_id') filterOrg = value;
        return chain;
      },
      then(onFulfilled: (v: { data: unknown; error: null }) => unknown) {
        const rows = store[table].filter((row) => filterOrg === null || row.org_id === filterOrg);
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
      },
    };
    return chain;
  }

  function insert(table: keyof FakeStore, payload: unknown) {
    const rows = Array.isArray(payload) ? payload : [payload];
    const withIds = rows.map((row) => ({
      ...(row as Record<string, unknown>),
      id: crypto.randomUUID(),
    }));
    store[table].push(...withIds);
    return {
      select() {
        return {
          single() {
            return Promise.resolve({ data: withIds[0], error: null });
          },
        };
      },
    };
  }

  return {
    from(table: keyof FakeStore) {
      return {
        select() {
          return select(table);
        },
        insert(payload: unknown) {
          return insert(table, payload);
        },
      };
    },
  };
}

vi.mock('@/lib/supabase', () => ({
  get supabase() {
    return makeSupabase();
  },
}));

// Reversible enc/dec so decrypt on a stored row returns the original name.
const encryptText = async (plaintext: string) => `enc(${plaintext})`;
const decryptText = async (cipher: string) => {
  const match = cipher.match(/^enc\((.*)\)$/);
  return match ? match[1] : cipher;
};

// Lazy import so the mock is in place.
import {
  ensureTransferClearingAccount,
  findTransferClearingAccount,
  TRANSFER_CLEARING_NAME,
  TRANSFER_CLEARING_CODE,
} from '../transfer-clearing';

const ORG = 'org-1';

beforeEach(() => {
  store = { chart_of_accounts: [] };
});

describe('Transfer Clearing helper', () => {
  it('find returns null when no Transfer Clearing row exists', async () => {
    const result = await findTransferClearingAccount(ORG, decryptText);
    expect(result).toBeNull();
  });

  it('ensure creates a Transfer Clearing row with the expected name + code', async () => {
    const result = await ensureTransferClearingAccount(ORG, encryptText, decryptText);
    expect(result.account_name).toBe(TRANSFER_CLEARING_NAME);
    expect(result.external_account_id).toBeTruthy();
    expect(result.id).toBeTruthy();
    // The stored row should be retrievable by decrypted name.
    expect(store.chart_of_accounts).toHaveLength(1);
    const stored = store.chart_of_accounts[0] as Record<string, unknown>;
    expect(stored.org_id).toBe(ORG);
    // The encrypted_name column stores enc(Transfer Clearing).
    expect(stored.encrypted_name).toBe(`enc(${TRANSFER_CLEARING_NAME})`);
    // account_code 1500 — the canonical clearing slot. The previous 1500=Equipment was
    // renumbered to 1600 and Other Assets to 1700 to free this slot.
    expect(TRANSFER_CLEARING_CODE).toBe('1500');
  });

  it('ensure is idempotent — calling twice does not duplicate the row', async () => {
    const first = await ensureTransferClearingAccount(ORG, encryptText, decryptText);
    const second = await ensureTransferClearingAccount(ORG, encryptText, decryptText);
    expect(second.id).toBe(first.id);
    expect(store.chart_of_accounts).toHaveLength(1);
  });

  it('find returns the existing row after ensure', async () => {
    const created = await ensureTransferClearingAccount(ORG, encryptText, decryptText);
    const found = await findTransferClearingAccount(ORG, decryptText);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.external_account_id).toBe(created.external_account_id);
  });

  it('encrypts the Transfer Clearing name + code on the wire (no plaintext leak)', async () => {
    await ensureTransferClearingAccount(ORG, encryptText, decryptText);
    const stored = store.chart_of_accounts[0] as Record<string, unknown>;
    // Post-Phase-1: chart_of_accounts has no plaintext account_name /
    // account_code columns — everything customer-typed lives in
    // encrypted_name / encrypted_code. Supabase must only see ciphertext.
    expect(stored.encrypted_name).toBe(`enc(${TRANSFER_CLEARING_NAME})`);
    expect(stored.encrypted_code).toBe(`enc(${TRANSFER_CLEARING_CODE})`);
    // And the plaintext keys must NOT be present on the inserted row.
    expect(stored.account_name).toBeUndefined();
    expect(stored.account_code).toBeUndefined();
  });

  it('encodes the transfer leg ordering: 4 lines, balanced per currency', () => {
    // This is a documented-invariant smoke test that mirrors the shape the
    // transaction modal builds in handleSaveTransfer. We don't import the
    // modal (it's a React component); we just check that for a 100 USD → 5000
    // sats cross-currency transfer, the 4-line JE balances in BOTH currencies
    // independently, which is the documented contract — see
    // generate-journal-entry.ts inside the transactions module.
    const sentValue = 100;     // USD out of source
    const receivedValue = 5000; // sats into dest
    const destAsset = 'BTC';
    const sourceAsset = 'USD';

    const lines = [
      { currency: destAsset,   debit: receivedValue,  credit: 0,             account: 'Dest Wallet' },
      { currency: destAsset,   debit: 0,              credit: receivedValue, account: 'Transfer Clearing' },
      { currency: sourceAsset, debit: sentValue,      credit: 0,             account: 'Transfer Clearing' },
      { currency: sourceAsset, debit: 0,              credit: sentValue,     account: 'Source Wallet' },
    ];

    const byCurrency = new Map<string, { dr: number; cr: number }>();
    for (const l of lines) {
      const cur = byCurrency.get(l.currency) ?? { dr: 0, cr: 0 };
      cur.dr += l.debit;
      cur.cr += l.credit;
      byCurrency.set(l.currency, cur);
    }
    for (const [, totals] of byCurrency) {
      expect(totals.dr).toBe(totals.cr);
    }
    // Transfer Clearing must appear on both currency sides.
    const clearingLines = lines.filter((l) => l.account === 'Transfer Clearing');
    expect(new Set(clearingLines.map((l) => l.currency))).toEqual(new Set([destAsset, sourceAsset]));
  });

  it('find ignores archived Transfer Clearing rows', async () => {
    // Seed an archived row directly with the matching name.
    store.chart_of_accounts.push({
      id: 'archived-1',
      org_id: ORG,
      external_account_id: 'legacy-archived-1',
      encrypted_name: `enc(${TRANSFER_CLEARING_NAME})`,
      account_name: crypto.randomUUID(),
      account_code: crypto.randomUUID(),
      account_type: `enc(ASSET)`,
      account_group: `enc(Assets)`,
      account_category: null,
      encrypted_is_archived: `enc(true)`,
      is_archived: false, // plaintext column is unused once encrypted variant exists
      key_version: 2,
      parent_id: null,
    });
    const found = await findTransferClearingAccount(ORG, decryptText);
    expect(found).toBeNull();
  });
});
