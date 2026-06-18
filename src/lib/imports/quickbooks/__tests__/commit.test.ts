// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ParsedContact,
  ParsedJournalEntry,
  ParsedTrialBalanceAccount,
  QuickBooksClassification,
  QuickBooksClassificationResult,
  QuickBooksParsedData,
} from '../types';

// ── Supabase mock ─────────────────────────────────────────────────────────

interface FakeStore {
  chart_of_accounts: Array<Record<string, unknown>>;
  contacts: Array<Record<string, unknown>>;
  journal_entries: Array<Record<string, unknown>>;
  journal_entry_lines: Array<Record<string, unknown>>;
}

let store: FakeStore;

function makeSupabase() {
  function select(table: keyof FakeStore) {
    let filterOrg: string | null = null;
    let containsMatch: Record<string, unknown> | null = null;
    let selectColumns: string | null = null;
    const chain = {
      select(cols?: string) {
        selectColumns = cols ?? '*';
        return chain;
      },
      eq(col: string, value: string) {
        if (col === 'org_id') filterOrg = value;
        return chain;
      },
      contains(_col: string, match: Record<string, unknown>) {
        containsMatch = match;
        return chain;
      },
      then(onFulfilled: (v: { data: unknown; error: null }) => unknown) {
        const rows = store[table].filter((row) => {
          if (filterOrg !== null && row.org_id !== filterOrg) return false;
          if (containsMatch) {
            const meta = row.encrypted_metadata as Record<string, unknown> | null | undefined;
            if (!meta) return false;
            for (const [k, v] of Object.entries(containsMatch)) {
              if (meta[k] !== v) return false;
            }
          }
          return true;
        });
        const data = selectColumns === 'encrypted_metadata'
          ? rows.map((r) => ({ encrypted_metadata: r.encrypted_metadata }))
          : rows;
        return Promise.resolve({ data, error: null }).then(onFulfilled);
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
    const chain = {
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
    return chain;
  }

  return {
    from(table: keyof FakeStore) {
      return {
        select(cols?: string) {
          return select(table).select(cols);
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

// Stub buildJournalEntryLineInsert to avoid pulling the rate resolver into unit
// tests — it has its own suite. We return a minimal shape matching
// JournalEntryLineEncrypted.
vi.mock('@/lib/exchange/build-je-line-insert', () => ({
  async buildJournalEntryLineInsert(args: {
    debit: number;
    credit: number;
    account_name?: string | null;
    account_code?: string | null;
    description?: string | null;
  }) {
    return {
      insert: {
        account_name: args.account_name ?? null,
        account_code: args.account_code ?? null,
        description: args.description ?? null,
        encrypted_debit: `enc:${args.debit}`,
        encrypted_credit: `enc:${args.credit}`,
        encrypted_book_value: null,
        debit: 0,
        credit: 0,
        book_value: null,
        key_version: 2,
        encrypted_amount_native: null,
        encrypted_amount_primary: null,
        encrypted_posted_rate: null,
        encrypted_wallet_currency: null,
        primary_currency_at_posting: null,
        rate_pending: false,
        rate_asof: null,
        pinned_rate_id: null,
        dual_amounts_backfilled: false,
        manual_rate_reason: null,
        manual_rate_source: null,
      },
      pending: false,
      rate: 1,
      rateBucketTs: null,
    };
  },
}));

// Lazy import so the mocks above apply first.
import { commitQuickBooksImport, type CommitProgress } from '../commit';

// ── Helpers ──────────────────────────────────────────────────────────────

const encryptText = async (plaintext: string) => `enc(${plaintext})`;
const decryptText = async (cipher: string) => {
  const match = cipher.match(/^enc\((.*)\)$/);
  return match ? match[1] : cipher;
};

function mkAccount(name: string, debit = '100', credit = '0'): ParsedTrialBalanceAccount {
  return { name, code: null, debit, credit, balance: debit };
}

function mkContact(name: string, kind: ParsedContact['kind']): ParsedContact {
  return {
    name, kind, email: null, phone: null,
    street: null, city: null, state: null, country: null, zip: null,
  };
}

function mkJE(refNum: string, amount: number): ParsedJournalEntry {
  return {
    refNum,
    date: '2025-08-31',
    type: 'Journal',
    memo: null,
    lines: [
      { accountName: 'Checking', accountCode: null, debit: String(amount), credit: '0', nativeCurrency: 'USD', contactName: null, memo: null },
      { accountName: 'Sales', accountCode: null, debit: '0', credit: String(amount), nativeCurrency: 'USD', contactName: null, memo: null },
    ],
  };
}

function mkParsed(opts: {
  accounts?: ParsedTrialBalanceAccount[];
  contacts?: ParsedContact[];
  journalEntries?: ParsedJournalEntry[];
}): QuickBooksParsedData {
  return {
    trialBalanceAccounts: opts.accounts ?? [],
    contacts: opts.contacts ?? [],
    journalEntries: opts.journalEntries ?? [],
    balanceSheetLines: [],
    profitLossLines: [],
    errors: [],
  };
}

function mkClassification(name: string): QuickBooksClassification {
  if (/checking|cash|bank/i.test(name)) {
    return { accountType: 'ASSET', accountSubType: 'WALLETS', normalBalance: 'DEBIT', isWallet: true, isSystem: false };
  }
  if (/sales|revenue/i.test(name)) {
    return { accountType: 'INCOME', accountSubType: 'SALES', normalBalance: 'CREDIT', isWallet: false, isSystem: false };
  }
  return { accountType: 'EXPENSE', accountSubType: 'GENERAL_AND_ADMINISTRATIVE', normalBalance: 'DEBIT', isWallet: false, isSystem: false };
}

function classifyAll(accounts: ParsedTrialBalanceAccount[]): QuickBooksClassificationResult {
  const confident: Record<string, QuickBooksClassification> = {};
  for (const a of accounts) confident[a.name] = mkClassification(a.name);
  return { confident, ambiguous: [] };
}

const ORG = 'org-1';

beforeEach(() => {
  store = {
    chart_of_accounts: [],
    contacts: [],
    journal_entries: [],
    journal_entry_lines: [],
  };
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('commitQuickBooksImport', () => {
  it('writes encrypted account rows and never leaks plaintext names', async () => {
    const accounts = [mkAccount('Checking'), mkAccount('Sales')];
    const parsed = mkParsed({ accounts });
    const classifications = classifyAll(accounts);

    const result = await commitQuickBooksImport({
      orgId: ORG,
      primaryCurrency: 'USD',
      parsed,
      classifications,
      encryptText,
      decryptText,
    });

    expect(result.accountsCreated).toBe(2);
    expect(result.accountsSkipped).toBe(0);
    expect(store.chart_of_accounts).toHaveLength(2);

    for (const row of store.chart_of_accounts) {
      // Post-Phase-1: chart_of_accounts has no plaintext account_name column.
      // Everything customer-typed lives in encrypted_name. Supabase only sees
      // the ciphertext + structural UUIDs.
      expect(row.account_name).toBeUndefined();
      expect(row.encrypted_name).toMatch(/^enc\(/);
      // The two real account names must not leak through encrypted_name either.
      expect(row.encrypted_name).not.toBe('Checking');
      expect(row.encrypted_name).not.toBe('Sales');
    }
  });

  it('dedups accounts that already exist in the org (by decrypted name)', async () => {
    const accounts = [mkAccount('Checking'), mkAccount('Sales')];
    const parsed = mkParsed({ accounts });
    const classifications = classifyAll(accounts);

    // First run: writes 2.
    await commitQuickBooksImport({
      orgId: ORG, primaryCurrency: 'USD', parsed, classifications, encryptText, decryptText,
    });
    // Second run: skips both.
    const result2 = await commitQuickBooksImport({
      orgId: ORG, primaryCurrency: 'USD', parsed, classifications, encryptText, decryptText,
    });

    expect(result2.accountsCreated).toBe(0);
    expect(result2.accountsSkipped).toBe(2);
    expect(store.chart_of_accounts).toHaveLength(2);
  });

  it('redirects ambiguous accounts to Uncategorized Expense / Revenue by TB polarity', async () => {
    // Mystery Account is debit-balanced → falls back to Uncategorized Expense.
    // Other Mystery is credit-balanced → falls back to Uncategorized Revenue.
    const accounts = [
      mkAccount('Mystery Account', '500', '0'),
      mkAccount('Other Mystery', '0', '750'),
      mkAccount('Cash', '500', '0'),
    ];
    const journalEntry: ParsedJournalEntry = {
      refNum: 'QB-1',
      date: '2025-08-31',
      type: 'Journal',
      memo: null,
      lines: [
        { accountName: 'Mystery Account', accountCode: null, debit: '500', credit: '0', nativeCurrency: 'USD', contactName: null, memo: 'Original memo' },
        { accountName: 'Cash', accountCode: null, debit: '0', credit: '500', nativeCurrency: 'USD', contactName: null, memo: null },
      ],
    };
    const parsed = mkParsed({ accounts, journalEntries: [journalEntry] });
    const classifications: QuickBooksClassificationResult = {
      confident: { Cash: mkClassification('Cash') },
      ambiguous: ['Mystery Account', 'Other Mystery'],
    };

    const result = await commitQuickBooksImport({
      orgId: ORG, primaryCurrency: 'USD', parsed, classifications, encryptText, decryptText,
    });

    // Mystery Account / Other Mystery are NOT created — their lines route to
    // the shared Uncategorized buckets. Cash + Uncategorized Expense +
    // Uncategorized Revenue ARE created.
    expect(result.accountsFallback).toBe(2);
    expect(result.errors).toEqual([]);
    const created = store.chart_of_accounts.map((row) => row.encrypted_name);
    expect(created).toContain('enc(Uncategorized Expense)');
    expect(created).toContain('enc(Uncategorized Revenue)');
    expect(created).not.toContain('enc(Mystery Account)');
    expect(created).not.toContain('enc(Other Mystery)');

    // The JE line that referenced Mystery Account was rewritten on insert —
    // its account_name now reads "Uncategorized Expense" (the build-je-line
    // mock passes through plaintext) and the description carries the original
    // QB name as a "[QB: Mystery Account]" prefix so it isn't lost.
    const lines = store.journal_entry_lines as Array<Record<string, string>>;
    const redirected = lines.find((l) => l.account_name === 'Uncategorized Expense');
    expect(redirected).toBeDefined();
    expect(redirected!.description).toMatch(/^\[QB: Mystery Account\] Original memo/);
    // The other (non-ambiguous) Cash line is unchanged.
    const cashLine = lines.find((l) => l.account_name === 'Cash');
    expect(cashLine).toBeDefined();
  });

  it('applies an account override over the confident classification', async () => {
    const accounts = [mkAccount('Checking')]; // confident → WALLETS
    const parsed = mkParsed({ accounts });
    const classifications = classifyAll(accounts);
    const overrides = {
      Checking: {
        accountType: 'EXPENSE' as const,
        accountSubType: 'GENERAL_AND_ADMINISTRATIVE' as const,
        normalBalance: 'DEBIT' as const,
        isWallet: false,
        isSystem: false,
      },
    };

    await commitQuickBooksImport({
      orgId: ORG, primaryCurrency: 'USD', parsed, classifications,
      accountOverrides: overrides, encryptText, decryptText,
    });

    // Post-Phase-1: encrypted_account_type carries the encrypted EXPENSE override.
    // There is no separate account_group column; the friendly group label flows
    // through the encrypted_account_sub_type field.
    expect(store.chart_of_accounts[0].encrypted_account_type).toBe('enc(EXPENSE)');
    expect(store.chart_of_accounts[0].encrypted_account_sub_type).toBe(
      'enc(General & Administrative)',
    );
  });

  it('accepts a contacts-only bundle (no trial balance, no journal entries)', async () => {
    const parsed = mkParsed({
      contacts: [
        mkContact('Acme Corp', 'CUSTOMER'),
        mkContact('Beta Co', 'VENDOR'),
      ],
    });

    const result = await commitQuickBooksImport({
      orgId: ORG, primaryCurrency: 'USD', parsed,
      classifications: { confident: {}, ambiguous: [] },
      encryptText, decryptText,
    });

    expect(result.contactsCreated).toBe(2);
    expect(result.accountsCreated).toBe(0);
    expect(result.journalEntriesCreated).toBe(0);
    expect(result.linesCreated).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('accepts an accounts-only bundle (trial balance only, no journal, no contacts)', async () => {
    const accounts = [mkAccount('Checking'), mkAccount('Sales')];
    const parsed = mkParsed({ accounts });
    const classifications = classifyAll(accounts);

    const result = await commitQuickBooksImport({
      orgId: ORG, primaryCurrency: 'USD', parsed, classifications, encryptText, decryptText,
    });

    expect(result.accountsCreated).toBe(2);
    expect(result.contactsCreated).toBe(0);
    expect(result.journalEntriesCreated).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('rejects imports above the hard cap with a clear error', async () => {
    const accounts = [mkAccount('Checking'), mkAccount('Sales')];
    const tooMany = Array.from({ length: 100_001 }, (_, i) => mkJE(`QB-OVERSIZED-${i}`, 1));
    const parsed = mkParsed({ accounts, journalEntries: tooMany });
    const classifications = classifyAll(accounts);

    await expect(
      commitQuickBooksImport({
        orgId: ORG, primaryCurrency: 'USD', parsed, classifications, encryptText, decryptText,
      }),
    ).rejects.toThrow(/100,000/);
  });

  it('writes contacts encrypted with per-kind dedup', async () => {
    const parsed = mkParsed({
      contacts: [
        mkContact('Acme Corp', 'CUSTOMER'),
        mkContact('Acme Corp', 'CUSTOMER'), // same → dedup within batch
        mkContact('Acme Corp', 'VENDOR'),   // same name diff kind → keep
      ],
    });

    const result = await commitQuickBooksImport({
      orgId: ORG, primaryCurrency: 'USD', parsed,
      classifications: { confident: {}, ambiguous: [] },
      encryptText, decryptText,
    });

    expect(result.contactsCreated).toBe(2);
    expect(result.contactsSkipped).toBe(1);
    for (const row of store.contacts) {
      expect(row.name).toMatch(/^enc\(/);
    }
  });

  it('writes journal entries with plaintext ref_num in encrypted_metadata for idempotent dedup', async () => {
    const accounts = [mkAccount('Checking'), mkAccount('Sales')];
    const parsed = mkParsed({ accounts, journalEntries: [mkJE('QB-20250831-A-1', 100)] });
    const classifications = classifyAll(accounts);

    const result = await commitQuickBooksImport({
      orgId: ORG, primaryCurrency: 'USD', parsed, classifications, encryptText, decryptText,
    });

    expect(result.journalEntriesCreated).toBe(1);
    expect(result.linesCreated).toBe(2);
    const je = store.journal_entries[0] as {
      encrypted_metadata: Record<string, string>;
      encrypted_ref_number: string;
    };
    expect(je.encrypted_metadata).toMatchObject({
      source: 'quickbooks',
      qb_ref_num: 'QB-20250831-A-1',
    });
    expect(je.encrypted_metadata.import_id).toEqual(result.importId);
    // ref_number is encrypted (encrypted_ref_number column); encrypted_metadata.qb_ref_num
    // is the plaintext dedup tag — confirm we keep both shapes.
    expect(je.encrypted_ref_number).toMatch(/^enc\(/);
  });

  it('is idempotent — re-running skips journal entries already imported by qb_ref_num', async () => {
    const accounts = [mkAccount('Checking'), mkAccount('Sales')];
    const parsed = mkParsed({
      accounts,
      journalEntries: [mkJE('QB-20250831-A-1', 100), mkJE('QB-20250831-A-2', 200)],
    });
    const classifications = classifyAll(accounts);

    await commitQuickBooksImport({
      orgId: ORG, primaryCurrency: 'USD', parsed, classifications, encryptText, decryptText,
    });
    const second = await commitQuickBooksImport({
      orgId: ORG, primaryCurrency: 'USD', parsed, classifications, encryptText, decryptText,
    });

    expect(second.journalEntriesCreated).toBe(0);
    expect(second.journalEntriesSkipped).toBe(2);
    expect(store.journal_entries).toHaveLength(2);
  });

  it('emits progress updates across stages', async () => {
    const accounts = [mkAccount('Checking'), mkAccount('Sales')];
    const parsed = mkParsed({
      accounts,
      contacts: [mkContact('Acme Corp', 'CUSTOMER')],
      journalEntries: [mkJE('QB-20250831-A-1', 100)],
    });
    const classifications = classifyAll(accounts);
    const seen: CommitProgress[] = [];

    await commitQuickBooksImport({
      orgId: ORG, primaryCurrency: 'USD', parsed, classifications, encryptText, decryptText,
      onProgress: (p) => seen.push(p),
    });

    const stages = new Set(seen.map((p) => p.stage));
    expect(stages).toContain('preparing');
    expect(stages).toContain('accounts');
    expect(stages).toContain('contacts');
    expect(stages).toContain('journal-entries');
    expect(stages).toContain('finalizing');
  });
});
