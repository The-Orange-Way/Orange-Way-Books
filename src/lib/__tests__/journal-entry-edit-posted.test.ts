// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  EDIT_LINE_KEYS,
  buildEditPostedEntryArgs,
  editPostedEntry,
  fetchEntryHistory,
  planPostedEditLines,
  type BuildLineParams,
  type EditLine,
  type StoredEditLine,
  type EditPostedEntryInput,
} from '../journal-entry-edit-posted';

function line(over: Partial<EditLine> = {}): EditLine {
  return {
    account_id: 'acct-1',
    account_name: 'Cash',
    account_code: null,
    description: null,
    encrypted_debit: 'C_D',
    encrypted_credit: 'C_C',
    encrypted_book_value: null,
    key_version: 2,
    encrypted_amount_native: 'C_N',
    encrypted_amount_primary: 'C_P',
    encrypted_posted_rate: 'C_R',
    encrypted_wallet_currency: 'C_W',
    encrypted_primary_currency_at_posting: 'C_PC',
    encrypted_manual_rate_reason: null,
    encrypted_manual_rate_source: null,
    rate_pending: false,
    rate_asof: null,
    pinned_rate_id: null,
    dual_amounts_backfilled: true,
    ...over,
  } as EditLine;
}

function input(over: Partial<EditPostedEntryInput> = {}): EditPostedEntryInput {
  return {
    entryId: 'je-1',
    entryKeyVersion: 2,
    date: '2026-10-15',
    header: { encrypted_memo: 'C_MEMO', encrypted_currency: 'C_USD' },
    lines: [line(), line({ account_id: 'acct-2' })],
    amounts: [
      { debit: 100, credit: 0 },
      { debit: 0, credit: 100 },
    ],
    encryptedReason: 'C_REASON',
    reasonText: 'Wrong amount',
    ...over,
  };
}

/** The line keys the SQL function inserts, read from the latest migration that defines it. */
function sqlLineKeys(): string[] {
  const sql = readFileSync(
    join(
      __dirname,
      '../../../supabase/migrations/20261105210000_owb_edit_posted_entry_expected_version.sql',
    ),
    'utf8',
  );
  return [...new Set([...sql.matchAll(/v_line->>?'([a-z_]+)'/g)].map((m) => m[1]))].sort();
}

describe('buildEditPostedEntryArgs', () => {
  it('sends the entry, date, header, lines, reason and key version', () => {
    const a = buildEditPostedEntryArgs(input());
    expect(a.p_je_id).toBe('je-1');
    expect(a.p_date).toBe('2026-10-15');
    expect(a.p_header).toEqual({ encrypted_memo: 'C_MEMO', encrypted_currency: 'C_USD' });
    expect(a.p_txs).toEqual([]);
    expect(a.p_encrypted_reason).toBe('C_REASON');
    expect(a.p_key_version).toBe(2);
    expect(a.p_lines.map((l) => l.account_id)).toEqual(['acct-1', 'acct-2']);
    expect(a.p_expected_updated_at).toBeNull();
  });

  it('sends the updated_at the caller read, so a newer edit is never overwritten', () => {
    const a = buildEditPostedEntryArgs(
      input({ expectedUpdatedAt: '2026-11-05T21:00:00.123456+00:00' }),
    );
    expect(a.p_expected_updated_at).toBe('2026-11-05T21:00:00.123456+00:00');
  });

  it('the latest migration refuses an edit when updated_at moved, under the row lock', () => {
    const sql = readFileSync(
      join(
        __dirname,
        '../../../supabase/migrations/20261105210000_owb_edit_posted_entry_expected_version.sql',
      ),
      'utf8',
    );
    const lock = sql.indexOf('FOR UPDATE;');
    const check = sql.indexOf('v_je.updated_at IS DISTINCT FROM p_expected_updated_at');
    expect(lock).toBeGreaterThan(0);
    expect(check).toBeGreaterThan(lock);
  });

  it('sends every stored column of each line unchanged', () => {
    const a = buildEditPostedEntryArgs(input());
    const expected = Object.fromEntries(
      EDIT_LINE_KEYS.filter((k) => k in line()).map((k) => [
        k,
        (line() as unknown as Record<string, unknown>)[k],
      ]),
    );
    expect(a.p_lines[0]).toEqual(expected);
    expect(a.p_lines[0].encrypted_amount_primary).toBe('C_P');
  });

  it('sends only the line columns the function reads', () => {
    const a = buildEditPostedEntryArgs(input());
    for (const l of a.p_lines) {
      expect(Object.keys(l).every((k) => (EDIT_LINE_KEYS as readonly string[]).includes(k))).toBe(
        true,
      );
      expect(l).not.toHaveProperty('key_version');
      expect(l).not.toHaveProperty('dual_amounts_backfilled');
    }
  });

  it('the allowed line columns match the ones the SQL function reads', () => {
    expect([...EDIT_LINE_KEYS].sort()).toEqual(sqlLineKeys());
  });

  it('refuses an unbalanced entry', () => {
    expect(() =>
      buildEditPostedEntryArgs(
        input({
          amounts: [
            { debit: 100, credit: 0 },
            { debit: 0, credit: 90 },
          ],
        }),
      ),
    ).toThrow('Debits and credits must be equal');
  });

  it('refuses an entry of zeros', () => {
    expect(() =>
      buildEditPostedEntryArgs(
        input({
          amounts: [
            { debit: 0, credit: 0 },
            { debit: 0, credit: 0 },
          ],
        }),
      ),
    ).toThrow('Debits and credits must be equal');
  });

  it('refuses a blank reason', () => {
    expect(() => buildEditPostedEntryArgs(input({ reasonText: '   ' }))).toThrow('Say why');
  });

  it('refuses fewer than two lines', () => {
    expect(() =>
      buildEditPostedEntryArgs(input({ lines: [line()], amounts: [{ debit: 1, credit: 1 }] })),
    ).toThrow('at least two lines');
  });

  it('refuses lines encrypted under a different key version than the entry', () => {
    expect(() => buildEditPostedEntryArgs(input({ entryKeyVersion: 1 }))).toThrow(
      'older encryption key',
    );
  });

  it('refuses a line with no account', () => {
    expect(() =>
      buildEditPostedEntryArgs(input({ lines: [line(), line({ account_id: '' })] })),
    ).toThrow('Every line needs an account');
  });
});

describe('editPostedEntry', () => {
  function rpcClient(result: { data: unknown; error: { message: string } | null }) {
    const calls: Array<{ fn: string; args: unknown }> = [];
    const c = {
      rpc: async (fn: string, args: unknown) => {
        calls.push({ fn, args });
        return result;
      },
    } as unknown as SupabaseClient;
    return { c, calls };
  }

  it('calls owb_edit_posted_entry once and returns the version number', async () => {
    const { c, calls } = rpcClient({ data: 3, error: null });
    expect(await editPostedEntry(c, input())).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].fn).toBe('owb_edit_posted_entry');
    expect(calls[0].args).toEqual(buildEditPostedEntryArgs(input()));
  });

  it('surfaces the database refusal', async () => {
    const { c } = rpcClient({ data: null, error: { message: 'The month is closed.' } });
    await expect(editPostedEntry(c, input())).rejects.toThrow('The month is closed.');
  });

  it('sends nothing when the entry is unbalanced', async () => {
    const { c, calls } = rpcClient({ data: 1, error: null });
    await expect(
      editPostedEntry(
        c,
        input({
          amounts: [
            { debit: 5, credit: 0 },
            { debit: 0, credit: 4 },
          ],
        }),
      ),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});

describe('fetchEntryHistory', () => {
  const versions = [
    {
      id: 'v2',
      version_no: 2,
      edited_at: 't2',
      edited_by: 'u1',
      date: '2026-10-14',
      period_override: true,
      encrypted_reason: 'C_late rate',
      encrypted_memo: 'C_old memo',
      encrypted_currency: 'C_EUR',
      key_version: 2,
    },
    {
      id: 'v1',
      version_no: 1,
      edited_at: 't1',
      edited_by: 'u1',
      date: '2026-10-13',
      period_override: false,
      encrypted_reason: null,
      encrypted_memo: null,
      encrypted_currency: 'C_USD',
      key_version: 2,
    },
  ];
  const lineVersions = [
    {
      version_id: 'v1',
      account_name: 'C_Cash',
      encrypted_debit: 'C_40',
      encrypted_credit: 'C_0',
      key_version: 2,
    },
    {
      version_id: 'v2',
      account_name: 'C_Cash',
      encrypted_debit: 'C_50',
      encrypted_credit: 'C_0',
      key_version: 2,
    },
    {
      version_id: 'v2',
      account_name: 'C_Sales',
      encrypted_debit: 'C_0',
      encrypted_credit: 'C_50',
      key_version: 2,
    },
  ];

  function historyClient() {
    const seen: Array<Record<string, unknown>> = [];
    const c = {
      from: (table: string) => {
        const call: Record<string, unknown> = { table };
        seen.push(call);
        const q = {
          select: () => q,
          eq: (col: string, v: unknown) => ((call.eq = [col, v]), q),
          order: async (col: string, o: { ascending: boolean }) => {
            call.order = [col, o.ascending];
            return {
              data: table === 'journal_entry_versions' ? versions : lineVersions,
              error: null,
            };
          },
        };
        return q;
      },
    } as unknown as SupabaseClient;
    return { c, seen };
  }

  it('reads one entry, newest first, with the old memo, old lines and reason', async () => {
    const { c, seen } = historyClient();
    const h = await fetchEntryHistory(c, 'je-1', async (s) => s.replace(/^C_/, ''));
    expect(seen.map((s) => [s.table, s.eq])).toEqual([
      ['journal_entry_versions', ['journal_entry_id', 'je-1']],
      ['journal_entry_line_versions', ['journal_entry_id', 'je-1']],
    ]);
    expect(seen[0].order).toEqual(['version_no', false]);
    expect(h.map((v) => [v.versionNo, v.reason, v.periodOverride, v.date, v.memo])).toEqual([
      [2, 'late rate', true, '2026-10-14', 'old memo'],
      [1, null, false, '2026-10-13', null],
    ]);
    expect(h.map((v) => v.currency)).toEqual(['EUR', 'USD']);
    expect(h[0].lines).toEqual([
      { accountName: 'Cash', debit: 50, credit: 0, description: null },
      { accountName: 'Sales', debit: 0, credit: 50, description: null },
    ]);
    expect(h[1].lines.map((l) => l.debit)).toEqual([40]);
  });
});

describe('planPostedEditLines', () => {
  function stored(id: string, over: Partial<StoredEditLine> = {}): StoredEditLine {
    return {
      row: line({ account_id: `acct-${id}`, encrypted_amount_primary: `C_P_${id}` }),
      accountId: `acct-${id}`,
      accountName: `Account ${id}`,
      accountCode: null,
      description: null,
      debit: id === 'a' ? 100 : 0,
      credit: id === 'a' ? 0 : 100,
      walletCurrency: 'MXN',
      primaryAtPosting: 'BTC',
      bookValue: 7,
      ratePending: false,
      ...over,
    };
  }
  const edited = (s: StoredEditLine) => ({
    accountId: s.accountId,
    accountName: s.accountName,
    accountCode: s.accountCode,
    description: s.description,
    debit: s.debit,
    credit: s.credit,
  });

  function builder(pending = false) {
    const seen: BuildLineParams[] = [];
    const build = async (p: BuildLineParams) => {
      seen.push(p);
      return {
        insert: line({ account_id: p.account_id, encrypted_amount_primary: 'C_NEW' }),
        pending,
      };
    };
    return { build, seen };
  }

  const base = (over: Record<string, unknown> = {}) => {
    const s = [stored('a'), stored('b')];
    return {
      stored: s,
      edited: s.map(edited),
      storedDate: '2026-10-15',
      storedCurrency: 'MXN',
      date: '2026-10-15',
      currency: 'MXN',
      primaryCurrency: 'USD',
      encrypt: async (t: string) => `C_${t}`,
      ...over,
    };
  };

  it('sends unchanged lines back exactly as stored and rebuilds nothing', async () => {
    const { build, seen } = builder(true);
    const b = base();
    const out = await planPostedEditLines({ ...b, build });
    expect(seen).toHaveLength(0);
    expect(out).toEqual([b.stored[0].row, b.stored[1].row]);
  });

  it('keeps unchanged lines when the user reorders them', async () => {
    const { build, seen } = builder();
    const b = base();
    const out = await planPostedEditLines({ ...b, edited: [...b.edited].reverse(), build });
    expect(seen).toHaveLength(0);
    expect(out).toEqual([b.stored[1].row, b.stored[0].row]);
  });

  it('replaces only the text when only a description changes, keeping the values', async () => {
    const { build, seen } = builder();
    const b = base();
    b.edited[1] = { ...b.edited[1], description: 'fixed text' };
    const out = await planPostedEditLines({ ...b, build });
    expect(seen).toHaveLength(0);
    expect(out[0]).toBe(b.stored[0].row);
    expect(out[1]).toEqual({
      ...b.stored[1].row,
      account_name: 'C_Account b',
      description: 'C_fixed text',
    });
    expect(out[1].encrypted_amount_primary).toBe('C_P_b');
  });

  it('keeps an older line that stores no currency of its own when the entry currency is unchanged', async () => {
    const { build, seen } = builder();
    const b = base();
    b.stored[0].walletCurrency = null;
    const out = await planPostedEditLines({ ...b, build });
    expect(seen).toHaveLength(0);
    expect(out[0]).toBe(b.stored[0].row);
  });

  it('rebuilds a line whose amount changed, under the currency the entry was posted in', async () => {
    const { build, seen } = builder();
    const b = base();
    b.edited[0] = { ...b.edited[0], debit: 90 };
    b.edited[1] = { ...b.edited[1], credit: 90 };
    const out = await planPostedEditLines({ ...b, build });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ primary_currency: 'BTC', account_id: 'acct-a', debit: 90 });
    expect(out.map((l) => l.encrypted_amount_primary)).toEqual(['C_NEW', 'C_NEW']);
  });

  it('rebuilds every line when the date or currency changes', async () => {
    for (const over of [{ date: '2026-10-16' }, { currency: 'USD' }]) {
      const { build, seen } = builder();
      await planPostedEditLines({ ...base(over), build });
      expect(seen).toHaveLength(2);
      expect(seen.every((p) => p.book_value === null)).toBe(true);
    }
  });

  it('refuses a change that would replace a stored value with a missing rate', async () => {
    const { build } = builder(true);
    const b = base();
    b.edited[0] = { ...b.edited[0], debit: 90 };
    b.edited[1] = { ...b.edited[1], credit: 90 };
    await expect(planPostedEditLines({ ...b, build })).rejects.toThrow('Nothing was saved');
  });

  it('allows a still-missing rate on a line that had none before', async () => {
    const { build } = builder(true);
    const s = [stored('a', { ratePending: true }), stored('b', { ratePending: true })];
    const e = s.map(edited);
    e[0] = { ...e[0], debit: 90 };
    e[1] = { ...e[1], credit: 90 };
    const out = await planPostedEditLines({ ...base(), stored: s, edited: e, build });
    expect(out).toHaveLength(2);
  });
});

describe('Journal page posted edit', () => {
  it('reads the stored date as a calendar date, not as UTC midnight', () => {
    const src = readFileSync(join(__dirname, '../../pages/JournalEntries.tsx'), 'utf8');
    const open = src.slice(src.search(/const openEdit = (async )?\(/));
    const body = open.slice(0, open.indexOf('setModalOpen(true)'));
    expect(body).toContain('setFDate(parseISO(entry.date))');
    expect(body).not.toContain('new Date(entry.date)');
  });

  it('sends the updated_at of the entry being edited', () => {
    const src = readFileSync(join(__dirname, '../../pages/JournalEntries.tsx'), 'utf8');
    const call = src.slice(src.indexOf('await editPostedEntry(supabase, {'));
    expect(call.slice(0, call.indexOf('});'))).toContain(
      'expectedUpdatedAt: editingEntry.updated_at ?? null',
    );
  });
});
