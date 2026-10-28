/**
 * Load the journal_entry_lines of many entries.
 *
 * An `.in('journal_entry_id', ids)` filter puts every id in the request
 * URL. With a few hundred entries the URL passes the gateway's limit and the
 * request is refused with 400, so a single request silently returns nothing
 * for an org with a real ledger. This splits the ids into batches and fails
 * loudly if any batch fails: a page must never show entries as empty when
 * their lines simply did not load.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/** 100 uuids keep the request URL near 4 KB. */
export const LINES_FETCH_BATCH = 100;

export async function fetchJournalEntryLines<T = Record<string, unknown>>(
  client: SupabaseClient,
  entryIds: string[],
  batchSize: number = LINES_FETCH_BATCH,
): Promise<T[]> {
  const ids = [...new Set(entryIds)];
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) batches.push(ids.slice(i, i + batchSize));
  const results = await Promise.all(
    batches.map(async (batch) => {
      const { data, error } = await client
        .from('journal_entry_lines')
        .select('*')
        .in('journal_entry_id', batch);
      if (error) throw error;
      return (data ?? []) as T[];
    }),
  );
  return results.flat();
}
