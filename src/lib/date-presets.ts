/**
 * Date-range preset builder for OWB's filter UI.
 *
 * Two pieces:
 *   - `listDatePresets(year?)` returns the dropdown options the UI shows.
 *     The list grows over time — three calendar years rolling backward
 *     from `year` (today's year by default), plus four quarters of `year`,
 *     plus a fixed set of relative ranges, plus a Custom escape hatch.
 *   - `resolveDateRange(presetId)` turns a preset string into a concrete
 *     `{ startDate, endDate }` pair in YYYY-MM-DD form.
 *
 * Preset id grammar:
 *   - Relative tokens: `week`, `prevWeek`, `month`, `prevMonth`,
 *     `last30`, `last60`, `last90`, `custom`.
 *   - Calendar year: `yYYYY` (e.g. `y2026`).
 *   - Calendar quarter: `qN_YYYY` (N in 1..4, e.g. `q3_2026`).
 *
 * Unknown ids return an empty range. Custom returns an empty range too —
 * the UI fills it from the date pickers.
 *
 * Implemented in-house for OWB. No external port.
 */

// ── Public types ──────────────────────────────────────────────────────────

export type DateRangePreset = string;

export interface DatePresetOption {
  readonly value: DateRangePreset;
  readonly label: string;
}

export interface DateRange {
  readonly startDate: string;
  readonly endDate: string;
}

// ── Relative presets — fixed set, no year math needed ─────────────────────

const RELATIVE_OPTIONS: ReadonlyArray<DatePresetOption> = [
  { value: 'week', label: 'This week' },
  { value: 'prevWeek', label: 'Previous week' },
  { value: 'month', label: 'This month' },
  { value: 'prevMonth', label: 'Previous month' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'last60', label: 'Last 60 days' },
  { value: 'last90', label: 'Last 90 days' },
];

// ── Calendar quarters — one source of truth for both ends of the range ────

interface QuarterBounds {
  startMonth: number; // 1-12
  startDay: number;
  endMonth: number;
  endDay: number;
}

const QUARTER_TABLE: ReadonlyArray<QuarterBounds> = [
  { startMonth: 1, startDay: 1, endMonth: 3, endDay: 31 },
  { startMonth: 4, startDay: 1, endMonth: 6, endDay: 30 },
  { startMonth: 7, startDay: 1, endMonth: 9, endDay: 30 },
  { startMonth: 10, startDay: 1, endMonth: 12, endDay: 31 },
];

// ── Formatting ────────────────────────────────────────────────────────────

/** YYYY-MM-DD slice of a Date. Uses toISOString() so the behaviour is
 *  identical to the prior implementation; any timezone wobble that
 *  callers depended on is preserved. */
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// ── Range helpers — small, named, no side effects ────────────────────────

function weekRange(today: Date, offsetDays: number): DateRange {
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() + offsetDays);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return { startDate: isoDay(start), endDate: isoDay(end) };
}

function monthRange(today: Date, monthOffset: number): DateRange {
  const year = today.getFullYear();
  const month = today.getMonth() + monthOffset;
  const start = new Date(year, month, 1);
  const end = new Date(year, month + 1, 0); // day 0 of next month = last day of this month
  return { startDate: isoDay(start), endDate: isoDay(end) };
}

function trailingDaysRange(today: Date, days: number): DateRange {
  const start = new Date(today);
  start.setDate(today.getDate() - days);
  return { startDate: isoDay(start), endDate: isoDay(today) };
}

function calendarYearRange(year: number): DateRange {
  return { startDate: `${year}-01-01`, endDate: `${year}-12-31` };
}

function quarterRange(year: number, quarter1to4: number): DateRange {
  const bounds = QUARTER_TABLE[quarter1to4 - 1];
  if (!bounds) return EMPTY_RANGE;
  return {
    startDate: `${year}-${pad2(bounds.startMonth)}-${pad2(bounds.startDay)}`,
    endDate: `${year}-${pad2(bounds.endMonth)}-${pad2(bounds.endDay)}`,
  };
}

const EMPTY_RANGE: DateRange = { startDate: '', endDate: '' };

// ── Patterns for dynamic ids ──────────────────────────────────────────────

const YEAR_ID_PATTERN = /^y(\d{4})$/;
const QUARTER_ID_PATTERN = /^q([1-4])_(\d{4})$/;

// ── Public API ────────────────────────────────────────────────────────────

/** Build the list of options the date-range dropdown displays. */
export function generateDatePresets(currentYear?: number): DatePresetOption[] {
  const anchor = currentYear ?? new Date().getFullYear();

  const yearOptions: DatePresetOption[] = [];
  for (let offset = 0; offset <= 2; offset++) {
    const y = anchor - offset;
    yearOptions.push({ value: `y${y}`, label: String(y) });
  }

  const quarterOptions: DatePresetOption[] = QUARTER_TABLE.map((_, idx) => {
    const q = idx + 1;
    return { value: `q${q}_${anchor}`, label: `Q${q} ${anchor}` };
  });

  return [
    ...RELATIVE_OPTIONS,
    ...yearOptions,
    ...quarterOptions,
    { value: 'custom', label: 'Custom' },
  ];
}

/** Resolve a preset id to a `{ startDate, endDate }` pair. Unknown ids
 *  and `custom` both yield empty strings (the UI fills custom from
 *  pickers, and unknown ids are treated as "no filter"). */
export function computeDateRange(presetId: DateRangePreset): DateRange {
  const now = new Date();

  switch (presetId) {
    case 'week':
      return weekRange(now, 0);
    case 'prevWeek':
      return weekRange(now, -7);
    case 'month':
      return monthRange(now, 0);
    case 'prevMonth':
      return monthRange(now, -1);
    case 'last30':
      return trailingDaysRange(now, 30);
    case 'last60':
      return trailingDaysRange(now, 60);
    case 'last90':
      return trailingDaysRange(now, 90);
    case 'custom':
      return EMPTY_RANGE;
  }

  const yearMatch = YEAR_ID_PATTERN.exec(presetId);
  if (yearMatch) {
    return calendarYearRange(Number(yearMatch[1]));
  }

  const qMatch = QUARTER_ID_PATTERN.exec(presetId);
  if (qMatch) {
    return quarterRange(Number(qMatch[2]), Number(qMatch[1]));
  }

  return EMPTY_RANGE;
}

/** Convenience for the common "default to this calendar year" case. */
export function getCurrentYearPreset(): { datePreset: DateRangePreset } & DateRange {
  const year = new Date().getFullYear();
  return {
    datePreset: `y${year}`,
    ...calendarYearRange(year),
  };
}

// ── Status filter — orthogonal to date range, kept here historically ──────

export type StatusFilter =
  | 'all'
  | 'incomplete'
  | 'complete'
  | 'not-cleared'
  | 'cleared'
  | 'reconciled';

export const STATUS_OPTIONS: ReadonlyArray<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'All Statuses' },
  { value: 'incomplete', label: 'Incomplete' },
  { value: 'complete', label: 'Complete' },
  { value: 'not-cleared', label: 'Not Cleared' },
  { value: 'cleared', label: 'Cleared' },
  { value: 'reconciled', label: 'Reconciled' },
];
