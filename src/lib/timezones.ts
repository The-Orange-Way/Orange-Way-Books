// Single source of truth for the onboarding timezone list. The v1 reporting
// step (StepReporting) and the v2 organization setup surface (OrgSetupSurface)
// both read from here so the two lists cannot drift, which is the same reason
// months.ts exists: a drifted list silently stores a value the other surface
// cannot show back to the customer.

export interface TimezoneOption {
  value: string;
  label: string;
}

export const TIMEZONE_OPTIONS: readonly TimezoneOption[] = [
  { value: 'America/New_York', label: 'Eastern Time (US)' },
  { value: 'America/Chicago', label: 'Central Time (US)' },
  { value: 'America/Denver', label: 'Mountain Time (US)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time (US)' },
  { value: 'America/Anchorage', label: 'Alaska Time' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time' },
  { value: 'America/Toronto', label: 'Toronto (Eastern)' },
  { value: 'America/Vancouver', label: 'Vancouver (Pacific)' },
  { value: 'Europe/London', label: 'London (GMT)' },
  { value: 'Europe/Paris', label: 'Paris (CET)' },
  { value: 'Europe/Berlin', label: 'Berlin (CET)' },
  { value: 'Asia/Tokyo', label: 'Tokyo (JST)' },
  { value: 'Asia/Shanghai', label: 'Shanghai (CST)' },
  { value: 'Asia/Singapore', label: 'Singapore (SGT)' },
  { value: 'Australia/Sydney', label: 'Sydney (AEST)' },
  { value: 'Pacific/Auckland', label: 'Auckland (NZST)' },
] as const;

/**
 * The browser's own IANA zone, or an empty string when the environment does
 * not report one. Used to seed the picker, because the customer's own zone is
 * the best default available and a bookkeeping product uses it to decide which
 * day a transaction lands on.
 */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || '';
  } catch {
    return '';
  }
}

/**
 * The option list with `zone` guaranteed to be in it.
 *
 * The curated list above is a short one and a real customer's zone is very
 * often not on it. A picker whose value matches no option shows the customer
 * something other than what is stored: a native select displays its first
 * option while state still holds the other value, and a Radix listbox renders
 * an empty trigger, so the customer reads "no timezone" when one is set.
 * Returning a list that always contains the current value keeps what is shown
 * and what is stored in agreement on both kinds of picker.
 *
 * `noteLabel` is how the extra option explains itself. Onboarding is offering
 * the zone the browser reported, so the default "detected" is accurate there.
 * A settings screen is offering the zone the customer already saved, which is
 * not detected at all, so it passes its own word.
 */
export function timezoneOptionsIncluding(
  zone: string,
  noteLabel = 'detected',
): readonly TimezoneOption[] {
  if (!zone || TIMEZONE_OPTIONS.some((t) => t.value === zone)) return TIMEZONE_OPTIONS;
  return [{ value: zone, label: `${zone} (${noteLabel})` }, ...TIMEZONE_OPTIONS];
}
