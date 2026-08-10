// Single source of truth for month names and name-to-number mapping.
// Onboarding (StepCalendar, OnboardingWizard) and Admin all read from here so
// the lists cannot drift and silently resolve an unknown month to January,
// which is the failure that reopened DL-0720.

export const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

// Returns the 1-based month number for a name in any case, or 0 when the name
// is not a recognized month. Callers MUST treat 0 as an error and never coerce
// it to a default, so a drift or a bad value fails loudly instead of quietly
// picking January.
export function monthNumber(name: string): number {
  return MONTH_NAMES.findIndex((m) => m.toLowerCase() === name.trim().toLowerCase()) + 1;
}
