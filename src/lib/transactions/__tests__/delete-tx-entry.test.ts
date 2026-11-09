import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { deleteBlocked, deleteTxWithDraftEntry } from '../delete-tx-entry';

type Call = { table: string; filters: Array<[string, string, unknown]> };

function fakeClient(fail: Record<string, string> = {}) {
  const calls: Call[] = [];
  const client = {
    from: (table: string) => ({
      delete: () => {
        const call: Call = { table, filters: [] };
        calls.push(call);
        const q = {
          eq: (col: string, v: unknown) => (call.filters.push(['eq', col, v]), q),
          in: (col: string, v: unknown) => (call.filters.push(['in', col, v]), q),
          then: (res: (r: { error: { message: string } | null }) => void) =>
            res({ error: fail[table] ? { message: fail[table] } : null }),
        };
        return q;
      },
    }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe('deleteTxWithDraftEntry', () => {
  it('deletes the transaction, then only its own draft entry', async () => {
    const { client, calls } = fakeClient();
    await deleteTxWithDraftEntry(client, { id: 'tx-1', journal_entry_id: 'je-1' });
    expect(calls.map((c) => c.table)).toEqual(['transactions', 'journal_entries']);
    expect(calls[0].filters).toEqual([['eq', 'id', 'tx-1']]);
    expect(calls[1].filters).toEqual([
      ['eq', 'id', 'je-1'],
      ['eq', 'status', 'DRAFT'],
      ['in', 'source_type', ['TRANSACTION_STANDARD', 'TRANSACTION_SPLIT']],
    ]);
  });

  it('touches no entry for a transaction without one', async () => {
    const { client, calls } = fakeClient();
    await deleteTxWithDraftEntry(client, { id: 'tx-1', journal_entry_id: null });
    expect(calls.map((c) => c.table)).toEqual(['transactions']);
  });

  it('leaves the entry when the transaction delete is refused', async () => {
    const { client, calls } = fakeClient({ transactions: 'denied' });
    await expect(
      deleteTxWithDraftEntry(client, { id: 'tx-1', journal_entry_id: 'je-1' }),
    ).rejects.toThrow('denied');
    expect(calls.map((c) => c.table)).toEqual(['transactions']);
  });
});

describe('deleteBlocked', () => {
  const rule = (fn: typeof deleteBlocked) =>
    fn({ status: 'POSTED' }) &&
    fn({ status: 'VOID' }) &&
    fn({ status: 'DRAFT', cleared_status: 'RECONCILED' }) &&
    !fn({ status: 'DRAFT' }) &&
    !fn(undefined);

  it('refuses posted, void and reconciled rows and allows a draft', () => {
    expect(rule(deleteBlocked)).toBe(true);
  });

  it('the check fails on a copy that only blocks reconciled rows', () => {
    const broken: typeof deleteBlocked = (tx) => tx?.cleared_status === 'RECONCILED';
    expect(rule(broken)).toBe(false);
  });

  const src = readFileSync(join(__dirname, '..', '..', '..', 'pages', 'Transactions.tsx'), 'utf8');
  const usesGuard = (text: string, from: string, to: string) => {
    const start = text.indexOf(from);
    return start >= 0 && text.slice(start, text.indexOf(to, start)).includes('deleteBlocked(tx)');
  };
  const singleOk = (t: string) =>
    usesGuard(t, 'const handleDelete = async', "if (!confirm('Delete this transaction?'))");
  const bulkOk = (t: string) =>
    usesGuard(t, 'const handleBulkDelete = async', 'if (!confirm(`Delete ${selected.size}');

  it('single and bulk delete both use it', () => {
    expect(singleOk(src)).toBe(true);
    expect(bulkOk(src)).toBe(true);
  });

  it('the checks fail on a copy where a handler does not use it', () => {
    const noSingle = src.replace(
      'if (deleteBlocked(tx)) {\n      toast.error',
      'if (false) {\n      toast.error',
    );
    expect(noSingle).not.toBe(src);
    expect(singleOk(noSingle)).toBe(false);
    const noBulk = src.replace(
      '.filter((tx): tx is TxRow => deleteBlocked(tx))',
      '.filter(() => false)',
    );
    expect(noBulk).not.toBe(src);
    expect(bulkOk(noBulk)).toBe(false);
  });
});
