import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { deleteTxWithDraftEntry } from '../delete-tx-entry';

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
