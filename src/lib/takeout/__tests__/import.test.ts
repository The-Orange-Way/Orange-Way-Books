// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TakeoutFile, TakeoutLegacyAccount } from '../schema';
import { importTakeoutFile, validateTakeoutFile } from '../import';
import { generateCoffeeShop } from '../seed/coffee-shop';
import { generateMinerCompany } from '../seed/miner-company';
import { encryptWallet, decryptWallet } from '@/lib/crypto-fields';

// ── Supabase fake ─────────────────────────────────────────────────────────
// Enforces the database rules a restore has broken before:
//  - wallets has no account_type column (the column is wallet_type)
//  - chart_of_accounts.parent_id must point at a row that already exists
//  - journal_entry_lines.account_id is NOT NULL and must point at a chart row
//  - journal_entries.status / source_type CHECK constraints
//  - primary keys are unique
//  - finalized journal entries and their lines cannot be deleted

type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

const WALLET_COLUMNS = new Set([
  'asset',
  'external_account_code',
  'external_account_id',
  'connection_type',
  'created_at',
  'dek_key_version',
  'encrypted_balance',
  'encrypted_metadata',
  'encrypted_name',
  'exchange_rate',
  'id',
  'initial_balance',
  'key_version',
  'last_sync_at',
  'org_id',
  'sync_status',
  'wallet_type',
]);

const TABLES = [
  'org_period_closes',
  'organizations',
  'org_settings',
  'wallets',
  'chart_of_accounts',
  'contacts',
  'transactions',
  'journal_entries',
  'journal_entry_lines',
  'payment_requests',
  'attachments',
];

let store: Store;
let insertOrder: Array<{ table: string; id: unknown }>;

function emptyStore(): Store {
  return Object.fromEntries(TABLES.map((t) => [t, [] as Row[]]));
}

const JE_STATUS = ['DRAFT', 'POSTED', 'VOID', 'VOID_REVERSAL'];
const JE_SOURCE = [
  'manual',
  'or_import',
  'invoice',
  'payment',
  'void_reversal',
  'fx_revaluation',
  'opening_balance',
  'takeout_import',
];
const FINALIZED = ['POSTED', 'VOID', 'VOID_REVERSAL'];

function checkInsert(table: string, row: Row): string | null {
  if (row.id != null && store[table].some((r) => r.id === row.id)) {
    return `duplicate key value violates unique constraint "${table}_pkey"`;
  }
  if (table === 'journal_entries') {
    if (!JE_STATUS.includes(String(row.status))) {
      return 'new row for relation "journal_entries" violates check constraint (status)';
    }
    if (row.source_type != null && !JE_SOURCE.includes(String(row.source_type))) {
      return 'new row for relation "journal_entries" violates check constraint (source_type)';
    }
  }
  if (table === 'wallets') {
    for (const key of Object.keys(row)) {
      if (!WALLET_COLUMNS.has(key)) {
        return `Could not find the '${key}' column of 'wallets' in the schema cache`;
      }
    }
  }
  if (table === 'chart_of_accounts' && row.parent_id != null) {
    if (!store.chart_of_accounts.some((r) => r.id === row.parent_id)) {
      return 'insert or update on table "chart_of_accounts" violates foreign key constraint "chart_of_accounts_parent_fk"';
    }
  }
  if (table === 'journal_entry_lines') {
    if (row.account_id == null) {
      return 'null value in column "account_id" violates not-null constraint';
    }
    if (!store.chart_of_accounts.some((r) => r.id === row.account_id)) {
      return 'insert or update on table "journal_entry_lines" violates foreign key constraint';
    }
    if (!store.journal_entries.some((r) => r.id === row.journal_entry_id)) {
      return 'journal_entry_id does not exist';
    }
  }
  return null;
}

function result<T>(value: T) {
  return { then: (f: (v: T) => unknown) => Promise.resolve(value).then(f) };
}

function makeSupabase() {
  return {
    storage: {
      from() {
        return {
          remove: async () => ({ data: null, error: null }),
          upload: async () => ({ data: null, error: null }),
        };
      },
    },
    from(table: string) {
      return {
        select(_cols?: string, opts?: { count?: string; head?: boolean }) {
          const filters: Array<(r: Row) => boolean> = [];
          const chain = {
            order() {
              return chain;
            },
            limit() {
              return chain;
            },
            eq(col: string, value: unknown) {
              filters.push((r) => r[col] === value);
              return chain;
            },
            in(col: string, values: unknown[]) {
              filters.push((r) => values.includes(r[col]));
              return chain;
            },
            then(f: (v: unknown) => unknown) {
              const rows = store[table].filter((r) => filters.every((keep) => keep(r)));
              const value = opts?.head
                ? { count: rows.length, error: null }
                : { data: rows, error: null };
              return Promise.resolve(value).then(f);
            },
          };
          return chain;
        },
        insert(payload: Row | Row[]) {
          const rows = Array.isArray(payload) ? payload : [payload];
          for (const row of rows) {
            const message = checkInsert(table, row);
            if (message) return result({ data: null, error: { message } });
          }
          for (const row of rows) {
            const withId = { id: crypto.randomUUID(), ...row };
            store[table].push(withId);
            insertOrder.push({ table, id: withId.id });
          }
          return result({ data: null, error: null });
        },
        upsert(payload: Row) {
          store[table].push(payload);
          return result({ data: null, error: null });
        },
        update() {
          return { eq: () => result({ data: null, error: null }) };
        },
        delete() {
          const remove = (match: (r: Row) => boolean) => {
            const doomed = store[table].filter(match);
            const locked = doomed.some((r) =>
              table === 'journal_entries'
                ? FINALIZED.includes(String(r.status))
                : table === 'journal_entry_lines' &&
                  store.journal_entries.some(
                    (je) => je.id === r.journal_entry_id && FINALIZED.includes(String(je.status)),
                  ),
            );
            if (locked) {
              return result({
                data: null,
                error: { message: 'Cannot delete finalized journal entry' },
              });
            }
            store[table] = store[table].filter((r) => !match(r));
            return result({ data: null, error: null });
          };
          return {
            eq: (col: string, value: unknown) => remove((r) => r[col] === value),
            in: (col: string, values: unknown[]) => remove((r) => values.includes(r[col])),
          };
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

const ORG = '00000000-0000-4000-8000-000000000001';
const encrypt = async (s: string) => `enc:${s}`;
const decrypt = async (s: string) => s.replace(/^enc:/, '');

beforeEach(() => {
  store = emptyStore();
  insertOrder = [];
});

function expectLinesPointAtInsertedAccounts() {
  const chartIds = new Set(store.chart_of_accounts.map((r) => r.id));
  expect(store.journal_entry_lines.length).toBeGreaterThan(0);
  for (const line of store.journal_entry_lines) {
    expect(chartIds.has(line.account_id)).toBe(true);
  }
}

// An export-shaped file: chart rows referenced by id (id === legacy_account_id),
// with the child listed before its parent.
function exportShapedFile(): TakeoutFile {
  const parent: TakeoutLegacyAccount = {
    id: 'acct-parent',
    legacy_account_id: 'acct-parent',
    account_name: 'Bank',
    account_code: '1100',
    account_type: 'Asset',
    account_group: 'Bank',
    account_category: null,
  };
  const child: TakeoutLegacyAccount = {
    id: 'acct-child',
    legacy_account_id: 'acct-child',
    account_name: 'Operating account',
    account_code: '1101',
    account_type: 'Asset',
    account_group: 'Bank',
    account_category: null,
    parent_legacy_account_id: 'acct-parent',
  };
  const equity: TakeoutLegacyAccount = {
    id: 'acct-equity',
    legacy_account_id: 'acct-equity',
    account_name: 'Owner equity',
    account_code: '3000',
    account_type: 'Equity',
    account_group: 'Equity',
    account_category: null,
  };
  return {
    _meta: {
      version: 1,
      exportedAt: '2026-01-01T00:00:00Z',
      encryption: 'none',
      sourceOrgName: 'Test Co',
      sourceOrgId: 'src-org',
      tables: [],
    },
    data: {
      organizations: [],
      org_settings: [],
      wallets: [
        {
          id: 'wallet-1',
          name: 'Operating',
          asset: 'USD',
          account_type: 'Bank',
          initial_balance: 0,
          legacy_account_id: 'acct-child',
        },
      ],
      chart_of_accounts: [child, parent, equity],
      contacts: [],
      transactions: [],
      journal_entries: [
        {
          id: 'je-1',
          date: '2026-01-01',
          memo: 'Opening balance',
          ref_number: null,
          currency: 'USD',
          exchange_rate: null,
          status: 'posted',
          source_type: null,
          period_locked: false,
        },
      ],
      journal_entry_lines: [
        {
          id: 'line-1',
          journal_entry_id: 'je-1',
          account_id: 'acct-child',
          account_name: 'Operating account',
          account_code: '1101',
          debit: 100,
          credit: 0,
          description: null,
        },
        {
          id: 'line-2',
          journal_entry_id: 'je-1',
          account_id: 'acct-equity',
          account_name: 'Owner equity',
          account_code: '3000',
          debit: 0,
          credit: 100,
          description: null,
        },
      ],
      payment_requests: [],
      attachments: [],
    },
  };
}

describe('wallet column mapping', () => {
  it('writes wallet_type and never account_type', async () => {
    const enc = await encryptWallet(
      {
        encrypted_name: 'Operating',
        initial_balance: 0,
        asset: 'USD',
        account_type: 'Bank',
        connection_type: 'manual',
        external_account_code: null,
      },
      encrypt,
    );
    expect(enc).toHaveProperty('wallet_type', 'enc:Bank');
    expect(enc).not.toHaveProperty('account_type');
  });

  it('reads the type back from wallet_type', async () => {
    const dec = await decryptWallet(
      {
        encrypted_name: 'enc:Operating',
        encrypted_balance: null,
        initial_balance: 0,
        asset: 'enc:USD',
        wallet_type: 'enc:Bank',
        connection_type: null,
        external_account_code: null,
        key_version: 2,
      },
      decrypt,
    );
    expect(dec.account_type).toBe('Bank');
  });
});

describe('importTakeoutFile', () => {
  it('restores the coffee shop sample with every line on a real account', async () => {
    const result = await importTakeoutFile(generateCoffeeShop(), ORG, encrypt, { force: true });
    expect(result.wallets).toBeGreaterThan(0);
    expect(store.wallets.every((w) => !('account_type' in w))).toBe(true);
    expectLinesPointAtInsertedAccounts();
  });

  it('restores the miner sample with every line on a real account', async () => {
    const result = await importTakeoutFile(generateMinerCompany(), ORG, encrypt, { force: true });
    expect(result.wallets).toBeGreaterThan(0);
    expectLinesPointAtInsertedAccounts();
  });

  it('restores an export-shaped file: parents first, links on the inserted ids', async () => {
    await importTakeoutFile(exportShapedFile(), ORG, encrypt, { force: true });
    expectLinesPointAtInsertedAccounts();
    const chart = store.chart_of_accounts;
    const parent = chart.find((r) => r.encrypted_name === 'enc:Bank')!;
    const child = chart.find((r) => r.encrypted_name === 'enc:Operating account')!;
    expect(child.parent_id).toBe(parent.id);
    const order = insertOrder.filter((e) => e.table === 'chart_of_accounts').map((e) => e.id);
    expect(order.indexOf(parent.id)).toBeLessThan(order.indexOf(child.id));
    expect(store.wallets[0].external_account_id).toBe(child.id);
  });

  it('refuses a broken file in force mode before wiping anything', async () => {
    store.contacts.push({ id: 'keep-me', org_id: ORG });
    const file = exportShapedFile();
    const broken: TakeoutFile = {
      ...file,
      data: {
        ...file.data,
        journal_entry_lines: [
          { ...file.data.journal_entry_lines[0], account_id: 'acct-missing' },
          file.data.journal_entry_lines[1],
        ],
      },
    };
    await expect(importTakeoutFile(broken, ORG, encrypt, { force: true })).rejects.toThrow(
      /Nothing was changed/,
    );
    expect(store.contacts).toEqual([{ id: 'keep-me', org_id: ORG }]);
    expect(insertOrder).toEqual([]);
  });

  it('stores restored entries with a status and source the database accepts', async () => {
    const file = exportShapedFile();
    const second = { ...file.data.journal_entries[0], id: 'je-2', source_type: 'VOID_REVERSAL' };
    const third = { ...file.data.journal_entries[0], id: 'je-3', source_type: 'seed' };
    await importTakeoutFile(
      {
        ...file,
        data: { ...file.data, journal_entries: [...file.data.journal_entries, second, third] },
      },
      ORG,
      encrypt,
      { force: true },
    );
    const [first, reversal, sample] = store.journal_entries;
    expect(first.status).toBe('POSTED');
    // null stays null so the app still offers reversal on hand-entered entries
    expect(first.source_type).toBeNull();
    expect(reversal.source_type).toBe('void_reversal');
    expect(sample.source_type).toBeNull();
  });

  it('refuses force mode on a company with posted entries before deleting anything', async () => {
    store.payment_requests.push({ id: 'pr-1', org_id: ORG });
    store.journal_entries.push({ id: 'je-old', org_id: ORG, status: 'POSTED' });
    await expect(
      importTakeoutFile(exportShapedFile(), ORG, encrypt, { force: true }),
    ).rejects.toThrow(/1 finalized journal entries/);
    expect(store.payment_requests).toHaveLength(1);
    expect(store.journal_entries).toHaveLength(1);
    expect(insertOrder).toEqual([]);
  });

  it('refuses a backup with entries inside a closed period before deleting anything', async () => {
    store.contacts.push({ id: 'keep-me', org_id: ORG });
    store.org_period_closes.push({ org_id: ORG, locked_through_date: '2026-03-31' });
    await expect(
      importTakeoutFile(exportShapedFile(), ORG, encrypt, { force: true }),
    ).rejects.toThrow(/closed through 2026-03-31, and 1 entries/);
    expect(store.contacts).toHaveLength(1);
    expect(insertOrder).toEqual([]);
  });

  it('refuses to add a second chart on top of a default chart without force', async () => {
    store.chart_of_accounts.push(
      { id: 'default-1', org_id: ORG },
      { id: 'default-2', org_id: ORG },
    );
    await expect(importTakeoutFile(exportShapedFile(), ORG, encrypt)).rejects.toThrow(
      /2 chart of accounts rows/,
    );
    expect(store.chart_of_accounts).toHaveLength(2);
    expect(insertOrder).toEqual([]);
  });
});

describe('validateTakeoutFile', () => {
  it('accepts both sample files and an export-shaped file', () => {
    expect(validateTakeoutFile(generateCoffeeShop())).toEqual([]);
    expect(validateTakeoutFile(generateMinerCompany())).toEqual([]);
    expect(validateTakeoutFile(exportShapedFile())).toEqual([]);
  });

  it('reports two accounts sharing a reference', () => {
    const file = exportShapedFile();
    const [child, parent, equity] = file.data.chart_of_accounts;
    const clash: TakeoutFile = {
      ...file,
      data: {
        ...file.data,
        chart_of_accounts: [child, parent, { ...equity, legacy_account_id: 'acct-parent' }],
      },
    };
    expect(validateTakeoutFile(clash)).toEqual(['Two accounts share the reference acct-parent']);
  });

  it('reports an account with no type and a missing section', () => {
    const file = exportShapedFile();
    const [child, parent, equity] = file.data.chart_of_accounts;
    const noType = {
      ...file,
      data: {
        ...file.data,
        chart_of_accounts: [child, parent, { ...equity, account_type: null as unknown as string }],
      },
    };
    expect(validateTakeoutFile(noType)).toEqual(['An account is missing its id, name or type']);
    const noLines = {
      ...file,
      data: { ...file.data, journal_entry_lines: undefined as unknown as [] },
    };
    expect(validateTakeoutFile(noLines)).toEqual([
      'The file is missing these sections: journal_entry_lines',
    ]);
  });

  it('reports impossible dates, non-text status, empty items and duplicate lines', () => {
    const file = exportShapedFile();
    const je = file.data.journal_entries[0];
    const line = file.data.journal_entry_lines[0];
    const withData = (data: Partial<TakeoutFile['data']>) => ({
      ...file,
      data: { ...file.data, ...data },
    });
    expect(
      validateTakeoutFile(withData({ journal_entries: [{ ...je, date: '2026-02-30' }] })),
    ).toEqual(['Journal entry je-1 is missing a valid date or currency']);
    expect(
      validateTakeoutFile(
        withData({ journal_entries: [{ ...je, status: ['POSTED'] as unknown as string }] }),
      ),
    ).toEqual(['The journal_entries section has a field that is not text, a number or empty']);
    expect(validateTakeoutFile(withData({ journal_entries: [{ ...je, status: 'SENT' }] }))).toEqual(
      ['Journal entry je-1 has an unknown status "SENT"'],
    );
    expect(validateTakeoutFile(withData({ org_settings: [null as never] }))).toEqual([
      'The org_settings section has an empty or invalid item',
    ]);
    expect(
      validateTakeoutFile(
        withData({ journal_entry_lines: [...file.data.journal_entry_lines, { ...line }] }),
      ),
    ).toEqual(['Two journal lines share the id line-1']);
    expect(
      validateTakeoutFile(withData({ journal_entries: [{ ...je, date: '2026-01-01\u0000' }] })),
    ).toEqual(['The file contains an invalid character (NUL)']);
    expect(
      validateTakeoutFile(
        withData({ journal_entries: [{ ...je, date: '2026-01-01T00:00:00+16:00' }] }),
      ),
    ).toEqual(['Journal entry je-1 is missing a valid date or currency']);
    expect(
      validateTakeoutFile(
        withData({
          attachments: [
            {
              entity_type: 'payment_request\u0000',
              entity_id: 'x',
              file_name: 'a.txt',
              file_size: 1,
              content_base64: 'YQ==',
            } as never,
          ],
        }),
      ),
    ).toEqual(['The file contains an invalid character (NUL)']);
    expect(
      validateTakeoutFile(
        withData({
          attachments: [
            {
              id: 'att-1',
              entity_type: 'transaction',
              entity_id: 'x',
              file_name: 'a.txt',
              file_size: 2147483648,
              mime_type: 'text/plain',
              content_base64: 'YQ==',
            } as never,
          ],
        }),
      ),
    ).toEqual(['Receipt att-1 has an invalid kind, name or size']);
    const receipt = {
      id: 'att-2',
      entity_type: 'transaction' as const,
      entity_id: 'tx-1',
      file_name: 'a.txt',
      file_size: 1,
      mime_type: null,
      content_base64: 'YQ==',
    };
    const tx = {
      id: 'tx-1',
      account_id: null,
      date: '2026-01-01',
      type: 'INCOME',
      asset: 'USD',
      amount: 1,
    } as never;
    expect(validateTakeoutFile(withData({ transactions: [tx], attachments: [receipt] }))).toEqual(
      [],
    );
    expect(validateTakeoutFile(withData({ attachments: [receipt] }))).toEqual([
      'Receipt att-2 points at a record that is not in the file',
    ]);
    expect(
      validateTakeoutFile(
        withData({ transactions: [tx], attachments: [{ ...receipt, content_base64: '!' }] }),
      ),
    ).toEqual(['Receipt att-2 has unreadable contents']);
    expect(
      validateTakeoutFile(
        withData({
          contacts: [{ id: 'c-1', name: 'A', type: 'Vendor', email: { toString: null } } as never],
        }),
      ),
    ).toEqual(['The contacts section has a field that is not text, a number or empty']);
    expect(
      validateTakeoutFile(
        withData({ journal_entries: [{ ...je, date: '2026-01-01T10:30:00.123+00:00' }] }),
      ),
    ).toEqual([]);
    expect(
      validateTakeoutFile(
        withData({ journal_entries: [{ ...je, source_type: 123 as unknown as string }] }),
      ),
    ).toEqual(['Journal entry je-1 has an invalid source type or exchange rate']);
    expect(
      validateTakeoutFile(
        withData({
          wallets: [{ ...file.data.wallets[0], initial_balance: '5' as unknown as number }],
        }),
      ),
    ).toEqual(['A wallet is missing its id, name, asset or opening balance']);
  });

  it('reports a parent loop', () => {
    const file = exportShapedFile();
    const [child, parent, equity] = file.data.chart_of_accounts;
    const looped: TakeoutFile = {
      ...file,
      data: {
        ...file.data,
        chart_of_accounts: [child, { ...parent, parent_legacy_account_id: 'acct-child' }, equity],
      },
    };
    expect(validateTakeoutFile(looped)).toEqual(['The chart of accounts has a parent loop']);
  });
});
