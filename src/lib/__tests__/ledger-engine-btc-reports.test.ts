// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  type AccountInfo,
  type JournalLine,
  computeAccountBalances,
  computeBalanceSheet,
  computeGeneralLedger,
  computeTrialBalance,
  countExcludedInRange,
  currencyDecimals,
  prepareReportLines,
} from '../ledger-engine';
import { effectiveReportCurrencyMode } from '../reports/effective-currency-mode';

// A BTC-primary company with a BTC wallet and a CAD wallet.
const accounts: AccountInfo[] = [
  {
    id: 'btc',
    name: 'BTC Wallet',
    code: null,
    accountType: 'ASSET',
    accountGroup: 'Assets',
    accountCategory: null,
  },
  {
    id: 'cad',
    name: 'CAD Wallet',
    code: null,
    accountType: 'ASSET',
    accountGroup: 'Assets',
    accountCategory: null,
  },
  {
    id: 'equity',
    name: "Owner's Equity",
    code: '3000',
    accountType: 'EQUITY',
    accountGroup: 'Equity',
    accountCategory: null,
  },
];

const line = (
  je: string,
  accountId: string,
  native: number,
  extra: Partial<JournalLine> = {},
): JournalLine => ({
  date: '2026-03-01',
  accountId,
  accountName: null,
  accountCode: null,
  debit: native > 0 ? native : 0,
  credit: native < 0 ? -native : 0,
  description: null,
  journalEntryId: je,
  ...extra,
});

// Opening 0.5 BTC; a CA$7 wallet worth 0.00006 BTC; a CA$40 wallet with no BTC amount yet.
const lines: JournalLine[] = [
  line('open', 'btc', 0.5, { amountPrimary: 0.5, walletCurrency: 'BTC' }),
  line('open', 'equity', -0.5, { amountPrimary: -0.5, walletCurrency: 'BTC' }),
  line('cad7', 'cad', 7, { amountPrimary: 0.00006, walletCurrency: 'CAD' }),
  line('cad7', 'equity', -7, { amountPrimary: -0.00006, walletCurrency: 'CAD' }),
  line('cad40', 'cad', 40, { amountPrimary: null, walletCurrency: 'CAD' }),
  line('cad40', 'equity', -40, { amountPrimary: null, walletCurrency: 'CAD' }),
];

const balancesOf = (ls: JournalLine[], decimals?: number) =>
  computeAccountBalances(ls, accounts, undefined, decimals);
const balanceOf = (ls: JournalLine[], id: string, decimals?: number) =>
  balancesOf(ls, decimals).find((b) => b.accountId === id)?.balance;

describe('reports in a BTC-primary company', () => {
  it('keeps each currency to its own decimals', () => {
    expect(['BTC', 'sats', 'USD', 'CAD', 'JPY', 'not-a-code'].map(currencyDecimals)).toEqual([
      8, 0, 2, 2, 0, 2,
    ]);
  });

  it('a CA$7 wallet shows its BTC amount, not zero', () => {
    expect(balanceOf(prepareReportLines(lines, 'BTC', null).lines, 'cad', 8)).toBe(0.00006);
    // Negative control: two-place rounding turns it into 0.
    expect(balanceOf(prepareReportLines(lines, 'BTC', null).lines, 'cad')).toBe(0);
  });

  it('leaves out whole entries waiting for a rate, lists them, and the totals balance', () => {
    const { lines: ready, excluded } = prepareReportLines(lines, 'BTC', null);
    expect(excluded).toEqual([
      { journalEntryId: 'cad40', date: '2026-03-01', reason: 'awaiting-rate' },
    ]);
    expect(ready.some((l) => l.journalEntryId === 'cad40')).toBe(false);
    const tb = computeTrialBalance(balancesOf(ready, 8), 8);
    expect([tb.totalDebits, tb.totalCredits, tb.isBalanced]).toEqual([0.50006, 0.50006, true]);
    // Negative control: unprepared, CA$40 is summed as 40 BTC.
    expect(balanceOf(lines, 'cad', 8)).toBe(40.00006);
  });

  it('a rate_pending line holds back its entry even with a provisional amount', () => {
    const pending = [
      line('p', 'cad', 5, { amountPrimary: 0.00004, walletCurrency: 'CAD', ratePending: true }),
      line('p', 'equity', -5, { amountPrimary: -0.00004, walletCurrency: 'CAD' }),
    ];
    expect(prepareReportLines(pending, 'BTC', null).excluded.map((e) => e.reason)).toEqual([
      'awaiting-rate',
    ]);
  });

  it('a line in the primary currency with no primary amount is kept at its own amount', () => {
    const own = [
      line('l', 'btc', 0.1, { walletCurrency: 'BTC' }),
      line('l', 'equity', -0.1, { walletCurrency: 'BTC' }),
    ];
    const { lines: ready, excluded } = prepareReportLines(own, 'BTC', null);
    expect(excluded).toEqual([]);
    expect(balanceOf(ready, 'btc', 8)).toBe(0.1);
  });

  it('a line with no currency and no primary amount is left out, not read as BTC', () => {
    const legacy = [line('old', 'cad', 40), line('old', 'equity', -40)];
    const { lines: ready, excluded } = prepareReportLines([...lines, ...legacy], 'BTC', null);
    expect(excluded.find((e) => e.journalEntryId === 'old')?.reason).toBe('unknown-currency');
    expect(balanceOf(ready, 'cad', 8)).toBe(0.00006);
    // Negative control: kept as is, CA$40 becomes 40 BTC.
    expect(balanceOf(legacy, 'cad', 8)).toBe(40);
  });

  it('a line posted under an earlier primary currency is left out, not read as BTC', () => {
    const usdEra = [
      line('usd', 'btc', 100, { amountPrimary: 100, primaryCurrencyAtPosting: 'USD' }),
      line('usd', 'equity', -100, { amountPrimary: -100, primaryCurrencyAtPosting: 'USD' }),
    ];
    const { lines: ready, excluded } = prepareReportLines([...lines, ...usdEra], 'BTC', null);
    expect(excluded.find((e) => e.journalEntryId === 'usd')?.reason).toBe('other-primary');
    expect(balanceOf(ready, 'btc', 8)).toBe(0.5);
    // Negative control: kept, US$100 is summed as 100 BTC.
    expect(balanceOf([...lines.slice(0, 2), ...usdEra], 'btc', 8)).toBe(100.5);
    // Posted under the current primary currency: kept.
    const btcEra = usdEra.map((l) => ({ ...l, primaryCurrencyAtPosting: 'btc' }));
    expect(prepareReportLines(btcEra, 'BTC', null).excluded).toEqual([]);
  });

  it('the secondary view converts every row: balance equals BTC amount times the rate', () => {
    const rate = 100000;
    const btcBal = balancesOf(prepareReportLines(lines, 'BTC', null).lines, 8);
    const usdBal = balancesOf(prepareReportLines(lines, 'BTC', rate).lines, 2);
    for (const b of usdBal) {
      const inBtc = btcBal.find((x) => x.accountId === b.accountId)!.balance;
      expect(b.balance).toBeCloseTo(inBtc * rate, 2);
    }
    expect(usdBal.find((b) => b.accountId === 'btc')?.balance).toBe(50000);
    // Negative control: scaling only debit and credit leaves BTC under a dollar label.
    const old = lines.map((l) => ({ ...l, debit: l.debit * rate, credit: l.credit * rate }));
    expect(balanceOf(old, 'btc')).toBe(0.5);
  });

  it('the general ledger and drill-down rows show the BTC amount, not the CAD one', () => {
    const gl = (rate: number | null, decimals: number) =>
      computeGeneralLedger(
        prepareReportLines(lines, 'BTC', rate).lines,
        accounts,
        undefined,
        decimals,
      )
        .filter((e) => e.accountName === 'CAD Wallet')
        .map((e) => [e.debit, e.runningBalance]);
    expect(gl(null, 8)).toEqual([[0.00006, 0.00006]]);
    expect(gl(100000, 2)).toEqual([[6, 6]]);
    // Negative control: the ledger on unprepared lines shows CA$7 as 7.
    expect(
      computeGeneralLedger(lines, accounts, undefined, 8).find(
        (e) => e.accountName === 'CAD Wallet' && e.journalEntryId === 'cad7',
      )?.debit,
    ).toBe(7);
  });
});

describe('rounding cannot unbalance a balanced ledger', () => {
  const three: AccountInfo[] = [...accounts, { ...accounts[1], id: 'cad2', name: 'Second Wallet' }];
  const tiny = (scale: number) => [
    line('t', 'btc', 0.00000005 * scale, { amountPrimary: 0.00000005, walletCurrency: 'BTC' }),
    line('t', 'cad2', 0.00000005 * scale, { amountPrimary: 0.00000005, walletCurrency: 'BTC' }),
    line('t', 'equity', -0.0000001 * scale, { amountPrimary: -0.0000001, walletCurrency: 'BTC' }),
  ];

  it('5 + 5 sats against 10 sats at US$100,000 is balanced at $0.01', () => {
    const usd = prepareReportLines(tiny(1), 'BTC', 100000).lines;
    const tb = computeTrialBalance(computeAccountBalances(usd, three, undefined, 2), 2);
    expect([tb.totalDebits, tb.totalCredits, tb.isBalanced]).toEqual([0.01, 0.01, true]);
    // Negative control: rounding each account first gives 0.02 against 0.01.
    const old = computeTrialBalance(computeAccountBalances(usd, three));
    expect([old.totalDebits, old.totalCredits]).toEqual([0.02, 0.01]);
  });

  it('in sats, 600.6 + 600.6 against 1201.2 is balanced', () => {
    const sats = [
      line('s', 'btc', 600.6, { walletCurrency: 'SATS' }),
      line('s', 'cad2', 600.6, { walletCurrency: 'SATS' }),
      line('s', 'equity', -1201.2, { walletCurrency: 'SATS' }),
    ];
    const ready = prepareReportLines(sats, 'SATS', null).lines;
    const tb = computeTrialBalance(computeAccountBalances(ready, three, undefined, 0), 0);
    expect([tb.totalDebits, tb.totalCredits, tb.isBalanced]).toEqual([1201, 1201, true]);
    const bs = computeBalanceSheet(computeAccountBalances(ready, three, undefined, 0), 0);
    expect(bs.assets.total).toBe(bs.totalLiabilitiesAndEquity);
  });

  it('one satoshi off is not balanced', () => {
    const off = [
      line('x', 'btc', 0.5, { amountPrimary: 0.5, walletCurrency: 'BTC' }),
      line('x', 'equity', -0.49999999, { amountPrimary: -0.49999999, walletCurrency: 'BTC' }),
    ];
    expect(computeTrialBalance(balancesOf(off, 8), 8).isBalanced).toBe(false);
    // Negative control: the old 0.01 tolerance called 10,000 sats off balanced.
    const far = [off[0], { ...off[1], credit: 0.4999, amountPrimary: -0.4999 }];
    expect(computeTrialBalance(balancesOf(far)).isBalanced).toBe(true);
  });
});

describe('a report outside Bitcoin is computed exactly as before', () => {
  it('a ¥0.49 balance stays 0.49 with the default rounding', () => {
    const yen = [line('y', 'cad', 0.49), line('y', 'equity', -0.49)];
    expect(balanceOf(yen, 'cad')).toBe(0.49);
  });
});

describe('which entries a report says it left out', () => {
  const excluded = [
    { journalEntryId: 'a', date: '2025-06-01', reason: 'awaiting-rate' as const },
    { journalEntryId: 'b', date: '2026-06-01', reason: 'awaiting-rate' as const },
  ];
  it('counts only entries in the report period', () => {
    expect(
      countExcludedInRange(excluded, { from: new Date(2026, 0, 1), to: new Date(2026, 11, 31) }),
    ).toBe(1);
    expect(countExcludedInRange(excluded, { to: new Date(2026, 11, 31) })).toBe(2);
    expect(countExcludedInRange(excluded)).toBe(2);
  });
});

describe('the currency mode a report is really in', () => {
  it('wallet only on the general ledger, secondary only with a rate', () => {
    expect(effectiveReportCurrencyMode('wallet', 'general-ledger', true)).toBe('wallet');
    expect(effectiveReportCurrencyMode('wallet', 'trial-balance', true)).toBe('primary');
    expect(effectiveReportCurrencyMode('secondary', 'pnl', false)).toBe('primary');
    expect(effectiveReportCurrencyMode('secondary', 'pnl', true)).toBe('secondary');
    expect(effectiveReportCurrencyMode('primary', 'pnl', true)).toBe('primary');
  });
});
