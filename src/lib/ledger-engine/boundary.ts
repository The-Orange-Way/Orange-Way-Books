/**
 * Primary-currency boundary detection.
 *
 * When a report date range spans a primary-currency change (e.g. USD→BTC mid-year),
 * figures from before and after the boundary are in different units. The UI needs
 * to detect this case so it can show the boundary banner and offer split / translated views.
 */

export interface PrimaryCurrencyEra {
  currency: string;
  from: string | null; // ISO date (inclusive), null = from the beginning of time
  to: string | null;   // ISO date (inclusive), null = still current
}

export interface PrimaryCurrencyBoundaryResult {
  hasBoundary: boolean;
  eras: PrimaryCurrencyEra[];
  /** Boundaries that fall within the query date range (ISO date strings). */
  boundariesInRange: string[];
}

/**
 * Detect whether the given date range crosses a primary-currency change.
 *
 * @param history - rows from org_primary_currency_history, ordered by effective_from ASC.
 *   Each row has: { primary_currency: string; effective_from: string; effective_to: string | null }
 * @param rangeStart - ISO date string for the start of the report period (inclusive)
 * @param rangeEnd   - ISO date string for the end   of the report period (inclusive)
 */
export function computePrimaryCurrencyBoundaries(
  history: Array<{ primary_currency: string; effective_from: string | null; effective_to: string | null }>,
  rangeStart: string,
  rangeEnd: string,
): PrimaryCurrencyBoundaryResult {
  if (!history || history.length === 0) {
    return { hasBoundary: false, eras: [], boundariesInRange: [] };
  }

  const eras: PrimaryCurrencyEra[] = history.map(row => ({
    currency: row.primary_currency,
    from: row.effective_from,
    to: row.effective_to,
  }));

  // Find boundaries (effective_from dates) that fall strictly within the range.
  // effective_from is the first day the new currency is active; the boundary sits
  // between the day before and effective_from.
  const boundariesInRange: string[] = [];
  for (const era of eras) {
    if (!era.from) continue; // first era has no start boundary
    if (era.from > rangeStart && era.from <= rangeEnd) {
      boundariesInRange.push(era.from);
    }
  }

  return {
    hasBoundary: boundariesInRange.length > 0,
    eras,
    boundariesInRange,
  };
}

/**
 * Split a list of journal lines into groups by the primary currency that was
 * active when each line was posted.
 */
export function splitLinesByEra<T extends { date: string; primaryCurrencyAtPosting?: string | null }>(
  lines: T[],
  eras: PrimaryCurrencyEra[],
): Map<string, T[]> {
  const result = new Map<string, T[]>();

  for (const line of lines) {
    // Prefer the pinned primary currency; fall back to era lookup by date.
    const currency = line.primaryCurrencyAtPosting ?? eraForDate(line.date, eras);
    const bucket = currency ?? 'unknown';
    if (!result.has(bucket)) result.set(bucket, []);
    result.get(bucket)!.push(line);
  }

  return result;
}

function eraForDate(date: string, eras: PrimaryCurrencyEra[]): string | null {
  // eras are ordered oldest-first; walk backwards to find the active era
  for (let i = eras.length - 1; i >= 0; i--) {
    const era = eras[i];
    const afterStart = !era.from | date >= era.from;
    const beforeEnd = !era.to | date <= era.to;
    if (afterStart && beforeEnd) return era.currency;
  }
  return null;
}
