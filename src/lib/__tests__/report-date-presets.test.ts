// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { journalLineInDateRange } from '@/lib/ledger-engine';
import { getDateRange } from '@/lib/reports/date-presets';

afterEach(() => vi.useRealTimers());

describe('report date presets end on the last day of the period', () => {
  it('last year ends on 31 December, so a 1 January entry is left out', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 28, 12));
    const r = getDateRange('last_year');
    expect(r.to?.getFullYear()).toBe(2025);
    expect([r.to?.getMonth(), r.to?.getDate()]).toEqual([11, 31]);
    expect(journalLineInDateRange('2025-12-31', r)).toBe(true);
    expect(journalLineInDateRange('2026-01-01', r)).toBe(false);
  });

  it('last month ends on its own last day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 28, 12));
    const r = getDateRange('last_month');
    expect([r.to?.getMonth(), r.to?.getDate()]).toEqual([8, 30]);
    expect(journalLineInDateRange('2026-10-01', r)).toBe(false);
  });

  it('negative control: the old end date (1 January) let the next year in', () => {
    const old = { from: new Date(2025, 0, 1), to: new Date(2026, 0, 1) };
    expect(journalLineInDateRange('2026-01-01', old)).toBe(true);
  });

  describe('west of UTC (Toronto)', () => {
    const savedTz = process.env.TZ;
    afterEach(() => {
      process.env.TZ = savedTz;
    });

    it('last year holds 1 January of that year and not of the next', () => {
      process.env.TZ = 'America/Toronto';
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 9, 28, 12));
      const r = getDateRange('last_year');
      expect(journalLineInDateRange('2025-01-01', r)).toBe(true);
      expect(journalLineInDateRange('2026-01-01', r)).toBe(false);
    });

    it("today includes today's entries", () => {
      process.env.TZ = 'America/Toronto';
      vi.useFakeTimers();
      vi.setSystemTime(new Date(2026, 9, 28, 12));
      expect(journalLineInDateRange('2026-10-28', getDateRange('today'))).toBe(true);
    });

    it('negative control: the old UTC-midnight comparison lets 1 January into last year', () => {
      process.env.TZ = 'America/Toronto';
      const old = (dateStr: string, range: { from?: Date; to?: Date }) => {
        const d = new Date(dateStr);
        if (range.from && d < range.from) return false;
        if (range.to) {
          const to = new Date(range.to);
          to.setHours(23, 59, 59, 999);
          if (d > to) return false;
        }
        return true;
      };
      const r = { from: new Date(2025, 0, 1), to: new Date(2025, 11, 31) };
      expect(old('2026-01-01', r)).toBe(true);
      expect(old('2025-01-01', r)).toBe(false);
    });
  });
});
