import type { ExcludedEntry, LineExclusionReason } from '@/lib/ledger-engine';

const REASON_TEXT: Record<LineExclusionReason, [string, string]> = {
  'awaiting-rate': ['waiting for an exchange rate', 'waiting for an exchange rate'],
  'other-primary': [
    'posted under an earlier primary currency',
    'posted under an earlier primary currency',
  ],
  'unknown-currency': ['has no readable currency', 'have no readable currency'],
};
const ORDER: LineExclusionReason[] = ['awaiting-rate', 'other-primary', 'unknown-currency'];

/**
 * The note a report shows when entries are left out of its totals, saying why for each reason.
 * `prior` is null when no prior period is shown. Returns null when nothing is left out.
 */
export function excludedEntriesNote(
  now: ExcludedEntry[],
  prior: ExcludedEntry[] | null,
  reportCurrency: string,
): string | null {
  const priorCount = prior?.length ?? 0;
  if (now.length + priorCount === 0) return null;
  const counts = new Map<LineExclusionReason, number>();
  for (const e of [...now, ...(prior ?? [])]) counts.set(e.reason, (counts.get(e.reason) ?? 0) + 1);
  const why = ORDER.filter((r) => counts.get(r))
    .map((r) => {
      const n = counts.get(r)!;
      return `${n} ${REASON_TEXT[r][n === 1 ? 0 : 1]}`;
    })
    .join(', ');
  return (
    `${now.length} ${now.length === 1 ? 'entry is' : 'entries are'} not in these ${reportCurrency} totals` +
    (prior ? ` (${priorCount} in the prior period)` : '') +
    `: ${why}.`
  );
}
