/**
 * Which journal entries are in the books. Every page that adds up journal lines uses this, so
 * reports, the account register and revaluation agree.
 *
 * Posted entries count. A voided entry and its reversal both count, so they cancel. Drafts do
 * not count, with one exception: a void reversal saved as a draft (older voids did this, and a
 * void that stopped partway can leave one) counts while the entry it reverses counts, so a
 * voided transaction never comes back to life.
 */
export interface EntryStatus {
  id: string;
  status: string | null;
  source_type?: string | null;
  reversal_of_id?: string | null;
}

const IN_BOOKS = new Set(['POSTED', 'VOID', 'VOID_REVERSAL']);

export function entriesInBooks(entries: Iterable<EntryStatus>): Set<string> {
  const all = [...entries];
  const counted = new Set(all.filter((e) => IN_BOOKS.has(e.status ?? '')).map((e) => e.id));
  for (const e of all) {
    if (
      e.status === 'DRAFT' &&
      e.source_type === 'void_reversal' &&
      e.reversal_of_id &&
      counted.has(e.reversal_of_id)
    ) {
      counted.add(e.id);
    }
  }
  return counted;
}

/** Keeps the journal lines whose entry is in the books. Each line carries its entry as `journal_entries`. */
export function linesInBooks<
  T extends { journal_entry_id: string; journal_entries?: Omit<EntryStatus, 'id'> | null },
>(lines: T[]): T[] {
  const byId = new Map<string, EntryStatus>();
  for (const l of lines) {
    if (l.journal_entries)
      byId.set(l.journal_entry_id, { id: l.journal_entry_id, ...l.journal_entries });
  }
  const counted = entriesInBooks(byId.values());
  return lines.filter((l) => counted.has(l.journal_entry_id));
}
