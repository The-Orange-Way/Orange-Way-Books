// @vitest-environment node
//
// Unit tests for the Wave 2 chart-of-accounts rename + renumber migration.
//
// Locks in:
//   1. Idempotent: second invocation is a no-op.
//   2. 1300 Inventory → 1305 Inventory (renumber, keep name).
//   3. 3000 "Equity" → "Owner's Equity" (rename, code stays 3000).
//   4. 3100 "Owner's Equity" → "Starting Balance" (rename, code stays 3100).
//   5. 4000 "Income" → "Sales" (rename, code stays 4000).
//   6. 5100 Cost of Goods Sold → 5000 (renumber).
//   7. Rename ordering: 3100 happens before 3000 so we never have two rows
//      decrypting to "Owner's Equity" simultaneously.
//   8. Collision refusal: if a user-created row already owns the destination
//      code, the migration skips silently rather than clobbering it.
//   9. No-op on an org with no rows.

import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeRow extends Record<string, unknown> {
  id: string;
  org_id: string;
  external_account_id: string;
  encrypted_name: string;
  account_name: string;
  account_code: string;
  account_type: string;
  account_group: string | null;
  account_category: string | null;
  encrypted_is_archived: string;
  key_version: number;
}

interface FakeStore {
  chart_of_accounts: FakeRow[];
}

let store: FakeStore;

function makeSupabase() {
  function fromTable(table: keyof FakeStore) {
    let filterOrg: string | null = null;
    let filterId: string | null = null;
    let updatePayload: Record<string, unknown> | null = null;

    const chain = {
      select() {
        return chain;
      },
      eq(col: string, value: string) {
        if (col === 'org_id') filterOrg = value;
        if (col === 'id') filterId = value;
        if (updatePayload && filterId) {
          // .update(payload).eq('id', X) form — apply now.
          const idx = store[table].findIndex((r) => r.id === filterId);
          if (idx >= 0) {
            store[table][idx] = { ...store[table][idx], ...updatePayload };
          }
          updatePayload = null;
          return Promise.resolve({ data: null, error: null });
        }
        return chain;
      },
      update(payload: Record<string, unknown>) {
        updatePayload = payload;
        return chain;
      },
      then(onFulfilled: (v: { data: unknown; error: null }) => unknown) {
        const rows = store[table].filter(
          (row) => filterOrg === null || row.org_id === filterOrg,
        );
        return Promise.resolve({ data: rows, error: null }).then(onFulfilled);
      },
    };
    return chain;
  }

  return {
    from(table: keyof FakeStore) {
      return fromTable(table);
    },
  };
}

vi.mock('@/lib/supabase', () => ({
  get supabase() {
    return makeSupabase();
  },
}));

// Reversible per-field enc so `decryptChartOfAccount` round-trips. The real
// implementation reads `encrypted_name` and the L2-encrypted code/type/etc
// columns. Our fake here mirrors that contract by storing `enc(<plaintext>)`
// in those fields and reading them back through the same decrypt fn.
const encryptText = async (plaintext: string) => `enc(${plaintext})`;
const decryptText = async (cipher: string) => {
  const match = cipher.match(/^enc\((.*)\)$/);
  return match ? match[1] : cipher;
};

// We mock crypto-fields so the test doesn't depend on the real ZKA primitives
// (which need a vault key context). This is the same shape the production
// migration consumes.
vi.mock('@/lib/crypto-fields', () => ({
  decryptChartOfAccount: async (row: FakeRow, decFn: (c: string) => Promise<string>) => ({
    account_name: await decFn(row.encrypted_name),
    account_code: await decFn(row.account_code),
    account_type: await decFn(row.account_type),
    account_group: row.account_group ? await decFn(row.account_group) : null,
    account_category: row.account_category ? await decFn(row.account_category) : null,
    is_archived: (await decFn(row.encrypted_is_archived)) === 'true',
  }),
  encryptChartOfAccount: async (
    fields: {
      account_name: string;
      account_code: string;
      account_type: string;
      account_group: string | null;
      account_category: string | null;
      is_archived: boolean;
    },
    encFn: (p: string) => Promise<string>,
  ) => ({
    encrypted_name: await encFn(fields.account_name),
    account_name: crypto.randomUUID(),
    account_code: await encFn(fields.account_code),
    account_type: await encFn(fields.account_type),
    account_group: fields.account_group ? await encFn(fields.account_group) : null,
    account_category: fields.account_category ? await encFn(fields.account_category) : null,
    encrypted_is_archived: await encFn(String(fields.is_archived)),
    key_version: 2,
  }),
}));

// Lazy import so the mocks are in place.
import { migrateCoaWave2 } from '../migrate-coa-renumber';

const ORG = 'org-1';

function seedAccount(
  code: string,
  name: string,
  type = 'ASSET',
  group = 'Assets',
): FakeRow {
  const row: FakeRow = {
    id: crypto.randomUUID(),
    org_id: ORG,
    external_account_id: crypto.randomUUID(),
    encrypted_name: `enc(${name})`,
    account_name: crypto.randomUUID(),
    account_code: `enc(${code})`,
    account_type: `enc(${type})`,
    account_group: `enc(${group})`,
    account_category: null,
    encrypted_is_archived: `enc(false)`,
    key_version: 2,
  };
  store.chart_of_accounts.push(row);
  return row;
}

async function decryptedSnapshot(): Promise<Array<{ code: string; name: string }>> {
  const out: Array<{ code: string; name: string }> = [];
  for (const row of store.chart_of_accounts) {
    out.push({
      code: await decryptText(row.account_code),
      name: await decryptText(row.encrypted_name),
    });
  }
  return out;
}

beforeEach(() => {
  store = { chart_of_accounts: [] };
});

describe('migrateCoaWave2', () => {
  it('is a no-op on an org with no rows', async () => {
    const result = await migrateCoaWave2(ORG, encryptText, decryptText);
    expect(result).toEqual({ updated: 0, skipped: 0 });
  });

  it('renumbers Inventory 1300 → 1305 and keeps the name', async () => {
    seedAccount('1300', 'Inventory');
    const result = await migrateCoaWave2(ORG, encryptText, decryptText);
    expect(result.updated).toBeGreaterThanOrEqual(1);
    const snap = await decryptedSnapshot();
    expect(snap).toContainEqual({ code: '1305', name: 'Inventory' });
    expect(snap.find((r) => r.code === '1300')).toBeUndefined();
  });

  it('renames 3000 Equity → Owner\'s Equity and 3100 Owner\'s Equity → Starting Balance', async () => {
    seedAccount('3000', 'Equity', 'EQUITY', 'Equity');
    seedAccount('3100', "Owner's Equity", 'EQUITY', 'Equity');

    const result = await migrateCoaWave2(ORG, encryptText, decryptText);
    expect(result.updated).toBe(2);

    const snap = await decryptedSnapshot();
    expect(snap).toContainEqual({ code: '3000', name: "Owner's Equity" });
    expect(snap).toContainEqual({ code: '3100', name: 'Starting Balance' });
    // Neither old name should remain.
    expect(snap.find((r) => r.name === 'Equity' && r.code === '3000')).toBeUndefined();
  });

  it('renames 4000 Income → Sales (code unchanged)', async () => {
    seedAccount('4000', 'Income', 'INCOME', 'Revenue');
    await migrateCoaWave2(ORG, encryptText, decryptText);
    const snap = await decryptedSnapshot();
    expect(snap).toContainEqual({ code: '4000', name: 'Sales' });
  });

  it('renumbers Cost of Goods Sold 5100 → 5000', async () => {
    seedAccount('5100', 'Cost of Goods Sold', 'EXPENSE', 'Expenses');
    await migrateCoaWave2(ORG, encryptText, decryptText);
    const snap = await decryptedSnapshot();
    expect(snap).toContainEqual({ code: '5000', name: 'Cost of Goods Sold' });
    expect(snap.find((r) => r.code === '5100')).toBeUndefined();
  });

  it('is idempotent — calling twice does not double-apply', async () => {
    seedAccount('1300', 'Inventory');
    seedAccount('3000', 'Equity', 'EQUITY', 'Equity');
    seedAccount('3100', "Owner's Equity", 'EQUITY', 'Equity');
    seedAccount('4000', 'Income', 'INCOME', 'Revenue');
    seedAccount('5100', 'Cost of Goods Sold', 'EXPENSE', 'Expenses');

    const first = await migrateCoaWave2(ORG, encryptText, decryptText);
    expect(first.updated).toBe(5);

    const second = await migrateCoaWave2(ORG, encryptText, decryptText);
    expect(second.updated).toBe(0);
    expect(second.skipped).toBe(0);
  });

  it('refuses to overwrite if a user-created row already owns the destination code (Inventory case)', async () => {
    seedAccount('1300', 'Inventory');
    // User created their own custom 1305 account before the migration ran.
    seedAccount('1305', 'My Custom 1305');

    const result = await migrateCoaWave2(ORG, encryptText, decryptText);
    expect(result.skipped).toBeGreaterThanOrEqual(1);

    const snap = await decryptedSnapshot();
    // Original Inventory still at 1300 — not destroyed.
    expect(snap).toContainEqual({ code: '1300', name: 'Inventory' });
    // User's custom 1305 untouched.
    expect(snap).toContainEqual({ code: '1305', name: 'My Custom 1305' });
  });

  it("rename ordering: 3100 → 'Starting Balance' completes before 3000 → 'Owner's Equity', so no transient duplicate-name state", async () => {
    // If the order were reversed, we'd briefly have BOTH 3000 and 3100
    // decrypting to "Owner's Equity", and the second step would be refused
    // by the name-collision check. End state would be: 3000="Owner's Equity",
    // 3100 unchanged. We assert the correct end state instead.
    seedAccount('3000', 'Equity', 'EQUITY', 'Equity');
    seedAccount('3100', "Owner's Equity", 'EQUITY', 'Equity');

    const result = await migrateCoaWave2(ORG, encryptText, decryptText);
    expect(result.updated).toBe(2);
    expect(result.skipped).toBe(0);

    const snap = await decryptedSnapshot();
    expect(snap).toContainEqual({ code: '3100', name: 'Starting Balance' });
    expect(snap).toContainEqual({ code: '3000', name: "Owner's Equity" });
  });

  it('leaves a user-renamed account at the old code alone (matches on name AND code)', async () => {
    // User renamed 4000 from "Income" to "My Revenue" before the migration.
    seedAccount('4000', 'My Revenue', 'INCOME', 'Revenue');
    const result = await migrateCoaWave2(ORG, encryptText, decryptText);
    expect(result.updated).toBe(0);
    const snap = await decryptedSnapshot();
    expect(snap).toContainEqual({ code: '4000', name: 'My Revenue' });
  });
});
