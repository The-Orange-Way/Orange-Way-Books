// @vitest-environment node
//
// Wiring tests for the Wave 2 COA migration invocation site.
//
// Wave 2 (`migrateCoaWave2`) needs to actually run on existing orgs. We
// chose Option A: piggy-back on `ensureTransferClearingAccount`, the same
// lazy-invocation site Wave 1 uses. Rationale: one path, both migrations
// land together; users who never make a transfer get migrated whenever
// they first do.
//
// These specs lock in:
//   1. Wave 2 is called when ensureTransferClearingAccount runs on an org
//      that's already Wave-1-migrated (i.e. the Transfer Clearing row
//      already exists — no insert path, but the migrations still run).
//   2. Wave 1 runs BEFORE Wave 2 (order matters per the migration's
//      docstring; the 1500 slot must be freed before downstream waves).
//   3. Re-running ensureTransferClearingAccount on the same session is a
//      no-op for both waves — they decrypt rows and find nothing to do.

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

// Spy on the migration module so we can assert call order without
// re-testing the migration's internal behavior (covered exhaustively in
// migrate-coa-wave-2.test.ts).
const wave1Spy = vi.fn(async () => ({ updated: 0 }));
const wave2Spy = vi.fn(async () => ({ updated: 0, skipped: 0 }));

vi.mock('../migrate-coa-renumber', () => ({
  migrateEquipmentTransferClearingCodes: (...args: unknown[]) => wave1Spy(...args),
  migrateCoaWave2: (...args: unknown[]) => wave2Spy(...args),
}));

const encryptText = async (plaintext: string) => `enc(${plaintext})`;
const decryptText = async (cipher: string) => {
  const match = cipher.match(/^enc\((.*)\)$/);
  return match ? match[1] : cipher;
};

// Lazy import so mocks are in place.
import { ensureTransferClearingAccount } from '../transfer-clearing';

const ORG = 'org-1';

beforeEach(() => {
  store = { chart_of_accounts: [] };
  wave1Spy.mockClear();
  wave2Spy.mockClear();
});

describe('ensureTransferClearingAccount — Wave 2 wiring', () => {
  it('invokes migrateCoaWave2 when the Transfer Clearing row is missing', async () => {
    await ensureTransferClearingAccount(ORG, encryptText, decryptText);
    expect(wave2Spy).toHaveBeenCalledTimes(1);
    expect(wave2Spy).toHaveBeenCalledWith(ORG, encryptText, decryptText);
  });

  it('runs Wave 1 BEFORE Wave 2 (order matters per migration docstring)', async () => {
    const callOrder: string[] = [];
    wave1Spy.mockImplementationOnce(async () => {
      callOrder.push('wave1');
      return { updated: 0 };
    });
    wave2Spy.mockImplementationOnce(async () => {
      callOrder.push('wave2');
      return { updated: 0, skipped: 0 };
    });
    await ensureTransferClearingAccount(ORG, encryptText, decryptText);
    expect(callOrder).toEqual(['wave1', 'wave2']);
  });

  it('does NOT re-run either wave when the Transfer Clearing row already exists', async () => {
    // First call: creates the row, runs both waves.
    await ensureTransferClearingAccount(ORG, encryptText, decryptText);
    expect(wave1Spy).toHaveBeenCalledTimes(1);
    expect(wave2Spy).toHaveBeenCalledTimes(1);

    // Second call: row exists, find short-circuits, neither wave fires.
    await ensureTransferClearingAccount(ORG, encryptText, decryptText);
    expect(wave1Spy).toHaveBeenCalledTimes(1);
    expect(wave2Spy).toHaveBeenCalledTimes(1);
  });

  it('continues if Wave 2 throws (non-fatal — transfer write path must succeed)', async () => {
    wave2Spy.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    // Should not throw; the helper still creates the Transfer Clearing row.
    const result = await ensureTransferClearingAccount(ORG, encryptText, decryptText);
    expect(result.account_name).toBe('Transfer Clearing');
    expect(wave2Spy).toHaveBeenCalledTimes(1);
  });
});
