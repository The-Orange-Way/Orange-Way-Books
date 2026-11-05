/**
 * Load every journal_entry_lines row of an org, with its entry's date.
 *
 * The API returns at most a fixed number of rows per request (1000 on the
 * default settings) and says nothing when it stops there. A single request
 * therefore gives reports, the dashboard, cash flow and FX exposure only the
 * first 1000 lines of a larger ledger, and every total built on them is wrong
 * without any warning. This reads page after page until a page comes back
 * empty, so it does not depend on knowing the server's limit, and it returns
 * the error instead of a partial ledger if any page fails.
 *
 * Only lines whose entry is in the books are returned (see entriesInBooks): drafts are left out.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { linesInBooks, type LineWithEntry } from './ledger/entries-in-books';

export const ORG_LINES_PAGE = 1000;

export const LINES_LOAD_ERROR =
  'Could not load all journal lines, so totals cannot be shown. Refresh the page and try again.';

export async function fetchOrgJournalLines<T = Record<string, unknown>>(
  client: SupabaseClient,
  orgId: string,
  pageSize: number = ORG_LINES_PAGE,
): Promise<{ data: T[] | null; error: { message: string } | null }> {
  const rows: T[] = [];
  for (;;) {
    const { data, error } = await client
      .from('journal_entry_lines')
      .select(
        '*, journal_entries!inner(date, org_id, reversal_of_id, encrypted_currency, key_version, status, source_type)',
      )
      .eq('journal_entries.org_id', orgId)
      .order('id', { ascending: true })
      .range(rows.length, rows.length + pageSize - 1);
    if (error) return { data: null, error };
    const page = (data ?? []) as T[];
    if (page.length === 0) {
      // Filtered after loading, because whether a draft reversal counts depends on its original.
      return {
        data: linesInBooks(rows as unknown as LineWithEntry[]) as unknown as T[],
        error: null,
      };
    }
    rows.push(...page);
  }
}
