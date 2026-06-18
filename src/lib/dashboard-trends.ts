export type PeriodPreset = '7d' | '30d' | '90d' | 'ytd' | `year:${number}`;

export interface PeriodRange {
  readonly preset: PeriodPreset;
  readonly label: string;
  readonly comparisonLabel: string;
  readonly current: { from: Date; to: Date };
  readonly prior: { from: Date; to: Date };
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function daysAgo(n: number, ref = new Date()): Date {
  const x = startOfDay(ref);
  x.setDate(x.getDate() - n);
  return x;
}

export function resolvePeriod(preset: PeriodPreset, now: Date = new Date()): PeriodRange {
  const today = endOfDay(now);

  if (preset === '7d') {
    const from = daysAgo(6, now);
    const priorTo = endOfDay(daysAgo(7, now));
    const priorFrom = daysAgo(13, now);
    return {
      preset,
      label: 'Last 7 days',
      comparisonLabel: 'vs prior 7 days',
      current: { from, to: today },
      prior: { from: priorFrom, to: priorTo },
    };
  }
  if (preset === '30d') {
    const from = daysAgo(29, now);
    const priorTo = endOfDay(daysAgo(30, now));
    const priorFrom = daysAgo(59, now);
    return {
      preset,
      label: 'Last 30 days',
      comparisonLabel: 'vs prior 30 days',
      current: { from, to: today },
      prior: { from: priorFrom, to: priorTo },
    };
  }
  if (preset === '90d') {
    const from = daysAgo(89, now);
    const priorTo = endOfDay(daysAgo(90, now));
    const priorFrom = daysAgo(179, now);
    return {
      preset,
      label: 'Last 90 days',
      comparisonLabel: 'vs prior 90 days',
      current: { from, to: today },
      prior: { from: priorFrom, to: priorTo },
    };
  }
  if (preset === 'ytd') {
    const y = now.getFullYear();
    const from = startOfDay(new Date(y, 0, 1));
    const priorFrom = startOfDay(new Date(y - 1, 0, 1));
    const priorTo = endOfDay(new Date(y - 1, now.getMonth(), now.getDate()));
    return {
      preset,
      label: 'Year to date',
      comparisonLabel: `vs same period ${y - 1}`,
      current: { from, to: today },
      prior: { from: priorFrom, to: priorTo },
    };
  }
  // year:YYYY
  const y = Number(preset.slice(5));
  const from = startOfDay(new Date(y, 0, 1));
  const to = endOfDay(new Date(y, 11, 31));
  const priorFrom = startOfDay(new Date(y - 1, 0, 1));
  const priorTo = endOfDay(new Date(y - 1, 11, 31));
  return {
    preset,
    label: `${y}`,
    comparisonLabel: `vs ${y - 1}`,
    current: { from, to },
    prior: { from: priorFrom, to: priorTo },
  };
}

export type Sentiment = 'positive' | 'negative' | 'neutral';
export type Direction = 'up' | 'down' | 'flat';

export interface Trend {
  readonly pct: number | null;
  readonly direction: Direction;
  readonly sentiment: Sentiment;
  readonly delta: number;
  readonly priorValue: number;
}

/**
 * Compute trend vs prior period.
 * higherIsBetter = null → always neutral color (e.g. Receivables).
 */
export function computeTrend(
  current: number,
  prior: number,
  higherIsBetter: boolean | null,
): Trend {
  const delta = current - prior;
  const direction: Direction =
    Math.abs(delta) < 1e-9 ? 'flat' : delta > 0 ? 'up' : 'down';

  let pct: number | null = null;
  if (Math.abs(prior) > 1e-9) {
    pct = (delta / Math.abs(prior)) * 100;
  } else if (Math.abs(current) > 1e-9) {
    pct = null;
  }

  let sentiment: Sentiment = 'neutral';
  if (higherIsBetter === null | direction === 'flat') {
    sentiment = 'neutral';
  } else if (direction === 'up') {
    sentiment = higherIsBetter ? 'positive' : 'negative';
  } else {
    sentiment = higherIsBetter ? 'negative' : 'positive';
  }

  return { pct, direction, sentiment, delta, priorValue: prior };
}

export function availableYears(lines: ReadonlyArray<{ readonly date: string }>): number[] {
  const years = new Set<number>();
  for (const l of lines) {
    if (!l.date) continue;
    const y = Number(l.date.slice(0, 4));
    if (Number.isFinite(y) && y > 1900) years.add(y);
  }
  return [...years].sort((a, b) => b - a);
}
