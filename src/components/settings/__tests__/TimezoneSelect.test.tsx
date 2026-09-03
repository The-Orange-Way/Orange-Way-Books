/**
 * The settings timezone picker (OWB-T0149).
 *
 * Admin settings used to carry its own 16-entry timezone list, bound straight
 * to a Radix Select with no guarantee that the stored zone was one of them. A
 * Radix trigger whose value matches no item renders nothing at all, so a
 * customer in Madrid or Bogota opened settings and read "no timezone set"
 * while one was set. These assert the rendered trigger, which is the exact
 * surface that was blank.
 *
 * The listbox is never opened. Reading the closed trigger is what the customer
 * sees on arriving at the page, and it needs none of the pointer polyfills a
 * Radix listbox would require and this repo's vitest setup does not provide.
 */
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { TIMEZONE_OPTIONS } from '@/lib/timezones';
import { TimezoneSelect } from '../TimezoneSelect';

describe('TimezoneSelect', () => {
  it('shows a stored zone that is not one of the curated entries', async () => {
    render(
      <TimezoneSelect value="Europe/Madrid" onValueChange={vi.fn()} testId="admin-timezone" />,
    );

    // Not "detected": this is the zone the customer already saved.
    await waitFor(() =>
      expect(screen.getByTestId('admin-timezone')).toHaveTextContent('Europe/Madrid (current)'),
    );
  });

  it('shows the friendly label for a curated zone', async () => {
    render(<TimezoneSelect value="Asia/Tokyo" onValueChange={vi.fn()} testId="admin-timezone" />);

    await waitFor(() =>
      expect(screen.getByTestId('admin-timezone')).toHaveTextContent('Tokyo (JST)'),
    );
    // The curated entry is used as-is, not duplicated with a "(current)" twin.
    expect(screen.getByTestId('admin-timezone')).not.toHaveTextContent('(current)');
  });

  it('says so when no timezone is set, instead of rendering empty', async () => {
    render(<TimezoneSelect value="" onValueChange={vi.fn()} testId="admin-timezone" />);

    await waitFor(() =>
      expect(screen.getByTestId('admin-timezone')).toHaveTextContent('No timezone set'),
    );
  });

  it('keeps the three zones that used to exist only in Admin settings', () => {
    const values = TIMEZONE_OPTIONS.map((t) => t.value);
    // Alaska, Hawaii and mainland China are real places to run a business
    // from. They were in Admin's inline list and not in the shared one, so a
    // later tidy-up of the shared list would drop them from both surfaces at
    // once. That is the same drift as before, pointing the other way.
    expect(values).toContain('America/Anchorage');
    expect(values).toContain('Pacific/Honolulu');
    expect(values).toContain('Asia/Shanghai');
  });
});
