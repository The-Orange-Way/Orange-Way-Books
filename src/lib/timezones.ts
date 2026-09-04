// Single source of truth for the timezone list. The v1 reporting step
// (StepReporting), the v2 organization setup surface (OrgSetupSurface) and
// Admin settings all read from here so the lists cannot drift, which is the
// same reason months.ts exists: a drifted list silently stores a value another
// surface cannot show back to the customer.
//
// Alaska, Hawaii and Shanghai were carried only by Admin settings until this
// module adopted them. Anything added here is offered on every surface at
// once, which is the point.

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
 * The curated list above is sixteen entries and the browser's zone is very
 * often not one of them. A picker whose value matches no option displays the
 * first option while the state still holds the seeded value, so the customer
 * reads one timezone and saves another. Returning a list that always contains
 * the current value keeps what is shown and what is stored in agreement.
 *
 * `note` is the parenthetical on the injected entry. It defaults to the
 * onboarding wording, where the zone really did come from the browser. Admin
 * settings passes its own word, because a zone read back out of the customer's
 * saved books was not detected by anything.
 */
export function timezoneOptionsIncluding(
  zone: string,
  note = 'detected',
): readonly TimezoneOption[] {
  if (!zone || TIMEZONE_OPTIONS.some((t) => t.value === zone)) return TIMEZONE_OPTIONS;
  return [{ value: zone, label: `${zone} (${note})` }, ...TIMEZONE_OPTIONS];
}

/**
 * The option list for a picker seeded from browser detection, with the
 * empty-detection fallback disclosed as a guess (OWB-T0171).
 *
 * timezoneOptionsIncluding only injects a labelled entry when the zone is
 * present and not already curated. When browserTimezone() reports nothing,
 * the caller falls back to TIMEZONE_OPTIONS[0] (America/New_York), which IS
 * already curated, so timezoneOptionsIncluding('') injects nothing and the
 * fallback renders indistinguishable from a real choice. This wraps that
 * case so a failed detection carries the same disclosure a successful one
 * gets, instead of the opposite.
 */
export function timezoneOptionsForDetection(detectedZone: string): readonly TimezoneOption[] {
  const options = timezoneOptionsIncluding(detectedZone);
  if (detectedZone) return options;
  const fallback = options[0];
  return [{ ...fallback, label: `${fallback.label} (guessed, please confirm)` }, ...options.slice(1)];
}
