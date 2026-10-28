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
});
