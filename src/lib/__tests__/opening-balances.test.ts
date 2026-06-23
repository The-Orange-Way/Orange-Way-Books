/**
 * Unit tests for opening-balances validation.
 *
 * Pure-function tests for validateOpeningBalanceEntries +
 * buildOpeningBalanceRefNumber. The DB-roundtrip path is exercised by
 * P6's Playwright live test harness when that lands.
 */

import { describe, it, expect } from 'vitest';
import {
  validateOpeningBalanceEntries,
  buildOpeningBalanceRefNumber,
  OpeningBalanceValidationError,
  type OpeningBalanceEntry,
} from '../opening-balances';

function entry(over: Partial<OpeningBalanceEntry> = {}): OpeningBalanceEntry {
  return {
    accountId: 'acct-1',
    accountName: 'Cash CAD',
    accountCode: '1110',
    currency: 'CAD',
    debit: 0,
    credit: 0,
    ...over,
  };
}

describe('validateOpeningBalanceEntries', () => {
  it('accepts a balanced two-line opening JE', () => {
    const result = validateOpeningBalanceEntries([
      entry({ accountId: 'a1', accountName: 'Cash CAD', debit: 5000, credit: 0 }),
      entry({ accountId: 'a2', accountName: "Owner's Equity", debit: 0, credit: 5000 }),
    ]);
    expect(result).toEqual({ totalDebits: 5000, totalCredits: 5000 });
  });

  it('accepts a multi-account trial balance', () => {
    const entries = [
      entry({ accountId: 'a1', accountName: 'Cash CAD', debit: 5432.1 }),
      entry({ accountId: 'a2', accountName: 'AR', debit: 890.0 }),
      entry({ accountId: 'a3', accountName: 'Visa 4020', credit: 1234.56 }),
      entry({ accountId: 'a4', accountName: 'Retained Earnings', credit: 5087.54 }),
    ];
    const result = validateOpeningBalanceEntries(entries);
    expect(result.totalDebits).toBeCloseTo(6322.1, 2);
    expect(result.totalCredits).toBeCloseTo(6322.1, 2);
  });

  it('rejects empty entries', () => {
    expect(() => validateOpeningBalanceEntries([])).toThrow(OpeningBalanceValidationError);
    expect(() => validateOpeningBalanceEntries([])).toThrow(/at least one/i);
  });

  it('rejects an entry missing accountId', () => {
    expect(() =>
      validateOpeningBalanceEntries([
        entry({ accountId: '', accountName: 'Cash', debit: 100 }),
        entry({ accountId: 'a2', accountName: 'Equity', credit: 100 }),
      ]),
    ).toThrow(/accountId is required/);
  });

  it('rejects duplicate accountId', () => {
    expect(() =>
      validateOpeningBalanceEntries([
        entry({ accountId: 'a1', accountName: 'Cash', debit: 100 }),
        entry({ accountId: 'a1', accountName: 'Cash again', credit: 100 }),
      ]),
    ).toThrow(/more than once/);
  });

  it('rejects negative amounts', () => {
    expect(() =>
      validateOpeningBalanceEntries([
        entry({ accountId: 'a1', debit: -100 }),
        entry({ accountId: 'a2', credit: 100 }),
      ]),
    ).toThrow(/non-negative/);
  });

  it('rejects an entry with both debit and credit > 0', () => {
    expect(() =>
      validateOpeningBalanceEntries([entry({ accountId: 'a1', debit: 50, credit: 50 })]),
    ).toThrow(/cannot have both debit and credit/);
  });

  it('rejects a zero-amount line', () => {
    expect(() =>
      validateOpeningBalanceEntries([entry({ accountId: 'a1', debit: 0, credit: 0 })]),
    ).toThrow(/zero amount/);
  });

  it('rejects missing currency', () => {
    expect(() =>
      validateOpeningBalanceEntries([
        entry({ accountId: 'a1', currency: '', debit: 100 }),
        entry({ accountId: 'a2', credit: 100 }),
      ]),
    ).toThrow(/currency is required/);
  });

  it('rejects unbalanced totals', () => {
    expect(() =>
      validateOpeningBalanceEntries([
        entry({ accountId: 'a1', debit: 100 }),
        entry({ accountId: 'a2', credit: 90 }),
      ]),
    ).toThrow(/does not balance/);
  });

  it('tolerates sub-cent floating-point drift (within 0.005)', () => {
    // 100.10 + 200.20 + 50.05 = 350.35
    // 350.34 + 0.01 = 350.35, but float arithmetic may give 350.34999...
    const result = validateOpeningBalanceEntries([
      entry({ accountId: 'a1', debit: 100.1 }),
      entry({ accountId: 'a2', debit: 200.2 }),
      entry({ accountId: 'a3', debit: 50.05 }),
      entry({ accountId: 'a4', credit: 350.35 }),
    ]);
    expect(result.totalDebits).toBeCloseTo(350.35, 2);
    expect(result.totalCredits).toBeCloseTo(350.35, 2);
  });
});

describe('buildOpeningBalanceRefNumber', () => {
  it('produces OPEN-BAL-<date>', () => {
    expect(buildOpeningBalanceRefNumber('2024-01-01')).toBe('OPEN-BAL-2024-01-01');
  });

  it('trims time component if present', () => {
    expect(buildOpeningBalanceRefNumber('2024-01-01T00:00:00Z')).toBe('OPEN-BAL-2024-01-01');
  });
});
