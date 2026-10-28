// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { fetchJournalEntryLines, LINES_FETCH_BATCH } from '../journal-entry-lines-fetch';

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;

/** Fake client: one line per entry id; fails any batch containing `failOn`. */
function client(failOn?: string) {
  const batches: string[][] = [];
  const from = vi.fn(() => ({
    select: () => ({
      in: async (_col: string, ids: string[]) => {
        batches.push(ids);
        if (failOn && ids.includes(failOn))
          return { data: null, error: { message: 'Bad Request' } };
        return { data: ids.map((j) => ({ journal_entry_id: j })), error: null };
      },
    }),
  }));
  return { c: { from } as unknown as SupabaseClient, batches };
}

describe('fetchJournalEntryLines', () => {
  it('loads every line of a ledger larger than one request can carry', async () => {
    const ids = Array.from({ length: 650 }, (_, i) => id(i));
    const { c, batches } = client();
    const rows = await fetchJournalEntryLines<{ journal_entry_id: string }>(c, ids);
    expect(rows).toHaveLength(650);
    expect(new Set(rows.map((r) => r.journal_entry_id))).toEqual(new Set(ids));
    expect(batches).toHaveLength(Math.ceil(650 / LINES_FETCH_BATCH));
    expect(batches.every((b) => b.length <= LINES_FETCH_BATCH)).toBe(true);
  });

  it('throws when any batch fails instead of returning a partial result', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => id(i));
    const { c } = client(id(180));
    await expect(fetchJournalEntryLines(c, ids)).rejects.toEqual({ message: 'Bad Request' });
  });

  it('makes no request for no entries and de-duplicates ids', async () => {
    const { c, batches } = client();
    expect(await fetchJournalEntryLines(c, [])).toEqual([]);
    expect(batches).toHaveLength(0);
    await fetchJournalEntryLines(c, [id(1), id(1), id(2)]);
    expect(batches).toEqual([[id(1), id(2)]]);
  });
});

describe('Journal Entries page', () => {
  const code = readFileSync(join(__dirname, '..', '..', 'pages', 'JournalEntries.tsx'), 'utf8');

  /** The body of `const openEdit = (` up to the next `const ` at the same indent. */
  function openEditBody(src: string): string {
    const start = src.indexOf('const openEdit = (');
    if (start === -1) throw new Error('openEdit not found');
    const end = src.indexOf('\n  const ', start + 1);
    return src.slice(start, end === -1 ? undefined : end);
  }
  const unbatched = (src: string) => /\.in\(\s*'journal_entry_id'/.test(src);
  const guardsEditor = (src: string) =>
    /if \(linesLoadFailed\)[\s\S]{0,200}return;/.test(openEditBody(src));

  it('loads lines in batches and will not open an entry whose lines did not load', () => {
    expect(unbatched(code)).toBe(false);
    expect(code).toContain('fetchJournalEntryLines');
    expect(guardsEditor(code)).toBe(true);
  });

  it('catches the old shape (negative controls)', () => {
    const old = `const { data: lineData } = await supabase.from('journal_entry_lines').select('*').in('journal_entry_id', ids);
  const openEdit = (entry) => {
    if (entry.status !== 'DRAFT') return;
    setModalOpen(true);
  };
  const next = 1;`;
    expect(unbatched(old)).toBe(true);
    expect(guardsEditor(old)).toBe(false);
  });
});
