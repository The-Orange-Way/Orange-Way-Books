import { describe, it, expect } from 'vitest';
import { TIMEZONE_OPTIONS, timezoneOptionsIncluding } from '@/lib/timezones';

describe('TIMEZONE_OPTIONS', () => {
  it('carries the zones that used to exist only in Admin settings', () => {
    const values = TIMEZONE_OPTIONS.map((t) => t.value);
    // Admin held its own list until this module adopted these three. If they
    // are dropped here they silently disappear from a screen that offers them
    // today, which is the drift this list exists to prevent.
    expect(values).toContain('America/Anchorage');
    expect(values).toContain('Pacific/Honolulu');
    expect(values).toContain('Asia/Shanghai');
  });

  it('has no duplicate values, because a duplicate key breaks the picker', () => {
    const values = TIMEZONE_OPTIONS.map((t) => t.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('labels every entry', () => {
    for (const t of TIMEZONE_OPTIONS) {
      expect(t.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('timezoneOptionsIncluding', () => {
  it('returns the curated list untouched when the zone is already in it', () => {
    expect(timezoneOptionsIncluding('Europe/London')).toBe(TIMEZONE_OPTIONS);
  });

  it('returns the curated list untouched when there is no zone', () => {
    expect(timezoneOptionsIncluding('')).toBe(TIMEZONE_OPTIONS);
  });

  it('offers a stored zone that is not curated, so the picker is never blank', () => {
    // The customer saved Europe/Madrid. It is not one of the curated entries,
    // and a Select whose value matches no option renders nothing: the customer
    // reads "no timezone set" for a timezone they set. Injecting the stored
    // value guarantees the control always has something to show.
    const options = timezoneOptionsIncluding('Europe/Madrid');
    const match = options.find((t) => t.value === 'Europe/Madrid');
    expect(match).toBeDefined();
    expect(options[0].value).toBe('Europe/Madrid');
    expect(options.length).toBe(TIMEZONE_OPTIONS.length + 1);
  });

  it('keeps every curated entry when it injects the stored zone', () => {
    const options = timezoneOptionsIncluding('America/Bogota');
    for (const t of TIMEZONE_OPTIONS) {
      expect(options).toContainEqual(t);
    }
  });

  it('lets the caller name the injected entry', () => {
    // Onboarding really did detect the zone from the browser. Admin settings
    // read it back out of the customer's saved books, where "detected" would
    // be a false statement about where the value came from.
    expect(timezoneOptionsIncluding('Europe/Madrid')[0].label).toBe('Europe/Madrid (detected)');
    expect(timezoneOptionsIncluding('Europe/Madrid', 'current setting')[0].label).toBe(
      'Europe/Madrid (current setting)',
    );
  });
});
