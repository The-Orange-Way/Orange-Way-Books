/**
 * V3 Parity — Trial Balance correctness against fixed datasets.
 *
 * This is P6 v1: a fixture-driven sanity check for V3's ledger engine.
 * Catches regressions in computeAccountBalances + computeTrialBalance
 * during ongoing dev, without needing a running app or Supabase.
 *
 * Each fixture directory under tests/parity/fixtures/ supplies:
 *   - accounts.json              AccountInfo[]
 *   - journal-lines.json         JournalLine[]
 *   - expected-trial-balance.json   the TB this fixture must produce
 *
 * When the OR Wave-to-V3 converter ships, additional fixtures (derived
 * from real Wave exports, kept off-repo for PII reasons) plug in here.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  computeAccountBalances,
  computeTrialBalance,
  type AccountInfo,
  type JournalLine,
  type TrialBalanceRow,
} from '@/lib/ledger-engine';

interface ExpectedRow {
  accountName: string;
  debit: number;
  credit: number;
}

interface ExpectedTB {
  asOfDate?: string;
  totalDebits: number;
  totalCredits: number;
  isBalanced: boolean;
  rowsByAccountCode: Record<string, ExpectedRow>;
}

function loadJson<T>(fixturePath: string, file: string): T {
  const raw = readFileSync(join(fixturePath, file), 'utf8');
  return JSON.parse(raw) as T;
}

/** Round to 2 decimal places for $-precision comparison. */
function r(n: number): number {
  return Math.round(n * 100) / 100;
}

const FIXTURE_ROOT = join(__dirname, 'fixtures');

const FIXTURES = ['inspire-2024-mini'] as const;

describe.each(FIXTURES)('Trial Balance parity — fixture %s', (fixtureName) => {
  const fixturePath = join(FIXTURE_ROOT, fixtureName);
  const accounts = loadJson<AccountInfo[]>(fixturePath, 'accounts.json');
  const lines = loadJson<JournalLine[]>(fixturePath, 'journal-lines.json');
  const expected = loadJson<ExpectedTB>(fixturePath, 'expected-trial-balance.json');

  const balances = computeAccountBalances(lines, accounts);
  const tb = computeTrialBalance(balances);

  it('balances (debits === credits)', () => {
    expect(tb.isBalanced).toBe(expected.isBalanced);
  });

  it(`totalDebits matches expected (${expected.totalDebits})`, () => {
    expect(r(tb.totalDebits)).toBe(r(expected.totalDebits));
  });

  it(`totalCredits matches expected (${expected.totalCredits})`, () => {
    expect(r(tb.totalCredits)).toBe(r(expected.totalCredits));
  });

  // Compare row by row. Map rows by accountCode for deterministic lookup
  // (ordering inside computeTrialBalance is not part of the test contract).
  const tbByCode = new Map<string, TrialBalanceRow>();
  for (const row of tb.rows) {
    const key = row.accountCode || `_no_code_${row.accountName}`;
    tbByCode.set(key, row);
  }

  it('produces a row for every expected account code', () => {
    const expectedCodes = Object.keys(expected.rowsByAccountCode);
    for (const code of expectedCodes) {
      expect(tbByCode.has(code), `missing row for account code ${code}`).toBe(true);
    }
  });

  for (const [code, exp] of Object.entries(expected.rowsByAccountCode)) {
    it(`row ${code} (${exp.accountName}): debit=${exp.debit}, credit=${exp.credit}`, () => {
      const row = tbByCode.get(code);
      expect(row, `no row for code ${code}`).toBeDefined();
      if (!row) return;
      expect(row.accountName).toBe(exp.accountName);
      expect(r(row.debit)).toBe(r(exp.debit));
      expect(r(row.credit)).toBe(r(exp.credit));
    });
  }

  it('every TB row corresponds to an expected account (no surprise rows)', () => {
    const expectedCodes = new Set(Object.keys(expected.rowsByAccountCode));
    for (const row of tb.rows) {
      if (!row.accountCode) continue;
      expect(
        expectedCodes.has(row.accountCode),
        `unexpected row for account code ${row.accountCode} (${row.accountName})`,
      ).toBe(true);
    }
  });
});
