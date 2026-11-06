import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { saveTxEntryHeader } from '../tx-entry-header';

const encrypt = async (s: string) => `C_${s}`;

function fakeClient() {
  const calls: Array<{ op: string; table: string; row?: Record<string, unknown>; id?: string }> =
    [];
  const client = {
    from: (table: string) => ({
      insert: (row: Record<string, unknown>) => {
        calls.push({ op: 'insert', table, row });
        return {
          select: () => ({ single: async () => ({ data: { id: 'je-new' }, error: null }) }),
        };
      },
      update: (row: Record<string, unknown>) => ({
        eq: async (_col: string, id: string) => {
          calls.push({ op: 'update', table, row, id });
          return { error: null };
        },
      }),
    }),
  } as unknown as SupabaseClient;
  return { client, calls };
}

const fields = {
  memo: 'rent',
  currency: 'USD',
  exchange_rate: null,
  status: 'DRAFT',
  source_type: 'TRANSACTION_SPLIT',
  period_locked: false,
};

describe('saveTxEntryHeader', () => {
  it('gives a new entry the next Ref #', async () => {
    const { client, calls } = fakeClient();
    const years: number[] = [];
    const id = await saveTxEntryHeader(client, {
      orgId: 'org-1',
      date: '2026-11-06',
      existingId: null,
      fields,
      encrypt,
      mintRef: async (y) => {
        years.push(y);
        return 'JE-2026-0007';
      },
    });
    expect(id).toBe('je-new');
    expect(years).toEqual([new Date().getUTCFullYear()]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: 'insert', table: 'journal_entries' });
    expect(calls[0].row).toMatchObject({
      org_id: 'org-1',
      date: '2026-11-06',
      encrypted_ref_number: 'C_JE-2026-0007',
      encrypted_memo: 'C_rent',
      source_type: 'TRANSACTION_SPLIT',
    });
  });

  it('keeps the Ref # of an existing entry: no new number, and the column is not written', async () => {
    const { client, calls } = fakeClient();
    let minted = 0;
    const id = await saveTxEntryHeader(client, {
      orgId: 'org-1',
      date: '2026-11-06',
      existingId: 'je-1',
      fields,
      encrypt,
      mintRef: async () => {
        minted++;
        return 'JE-2026-0008';
      },
    });
    expect(id).toBe('je-1');
    expect(minted).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ op: 'update', id: 'je-1' });
    expect(calls[0].row).not.toHaveProperty('encrypted_ref_number');
    expect(calls[0].row).toMatchObject({ encrypted_memo: 'C_rent' });
  });

  it('writes nothing when no Ref # can be minted', async () => {
    const { client, calls } = fakeClient();
    await expect(
      saveTxEntryHeader(client, {
        orgId: 'org-1',
        date: '2026-11-06',
        existingId: null,
        fields,
        encrypt,
        mintRef: async () => {
          throw new Error('next_je_ref_number RPC failed: down');
        },
      }),
    ).rejects.toThrow('next_je_ref_number');
    expect(calls).toHaveLength(0);
  });
});

describe('transaction screen, Ref # on splits and transfers', () => {
  const src = readFileSync(
    join(__dirname, '..', '..', '..', 'components', 'transactions', 'transaction-modal.tsx'),
    'utf8',
  );
  const handler = (name: string) => {
    const start = src.indexOf(`async function ${name}(`);
    const end = src.indexOf('\n  async function ', start + 1);
    return start < 0 ? '' : src.slice(start, end < 0 ? undefined : end);
  };

  it.each(['handleSaveSplit', 'handleSaveTransfer'])(
    '%s writes its entry header through saveTxEntryHeader only',
    (name) => {
      const body = handler(name);
      expect(body).toContain('saveTxEntryHeader(supabase, {');
      expect(body).not.toContain("from('journal_entries')");
      expect(body).not.toContain('ref_number: null');
    },
  );
});
