/**
 * Fill late exchange rates on journal entry lines (OWB-T0237, OWB-T0238).
 *
 * A line saved while its rate was not yet known has rate_pending set, or (on
 * older lines) dual_amounts_backfilled = false, and no amount in the primary
 * currency. The lines of a posted entry
 * cannot be updated directly, so each posted entry is filled through
 * owb_edit_posted_entry (fillPendingRatesOnPostedEntry). That keeps the
 * entry's id and number and saves the earlier version in its history.
 *
 * Counts are per line and always cover the whole entry, even when its lines
 * span two pages of the search.
 *
 * Lines on a draft are left for later: they are not in any report, and they
 * are filled by a run after the entry is posted. Voided entries are left as
 * they are. An entry the database refuses (for example a closed month) is
 * counted as failed and left unchanged.
 *
 * ZKA note: encryption/decryption happen entirely in the browser. The
 * server only ever sees ciphertext. Rate fetching sends {pair, date}
 * metadata, the same baseline as the stored dates.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { fillPendingRatesOnPostedEntry } from './fill-posted-pending-rates';

type EncryptFn = (plaintext: string) => Promise<string>;
type DecryptFn = (ciphertext: string) => Promise<string>;

const PAGE_SIZE = 500;
const WAITING = 'rate_pending.eq.true,dual_amounts_backfilled.eq.false';
const STORAGE_KEY = 'owb_backfill_progress';

export interface BackfillProgress {
  processed: number;
  resolved: number;
  pending: number;
  failed: number;
  lastCursor: string | null; // last processed journal entry id, for resuming
}

const empty = (): BackfillProgress => ({
  processed: 0,
  resolved: 0,
  pending: 0,
  failed: 0,
  lastCursor: null,
});

// Progress is kept per organization, so a run in one set of books never
// resumes from another's place.
const storageKey = (orgId: string | null) => `${STORAGE_KEY}:${orgId ?? ''}`;

export function loadBackfillProgress(orgId: string | null): BackfillProgress {
  try {
    const stored = localStorage.getItem(storageKey(orgId));
    if (stored) return JSON.parse(stored);
  } catch {
    /* ignore */
  }
  return empty();
}

function saveBackfillProgress(orgId: string, p: BackfillProgress): void {
  try {
    localStorage.setItem(storageKey(orgId), JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export function clearBackfillProgress(orgId: string | null): void {
  try {
    localStorage.removeItem(storageKey(orgId));
  } catch {
    /* ignore */
  }
}

export interface BackfillCallbacks {
  onProgress: (p: BackfillProgress) => void;
  /** Called only when the run reached the end, never after Stop. */
  onDone: (p: BackfillProgress) => void;
  signal?: AbortSignal;
}

export interface BackfillDeps {
  client?: SupabaseClient;
  fillPosted?: typeof fillPendingRatesOnPostedEntry;
}

/**
 * Run one backfill pass for an org. Returns the progress; after Stop the
 * progress is saved so the next run resumes where this one stopped.
 */
export async function backfillDualAmounts(
  orgId: string,
  encrypt: EncryptFn,
  decrypt: DecryptFn,
  callbacks: BackfillCallbacks,
  deps: BackfillDeps = {},
): Promise<BackfillProgress> {
  const client = deps.client ?? (supabase as unknown as SupabaseClient);
  const fillPosted = deps.fillPosted ?? fillPendingRatesOnPostedEntry;
  const progress = loadBackfillProgress(orgId);
  let cursor = progress.lastCursor;

  while (!callbacks.signal?.aborted) {
    let query = client
      .from('journal_entry_lines')
      .select('journal_entry_id, journal_entries!inner(status, org_id)')
      .or(WAITING)
      .eq('journal_entries.org_id', orgId)
      .order('journal_entry_id', { ascending: true })
      .limit(PAGE_SIZE);
    if (cursor) query = query.gt('journal_entry_id', cursor);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    type Parent = { status: string } | null;
    const rows = (data ?? []) as unknown as Array<{
      journal_entry_id: string;
      journal_entries: Parent | Parent[];
    }>;
    if (rows.length === 0) break;

    // Entries with waiting lines, in id order. The page may hold only some of
    // an entry's lines, so the counts below come from the whole entry.
    const entries = new Map<string, string>();
    for (const r of rows) {
      const je = r.journal_entries;
      const parent: Parent = Array.isArray(je) ? (je[0] ?? null) : je;
      if (!entries.has(r.journal_entry_id)) entries.set(r.journal_entry_id, parent?.status ?? '');
    }

    for (const [entryId, status] of entries) {
      if (callbacks.signal?.aborted) break;
      const lines = await countWaiting(client, entryId);
      if (status === 'POSTED') {
        try {
          const r = await fillPosted(client, entryId, { encrypt, decrypt });
          progress.resolved += r.filled;
          progress.pending += r.stillPending;
          // A waiting line that is neither filled nor pending has no rate to
          // fill and no amounts: it needs a person to look at it.
          progress.failed += Math.max(0, r.waiting - r.filled - r.stillPending);
        } catch {
          progress.failed += lines;
        }
      } else {
        progress.pending += lines;
      }
      progress.processed += lines;
      cursor = entryId;
      progress.lastCursor = cursor;
    }

    saveBackfillProgress(orgId, progress);
    callbacks.onProgress({ ...progress });
    if (rows.length < PAGE_SIZE) break;
  }

  if (callbacks.signal?.aborted) {
    saveBackfillProgress(orgId, progress);
    return progress;
  }
  clearBackfillProgress(orgId);
  callbacks.onDone({ ...progress });
  return progress;
}

async function countWaiting(client: SupabaseClient, entryId: string): Promise<number> {
  const { count, error } = await client
    .from('journal_entry_lines')
    .select('id', { count: 'exact', head: true })
    .eq('journal_entry_id', entryId)
    .or(WAITING);
  if (error) throw new Error(error.message);
  return count ?? 0;
}
