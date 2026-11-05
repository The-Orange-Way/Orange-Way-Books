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
      for (let i = from; i < end; i++)
        data.push({ id: i, journal_entry_id: `je-${i}`, journal_entries: { status: 'POSTED' } });
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

/** Fake over lines, one per entry, where each entry is given as [status, source_type?, reversal_of?]. */
function ledgerClient(entries: Array<[string, string?, string?]>) {
  const rows = entries.map(([status, source_type, reversal_of_id], i) => ({
    id: i,
    journal_entry_id: `je-${i}`,
    journal_entries: {
      status,
      source_type: source_type ?? null,
      reversal_of_id: reversal_of_id ?? null,
    },
  }));
  const query = {
    select: () => query,
    eq: () => query,
    neq: () => query,
    order: () => query,
    range: async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }),
  };
  return { from: () => query } as unknown as SupabaseClient;
}

const ids = async (c: SupabaseClient) =>
  ((await fetchOrgJournalLines<{ id: number }>(c, 'org')).data ?? []).map((r) => r.id);

describe('fetchOrgJournalLines counts only entries that are in the books', () => {
  it('leaves out drafts and keeps posted, voided and void reversals', async () => {
    expect(
      await ids(ledgerClient([['POSTED'], ['DRAFT'], ['VOID'], ['VOID_REVERSAL'], ['DRAFT']])),
    ).toEqual([0, 2, 3]);
  });

  it('keeps a draft void reversal from an older void, so the void still cancels', async () => {
    // je-0 posted then voided the old way: reversal je-1 left as a draft.
    expect(await ids(ledgerClient([['POSTED'], ['DRAFT', 'void_reversal', 'je-0']]))).toEqual([
      0, 1,
    ]);
    // A void that stopped after marking the original void: still both.
    expect(await ids(ledgerClient([['VOID'], ['DRAFT', 'void_reversal', 'je-0']]))).toEqual([0, 1]);
  });

  it('leaves out a draft void reversal whose original is itself a draft', async () => {
    expect(await ids(ledgerClient([['DRAFT'], ['DRAFT', 'void_reversal', 'je-0']]))).toEqual([]);
  });

  it('negative control: an ordinary draft that only names an original is still left out', async () => {
    expect(await ids(ledgerClient([['POSTED'], ['DRAFT', 'manual', 'je-0']]))).toEqual([0]);
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

  it('the register and revaluation count lines by the same rule as the reports', () => {
    for (const [f, call] of [
      ['pages/AccountRegister.tsx', 'linesInBooks((jelRows ?? []) as any[])'],
      [
        'components/fx-revaluation/RevaluationWizard.tsx',
        'linesInBooks((jeRes.data as any[]) ?? [])',
      ],
    ]) {
      expect(readFileSync(join(root, f), 'utf8'), f).toContain(call);
    }
    // The register no longer drops voided entries on its own, which left their reversals unmatched.
    expect(readFileSync(join(root, 'pages/AccountRegister.tsx'), 'utf8')).not.toContain(
      "jeStatus === 'VOID') continue",
    );
  });

  it('posting one transaction posts its journal entry, like Bulk Post', () => {
    const src = readFileSync(join(root, 'pages/Transactions.tsx'), 'utf8');
    const toggle = src.slice(src.indexOf('const togglePosted'), src.indexOf('const cycleCleared'));
    expect(toggle).toContain('postJournalEntry(supabase, tx.journal_entry_id)');
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
