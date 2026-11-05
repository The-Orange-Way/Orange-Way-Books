// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { fetchOrgJournalLines } from '../org-journal-lines-fetch';

/** Fake client over `total` lines that, like the API, returns at most `maxRows` per request. */
function client(total: number, maxRows: number, failAtOffset?: number) {
  const ranges: Array<[number, number]> = [];
  const query = {
    select: () => query,
    eq: () => query,
    neq: () => query,
    order: () => query,
    range: async (from: number, to: number) => {
      ranges.push([from, to]);
      if (failAtOffset !== undefined && from >= failAtOffset)
        return { data: null, error: { message: 'Bad Request' } };
      const end = Math.min(total, to + 1, from + maxRows);
      const data = [];
      for (let i = from; i < end; i++) data.push({ id: i });
      return { data, error: null };
    },
  };
  return { c: { from: () => query } as unknown as SupabaseClient, ranges };
}

describe('fetchOrgJournalLines', () => {
  it('loads every line of a ledger larger than one response', async () => {
    const { c } = client(2500, 1000);
    const { data, error } = await fetchOrgJournalLines<{ id: number }>(c, 'org');
    expect(error).toBeNull();
    expect(data).toHaveLength(2500);
    expect(new Set(data!.map((r) => r.id)).size).toBe(2500);
  });

  it('still loads everything when the server limit is below the page size', async () => {
    const { c } = client(2500, 300);
    const { data } = await fetchOrgJournalLines<{ id: number }>(c, 'org');
    expect(data).toHaveLength(2500);
  });

  it('returns the error and no rows when a later page fails', async () => {
    const { c } = client(2500, 1000, 1000);
    const { data, error } = await fetchOrgJournalLines(c, 'org');
    expect(data).toBeNull();
    expect(error).toEqual({ message: 'Bad Request' });
  });

  it('handles an empty ledger with one request', async () => {
    const { c, ranges } = client(0, 1000);
    expect((await fetchOrgJournalLines(c, 'org')).data).toEqual([]);
    expect(ranges).toHaveLength(1);
  });

  it('negative control: a single unpaged read of the same fake stops at the limit', async () => {
    const { c } = client(2500, 1000);
    const { data } = await (
      c.from('journal_entry_lines').select('*').eq('x', 1) as unknown as {
        range: (a: number, b: number) => Promise<{ data: unknown[] }>;
      }
    ).range(0, 1_000_000);
    expect(data).toHaveLength(1000);
  });
});

/** Fake that applies the filters it is given, over lines whose entries have the given statuses. */
function statusClient(statuses: string[]) {
  const rows = statuses.map((status, id) => ({ id, journal_entries: { status } }));
  const filters: Array<(r: (typeof rows)[number]) => boolean> = [];
  const field = (col: string) => (r: (typeof rows)[number]) =>
    col === 'journal_entries.status' ? r.journal_entries.status : undefined;
  const query = {
    select: () => query,
    eq: (col: string, v: unknown) => (
      col === 'journal_entries.status' && filters.push((r) => field(col)(r) === v),
      query
    ),
    neq: (col: string, v: unknown) => (filters.push((r) => field(col)(r) !== v), query),
    order: () => query,
    range: async (from: number, to: number) => ({
      data: rows.filter((r) => filters.every((f) => f(r))).slice(from, to + 1),
      error: null,
    }),
  };
  return { from: () => query } as unknown as SupabaseClient;
}

describe('fetchOrgJournalLines counts only entries that are in the books', () => {
  it('leaves out draft entries and keeps posted, voided and void reversals', async () => {
    const c = statusClient(['POSTED', 'DRAFT', 'VOID', 'VOID_REVERSAL', 'DRAFT']);
    const { data } = await fetchOrgJournalLines<{ id: number }>(c, 'org');
    expect(data!.map((r) => r.id)).toEqual([0, 2, 3]);
  });

  it('negative control: the same fake with no filter returns the drafts too', async () => {
    const c = statusClient(['POSTED', 'DRAFT']);
    const q = c.from('journal_entry_lines').select('*') as unknown as {
      range: (a: number, b: number) => Promise<{ data: unknown[] }>;
    };
    expect((await q.range(0, 10)).data).toHaveLength(2);
  });
});

describe('no page reads all of an org journal lines in one request', () => {
  const root = join(__dirname, '..', '..');
  const unpaged =
    /\.from\('journal_entry_lines'\)\s*\.select\('\*, journal_entries!inner\(date, org_id\)'\)\s*\.eq\('journal_entries\.org_id', orgId\)\s*[,;)]/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name !== '__tests__' && name !== 'node_modules') walk(p, out);
      } else if (/\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  it('finds no unpaged org-wide read in src', () => {
    const hits = walk(root).filter((f) => unpaged.test(readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('the four ledger pages use the paged loader and report a failure', () => {
    for (const f of [
      'pages/Reports.tsx',
      'pages/Dashboard.tsx',
      'pages/CashFlow.tsx',
      'components/fx-exposure/FxExposureDashboard.tsx',
    ]) {
      const src = readFileSync(join(root, f), 'utf8');
      expect(src, f).toContain('fetchOrgJournalLines(supabase, orgId)');
      expect(src, f).toContain('if (jeRes.error) toast.error(LINES_LOAD_ERROR)');
    }
  });

  it('negative control: the pattern catches the old shape', () => {
    const old = `supabase
          .from('journal_entry_lines')
          .select('*, journal_entries!inner(date, org_id)')
          .eq('journal_entries.org_id', orgId),`;
    expect(unpaged.test(old)).toBe(true);
    expect(unpaged.test('fetchOrgJournalLines(supabase, orgId),')).toBe(false);
  });
});
