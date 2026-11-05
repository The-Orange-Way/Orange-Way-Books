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
  type EditLine,
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
      '../../../supabase/migrations/20261105190000_owb_edit_posted_entry_keep_signature.sql',
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
      encrypted_currency: 'C_USD',
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
    expect(h[0].lines).toEqual([
      { accountName: 'Cash', debit: 50, credit: 0, description: null },
      { accountName: 'Sales', debit: 0, credit: 50, description: null },
    ]);
    expect(h[1].lines.map((l) => l.debit)).toEqual([40]);
  });
});
