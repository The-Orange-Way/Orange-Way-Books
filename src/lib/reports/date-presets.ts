import {
  endOfMonth,
  endOfYear,
  startOfMonth,
  startOfWeek,
  startOfYear,
  subMonths,
  subYears,
} from 'date-fns';

export type DatePreset =
  | 'today'
  | 'this_week'
  | 'this_month'
  | 'ytd'
  | 'this_year'
  | 'last_month'
  | 'last_year'
  | 'all_time'
  | 'custom';

/** Date range for a report preset. A closed period ends on its own last day, which the ledger treats as inclusive. */
export function getDateRange(preset: DatePreset): { from: Date | undefined; to: Date | undefined } {
  const now = new Date();
  switch (preset) {
    case 'today':
      return { from: now, to: now };
    case 'this_week':
      return { from: startOfWeek(now), to: now };
    case 'this_month':
      return { from: startOfMonth(now), to: now };
    case 'ytd':
      return { from: startOfYear(now), to: now };
    case 'this_year':
      return { from: startOfYear(now), to: now };
    case 'last_month':
      return { from: startOfMonth(subMonths(now, 1)), to: endOfMonth(subMonths(now, 1)) };
    case 'last_year':
      return { from: startOfYear(subYears(now, 1)), to: endOfYear(subYears(now, 1)) };
    case 'all_time':
      return { from: undefined, to: undefined };
    default:
      return { from: undefined, to: undefined };
  }
}
