import { beforeEach, describe, expect, it, vi } from 'vitest';

type Call = { table: string; op: string; payload?: unknown };
const state: {
  calls: Call[];
  voidRows: Array<{ id: string }>;
  lines: Array<Record<string, unknown>>;
  existing: Array<{ id: string }>;
} = { calls: [], voidRows: [{ id: 'je-1' }], lines: [], existing: [] };

vi.mock('@/lib/supabase', () => {
  const from = (table: string) => {
    let op = 'select';
    let payload: unknown;
    const q: Record<string, unknown> = {};
    const done = () => {
      state.calls.push({ table, op, payload });
      if (table === 'journal_entries' && op === 'select')
        return {
          data: { id: 'je-1', key_version: 2, memo: 'C_m', currency: 'C_MXN', status: 'POSTED' },
          error: null,
        };
      if (table === 'journal_entries' && op === 'insert')
        return { data: { id: 'rev-1' }, error: null };
      if (table === 'journal_entries' && op === 'update')
        return { data: state.voidRows, error: null };
      if (table === 'journal_entry_lines' && op === 'select')
        return { data: state.lines, error: null };
      return { data: null, error: null };
    };
    Object.assign(q, {
      select: () => q,
      insert: (v: unknown) => ((op = 'insert'), (payload = v), q),
      update: (v: unknown) => ((op = 'update'), (payload = v), q),
      eq: () => (table === 'journal_entry_lines' && op === 'select' ? done() : q),
      single: async () => done(),
      limit: async () => {
        state.calls.push({ table, op: 'select-existing' });
        return { data: state.existing, error: null };
      },
      then: (res: (v: unknown) => void) => res(done()),
    });
    return q;
  };
  return { supabase: { from } };
});
vi.mock('@/lib/audit-logger', () => ({ writeAuditLog: vi.fn() }));
vi.mock('@/lib/transactions/org-primary-currency', () => ({
  loadOrgPrimaryCurrency: async () => 'BTC',
}));

import { reverseJournalEntry } from '../reverse-journal-entry';
import { writeAuditLog } from '@/lib/audit-logger';

const encryptText = async (s: string) => `C_${s}`;
const decryptText = async (s: string) => s.replace(/^C_/, '');

function line(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    account_id: `acct-${id}`,
    account_name: 'C_Cash',
    account_code: null,
    description: null,
    encrypted_debit: 'C_0',
    encrypted_credit: 'C_0',
    encrypted_book_value: null,
    encrypted_amount_native: null,
    encrypted_amount_primary: null,
    encrypted_posted_rate: 'C_0.5',
    encrypted_wallet_currency: 'C_MXN',
    encrypted_primary_currency_at_posting: 'C_BTC',
    rate_pending: false,
    rate_asof: null,
    pinned_rate_id: 'r1',
    key_version: 2,
    ...over,
  };
}

beforeEach(() => {
  state.calls = [];
  state.voidRows = [{ id: 'je-1' }];
  state.existing = [];
  state.lines = [
    line('a', {
      encrypted_debit: 'C_10',
      encrypted_amount_native: 'C_10',
      encrypted_amount_primary: 'C_5',
    }),
    line('b', {
      encrypted_credit: 'C_10',
      encrypted_amount_native: 'C_-10',
      encrypted_amount_primary: 'C_-5',
    }),
  ];
  vi.mocked(writeAuditLog).mockClear();
});

const run = () =>
  reverseJournalEntry({
    journalEntryId: 'je-1',
    orgId: 'org-1',
    date: '2026-10-01',
    encryptText,
    decryptText,
  });

describe('reverseJournalEntry', () => {
  it('reports the original as voided when the update changed it', async () => {
    const r = await run();
    expect(r).toEqual({ reversalJournalEntryId: 'rev-1', originalVoided: true });
    const lines = state.calls.find((c) => c.table === 'journal_entry_lines' && c.op === 'insert')!
      .payload as Array<Record<string, unknown>>;
    expect(lines.map((l) => l.encrypted_amount_primary)).toEqual(['C_-5', 'C_5']);
    expect(lines.every((l) => l.journal_entry_id === 'rev-1')).toBe(true);
  });

  it('says the original stayed posted when the closed month let no row change', async () => {
    state.voidRows = [];
    const r = await run();
    expect(r.originalVoided).toBe(false);
    const audit = vi.mocked(writeAuditLog).mock.calls[0][0] as {
      summary: string;
      after: Record<string, unknown>;
    };
    expect(audit.after.original_voided).toBe(false);
    expect(audit.summary).toContain('original left posted');
  });

  it('writes nothing when a line cannot be reversed', async () => {
    state.lines[1] = line('b', {
      encrypted_credit: 'C_10',
      encrypted_amount_primary: 'C_-5',
      encrypted_primary_currency_at_posting: 'BAD',
    });
    const dec = async (s: string) => {
      if (s === 'BAD') throw new Error('bad');
      return decryptText(s);
    };
    await expect(
      reverseJournalEntry({
        journalEntryId: 'je-1',
        orgId: 'org-1',
        date: '2026-10-01',
        encryptText,
        decryptText: dec,
      }),
    ).rejects.toThrow('cannot be read');
    expect(state.calls.filter((c) => !c.op.startsWith('select'))).toEqual([]);
  });

  it('refuses an entry that already has a reversal, before writing anything', async () => {
    state.existing = [{ id: 'rev-0' }];
    await expect(run()).rejects.toThrow('already been reversed');
    expect(state.calls.some((c) => c.op === 'select-existing')).toBe(true);
    expect(state.calls.filter((c) => !c.op.startsWith('select'))).toEqual([]);
  });
});
