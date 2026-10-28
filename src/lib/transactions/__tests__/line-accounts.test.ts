// @vitest-environment node
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  ensureWalletChartAccountIds,
  loadChartNameIndex,
  requireAccountIdByName,
} from '../line-accounts';

// A small in-memory stand-in for the Supabase query builder, enough for the
// select / insert / update chains line-accounts.ts uses.
type Row = Record<string, unknown>;
interface FakeQuery {
  select(): FakeQuery;
  insert(p: Row): FakeQuery;
  update(p: Row): FakeQuery;
  eq(c: string, v: unknown): FakeQuery;
  in(c: string, v: unknown[]): FakeQuery;
  single(): Promise<{ data: Row; error: null }>;
  then(resolve: (v: unknown) => void): void;
}
function fakeClient(tables: Record<string, Row[]>) {
  let n = 0;
  const client = {
    from(table: string) {
      const rows = (tables[table] ??= []);
      const filters: Array<(r: Row) => boolean> = [];
      let mode: 'select' | 'insert' | 'update' = 'select';
      let payload: Row = {};
      const q: FakeQuery = {
        select: () => q,
        insert: (p: Row) => {
          mode = 'insert';
          payload = p;
          return q;
        },
        update: (p: Row) => {
          mode = 'update';
          payload = p;
          return q;
        },
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), q),
        single: async () => {
          const row = { id: `new-${++n}`, ...payload };
          rows.push(row);
          return { data: row, error: null };
        },
        then: (resolve: (v: unknown) => void) => {
          const hit = rows.filter((r) => filters.every((f) => f(r)));
          if (mode === 'update') hit.forEach((r) => Object.assign(r, payload));
          resolve({ data: hit, error: null });
        },
      };
      return q;
    },
  };
  return client as unknown as SupabaseClient;
}

const encrypt = async (s: string) => `enc:${s}`;
const decrypt = async (s: string) => s.replace(/^enc:/, '');

describe('ensureWalletChartAccountIds', () => {
  it('returns the linked chart account of a wallet', async () => {
    const tables = {
      wallets: [{ id: 'w1', org_id: 'o', external_account_id: 'c1' }],
      chart_of_accounts: [{ id: 'c1', org_id: 'o' }],
    };
    const ids = await ensureWalletChartAccountIds(
      fakeClient(tables),
      'o',
      [{ id: 'w1', name: 'Cash' }],
      encrypt,
    );
    expect(ids.get('w1')).toBe('c1');
    expect(tables.chart_of_accounts).toHaveLength(1);
  });

  it('creates and links an account for a wallet with none', async () => {
    const tables: Record<string, Row[]> = {
      wallets: [{ id: 'w1', org_id: 'o', external_account_id: null }],
      chart_of_accounts: [],
    };
    const ids = await ensureWalletChartAccountIds(
      fakeClient(tables),
      'o',
      [{ id: 'w1', name: 'Cash' }],
      encrypt,
    );
    const created = tables.chart_of_accounts[0];
    expect(ids.get('w1')).toBe(created.id);
    expect(created.encrypted_name).toBe('enc:Cash');
    expect(created).not.toHaveProperty('external_account_id');
    expect(tables.wallets[0].external_account_id).toBe(created.id);
  });

  it('replaces a link that points at a missing account', async () => {
    const tables: Record<string, Row[]> = {
      wallets: [{ id: 'w1', org_id: 'o', external_account_id: 'gone' }],
      chart_of_accounts: [],
    };
    const ids = await ensureWalletChartAccountIds(
      fakeClient(tables),
      'o',
      [{ id: 'w1', name: 'Cash' }],
      encrypt,
    );
    expect(ids.get('w1')).not.toBe('gone');
    expect(tables.wallets[0].external_account_id).toBe(ids.get('w1'));
  });

  it('refuses a wallet from another organization', async () => {
    const tables = { wallets: [{ id: 'w1', org_id: 'other', external_account_id: 'c1' }] };
    await expect(
      ensureWalletChartAccountIds(fakeClient(tables), 'o', [{ id: 'w1', name: 'Cash' }], encrypt),
    ).rejects.toThrow('not found');
  });
});

describe('requireAccountIdByName', () => {
  const chart = async () =>
    loadChartNameIndex(
      fakeClient({
        chart_of_accounts: [
          {
            id: 'a1',
            org_id: 'o',
            encrypted_name: "enc:Owner's Equity",
            encrypted_account_type: 'enc:EQUITY',
            encrypted_is_group: 'enc:false',
            encrypted_is_system: 'enc:false',
          },
          {
            id: 'a2',
            org_id: 'o',
            encrypted_name: 'enc:Sales',
            encrypted_account_type: 'enc:INCOME',
            encrypted_is_group: 'enc:false',
            encrypted_is_system: 'enc:false',
          },
          {
            id: 'a3',
            org_id: 'o',
            encrypted_name: 'enc:sales ',
            encrypted_account_type: 'enc:INCOME',
            encrypted_is_group: 'enc:false',
            encrypted_is_system: 'enc:false',
          },
        ],
      }),
      'o',
      decrypt,
    );

  it('finds an account by name, ignoring case and spaces', async () => {
    expect(requireAccountIdByName(await chart(), "  owner's equity")).toBe('a1');
  });

  it('refuses an unknown name', async () => {
    const idx = await chart();
    expect(() => requireAccountIdByName(idx, 'Rent')).toThrow('not in the chart');
  });

  it('refuses a name two accounts share', async () => {
    const idx = await chart();
    expect(() => requireAccountIdByName(idx, 'Sales')).toThrow('More than one');
  });

  it('refuses a blank name', async () => {
    const idx = await chart();
    expect(() => requireAccountIdByName(idx, '')).toThrow('needs an account');
  });
});
