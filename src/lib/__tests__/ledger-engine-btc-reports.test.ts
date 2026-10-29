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
  reportDifference,
  toMinorUnits,
} from '../ledger-engine';
import { formatNumericForCsvCell } from '@/lib/exports/format-numeric-csv';
import { roundGroupToMinorUnits } from '@/lib/minor-units';
import { transactionAmountNumericForCsv } from '@/lib/exports/csv-transaction-amount';
import { effectiveReportCurrencyMode } from '../reports/effective-currency-mode';
import { printCellText } from '../reports/print-cell-text';
import { excludedEntriesNote } from '../reports/excluded-note';
import { decryptJournalEntryLine } from '../crypto-fields';
import { type CoaClosureRow, buildReportHierarchyRoots } from '../reports/report-hierarchy';

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
    const usd = prepareReportLines(tiny(1), 'BTC', 100000, 2).lines;
    const tb = computeTrialBalance(computeAccountBalances(usd, three, undefined, 2), 2);
    expect([tb.totalDebits, tb.totalCredits, tb.isBalanced]).toEqual([0.01, 0.01, true]);
    // Negative control: rounding each account first gives 0.02 against 0.01.
    const old = computeTrialBalance(
      computeAccountBalances(prepareReportLines(tiny(1), 'BTC', 100000).lines, three),
    );
    expect([old.totalDebits, old.totalCredits]).toEqual([0.02, 0.01]);
  });

  it('in sats, 600.6 + 600.6 against 1201.2 is balanced', () => {
    const sats = [
      line('s', 'btc', 600.6, { walletCurrency: 'SATS' }),
      line('s', 'cad2', 600.6, { walletCurrency: 'SATS' }),
      line('s', 'equity', -1201.2, { walletCurrency: 'SATS' }),
    ];
    const ready = prepareReportLines(sats, 'SATS', null, 0).lines;
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

describe('printed Bitcoin amounts', () => {
  it('50 sats prints as a plain decimal, not 5e-7', () => {
    expect(printCellText(0.0000005, 8)).toBe('0.00000050');
    expect(printCellText(1201, 0)).toBe('1201');
    expect(printCellText('Total Assets', 8)).toBe('Total Assets');
    // Negative control: the old String() print gives exponent form.
    expect(printCellText(0.0000005)).toBe('5e-7');
  });
});

describe('old imported entries and their reversals', () => {
  // An imported line from before dual currency: no line currency, the entry carries it.
  const orig = [
    line('old', 'btc', 0.5, { entryCurrency: 'BTC' }),
    line('old', 'equity', -0.5, { entryCurrency: 'BTC' }),
  ];
  const rev = [
    line('rev', 'btc', -0.5, { amountPrimary: -0.5, walletCurrency: 'BTC', reversalOfId: 'old' }),
    line('rev', 'equity', 0.5, { amountPrimary: 0.5, walletCurrency: 'BTC', reversalOfId: 'old' }),
  ];
  const btcBalance = (ls: JournalLine[]) =>
    computeAccountBalances(ls, accounts, undefined, 8).find((b) => b.accountId === 'btc')
      ?.balance ?? 0;

  it("uses the entry's currency: a BTC entry is kept and nets to zero with its reversal", () => {
    const r = prepareReportLines([...orig, ...rev], 'BTC', null, 8);
    expect(r.excluded).toEqual([]);
    expect(btcBalance(r.lines)).toBe(0);
  });

  it('a reversal of a left-out entry is left out with it', () => {
    const usdOrig = orig.map((l) => ({ ...l, entryCurrency: 'USD' }));
    const r = prepareReportLines([...usdOrig, ...rev], 'BTC', null, 8);
    expect(r.excluded.map((e) => e.journalEntryId).sort()).toEqual(['old', 'rev']);
    expect(btcBalance(r.lines)).toBe(0);
  });

  it('negative control: without the entry currency or the reversal link it shows -0.5 BTC', () => {
    const bare = orig.map((l) => ({ ...l, entryCurrency: null }));
    const unlinked = rev.map((l) => ({ ...l, reversalOfId: null }));
    const r = prepareReportLines([...bare, ...unlinked], 'BTC', null, 8);
    expect(r.excluded.map((e) => e.reason)).toEqual(['unknown-currency']);
    expect(btcBalance(r.lines)).toBe(-0.5);
  });
});

describe('rows add up to the totals shown', () => {
  const sats = [
    line('a', 'btc', 600.6, { amountPrimary: 600.6 }),
    line('a', 'equity', -600.6, { amountPrimary: -600.6 }),
    line('b', 'btc', 600.6, { amountPrimary: 600.6 }),
    line('b', 'equity', -600.6, { amountPrimary: -600.6 }),
  ];

  it('sats: rows 601 + 601 and the total 1202', () => {
    const r = prepareReportLines(sats, 'SATS', null, 0);
    const gl = computeGeneralLedger(r.lines, accounts, undefined, 0);
    expect(gl.filter((g) => g.accountName === 'BTC Wallet').map((g) => g.debit)).toEqual([
      601, 601,
    ]);
    const tb = computeTrialBalance(computeAccountBalances(r.lines, accounts, undefined, 0), 0);
    expect([tb.totalDebits, tb.isBalanced]).toEqual([1202, true]);
  });

  it('an entry split three ways still balances to the satoshi', () => {
    const third = 1 / 3;
    const split = [
      line('s', 'btc', 1, { amountPrimary: 1 }),
      line('s', 'equity', -third, { amountPrimary: -third }),
      line('s', 'equity', -third, { amountPrimary: -third }),
      line('s', 'cad', -third, { amountPrimary: -third }),
    ];
    const r = prepareReportLines(split, 'BTC', null, 8);
    const units = r.lines.map((l) => Math.round((l.debit - l.credit) * 1e8));
    expect(units.reduce((a, b) => a + b, 0)).toBe(0);
    const tb = computeTrialBalance(computeAccountBalances(r.lines, accounts, undefined, 8), 8);
    expect(tb.isBalanced).toBe(true);
    const shown = tb.rows.reduce((s, row) => s + Math.round(row.debit * 1e8), 0);
    expect(shown).toBe(Math.round(tb.totalDebits * 1e8));
  });

  it('negative control: rounding the rows and the unrounded total separately does not foot', () => {
    expect(Math.round(600.6) + Math.round(600.6)).toBe(1202);
    expect(Math.round(600.6 + 600.6)).toBe(1201);
  });
});

describe('the note about left-out entries', () => {
  const e = (id: string, reason: 'awaiting-rate' | 'other-primary' | 'unknown-currency') => ({
    journalEntryId: id,
    date: '2026-03-01',
    reason,
  });
  it('says why, per reason', () => {
    expect(
      excludedEntriesNote([e('a', 'awaiting-rate'), e('b', 'unknown-currency')], null, 'BTC'),
    ).toBe(
      '2 entries are not in these BTC totals: 1 waiting for an exchange rate, 1 has no readable currency.',
    );
    expect(excludedEntriesNote([], [e('c', 'other-primary')], 'BTC')).toBe(
      '0 entries are not in these BTC totals (1 in the prior period): 1 posted under an earlier primary currency.',
    );
  });
  it('is empty when nothing is left out', () => {
    expect(excludedEntriesNote([], null, 'BTC')).toBeNull();
    expect(excludedEntriesNote([], [], 'BTC')).toBeNull();
  });
});

describe('reading the posting currency back', () => {
  it('decrypts encrypted_primary_currency_at_posting', async () => {
    const dec = async (v: string) => v.replace(/^enc:/, '');
    const f = await decryptJournalEntryLine(
      { key_version: 2, encrypted_primary_currency_at_posting: 'enc:USD' },
      dec,
    );
    expect(f.primary_currency_at_posting).toBe('USD');
    // Negative control: the plaintext column this page used to read does not exist on the row.
    const row: Record<string, unknown> = { encrypted_primary_currency_at_posting: 'enc:USD' };
    expect(row.primary_currency_at_posting).toBeUndefined();
  });
});

describe('round 4: rounding keeps reversals and long books exact', () => {
  const pair = (je: string, sign: number, extra: Partial<JournalLine> = {}) => [
    line(je, 'btc', sign * 0.000002, { amountPrimary: sign * 0.000002, ...extra }),
    line(je, 'equity', -sign * 0.000002, { amountPrimary: -sign * 0.000002, ...extra }),
  ];
  const usd = (ls: JournalLine[]) =>
    computeAccountBalances(prepareReportLines(ls, 'BTC', 62500, 2).lines, accounts, undefined, 2);

  it('an exact reversal cancels to zero at a half-cent tie, in either line order', () => {
    const orig = pair('o', 1);
    const rev = pair('r', -1, { reversalOfId: 'o' });
    expect(usd([...orig, ...rev]).find((b) => b.accountId === 'btc')?.balance).toBe(0);
    expect(usd([...orig, ...[...rev].reverse()]).find((b) => b.accountId === 'btc')?.balance).toBe(
      0,
    );
  });

  it('negative control: the amount is a tie and plain Math.round is not symmetric', () => {
    expect(0.000002 * 62500 * 100).toBeCloseTo(12.5, 9);
    expect([Math.round(12.5), Math.round(-12.5)]).toEqual([13, -12]);
  });

  it('10,000 entries of 10.1 BTC: rows 50,500 + 50,500, total 101,000, balanced', () => {
    const many: JournalLine[] = [];
    for (let i = 0; i < 10000; i++) {
      many.push(line(`m${i}`, i % 2 ? 'cad' : 'btc', 10.1, { amountPrimary: 10.1 }));
      many.push(line(`m${i}`, 'equity', -10.1, { amountPrimary: -10.1 }));
    }
    const bal = computeAccountBalances(
      prepareReportLines(many, 'BTC', null, 8).lines,
      accounts,
      undefined,
      8,
    );
    expect(bal.find((b) => b.accountId === 'btc')?.balance).toBe(50500);
    const tb = computeTrialBalance(bal, 8);
    expect([tb.totalDebits, tb.totalCredits, tb.isBalanced]).toEqual([101000, 101000, true]);
  });

  it('negative control: adding 10.1 five thousand times in floating point is not 50,500', () => {
    let x = 0;
    for (let i = 0; i < 5000; i++) x += 10.1;
    expect(x).not.toBe(50500);
  });
});

describe('round 4: an unreadable posting currency', () => {
  const dec = async (v: string) => {
    if (v === 'bad') throw new Error('auth tag');
    return v.replace(/^enc:/, '');
  };
  it('still loads the line, flags it, and the report leaves it out', async () => {
    const f = await decryptJournalEntryLine(
      { key_version: 2, encrypted_debit: 'enc:5', encrypted_primary_currency_at_posting: 'bad' },
      dec,
    );
    expect([
      f.debit,
      f.primary_currency_at_posting,
      f.primary_currency_at_posting_unreadable,
    ]).toEqual([5, null, true]);
    const r = prepareReportLines(
      [
        line('u', 'btc', 5, { walletCurrency: 'BTC', postingCurrencyUnreadable: true }),
        line('u', 'equity', -5, { walletCurrency: 'BTC' }),
      ],
      'BTC',
      null,
      8,
    );
    expect(r.excluded.map((e) => e.reason)).toEqual(['unknown-currency']);
  });
  it('negative control: a readable one is not flagged and the line is kept', async () => {
    const f = await decryptJournalEntryLine(
      {
        key_version: 2,
        encrypted_debit: 'enc:5',
        encrypted_primary_currency_at_posting: 'enc:BTC',
      },
      dec,
    );
    expect(f.primary_currency_at_posting_unreadable).toBe(false);
    const r = prepareReportLines(
      [
        line('k', 'btc', 5, { walletCurrency: 'BTC' }),
        line('k', 'equity', -5, { walletCurrency: 'BTC' }),
      ],
      'BTC',
      null,
      8,
    );
    expect(r.excluded).toEqual([]);
  });
});

describe('round 5: totals and running balances add whole satoshis', () => {
  // 10,000 postings of 10.1 BTC spread over N asset accounts, each against one equity account.
  const book = (n: number) => {
    const accts: AccountInfo[] = [accounts.find((a) => a.id === 'equity')!];
    for (let k = 0; k < n; k++)
      accts.push({ ...accounts[0], id: `a${k}`, name: `Asset ${k}`, code: `1${k}` });
    const ls: JournalLine[] = [];
    for (let i = 0; i < 10000; i++) {
      ls.push(line(`m${i}`, `a${i % n}`, 10.1, { amountPrimary: 10.1 }));
      ls.push(line(`m${i}`, 'equity', -10.1, { amountPrimary: -10.1 }));
    }
    return { accts, prepared: prepareReportLines(ls, 'BTC', null, 8).lines };
  };

  it.each([200, 10000])('%i accounts: trial balance 101,000 = 101,000, balanced', (n) => {
    const { accts, prepared } = book(n);
    const bal = computeAccountBalances(prepared, accts, undefined, 8);
    const tb = computeTrialBalance(bal, 8);
    expect([tb.totalDebits, tb.totalCredits, tb.isBalanced]).toEqual([101000, 101000, true]);
    const bs = computeBalanceSheet(bal, 8);
    expect([bs.assets.total, bs.totalLiabilitiesAndEquity]).toEqual([101000, 101000]);
  });

  it('the General Ledger ends on the same equity balance the account shows: 101,000', () => {
    const { accts, prepared } = book(2);
    const gl = computeGeneralLedger(prepared, accts, undefined, 8);
    const equityRows = gl.filter((e) => e.accountCode === '3000');
    const lastEquity = equityRows[equityRows.length - 1];
    expect(lastEquity?.runningBalance).toBe(101000);
    const bal = computeAccountBalances(prepared, accts, undefined, 8);
    expect(bal.find((b) => b.accountId === 'equity')?.balance).toBe(101000);
  });

  it('negative control: adding the 10,000 equity amounts in floating point is not 101,000', () => {
    let x = 0;
    for (let i = 0; i < 10000; i++) x += 10.1;
    expect(x).not.toBe(101000);
  });

  it('fiat reports (no decimals) still round each total to cents', () => {
    const { accts } = book(2);
    const ls = [line('f', 'a0', 0.105, {}), line('f', 'equity', -0.105, {})];
    const tb = computeTrialBalance(computeAccountBalances(ls, accts), undefined);
    expect([tb.totalDebits, tb.totalCredits, tb.isBalanced]).toEqual([0.11, 0.11, true]);
  });
});

describe('round 6: account rows and chart subtotals add whole satoshis', () => {
  it('a large posted and reversed book leaves an 18 sat row that matches every total', () => {
    const ls: JournalLine[] = [];
    for (let i = 0; i < 34; i++) {
      ls.push(line(`p${i}`, 'btc', 1000000, { amountPrimary: 1000000 }));
      ls.push(line(`p${i}`, 'equity', -1000000, { amountPrimary: -1000000 }));
      ls.push(line(`r${i}`, 'btc', -1000000, { amountPrimary: -1000000 }));
      ls.push(line(`r${i}`, 'equity', 1000000, { amountPrimary: 1000000 }));
    }
    ls.push(line('d', 'btc', 0.00000019, { amountPrimary: 0.00000019 }));
    ls.push(line('d', 'equity', -0.00000019, { amountPrimary: -0.00000019 }));
    ls.push(line('c', 'btc', -0.00000001, { amountPrimary: -0.00000001 }));
    ls.push(line('c', 'equity', 0.00000001, { amountPrimary: 0.00000001 }));
    const prepared = prepareReportLines(ls, 'BTC', null, 8).lines;
    const bal = computeAccountBalances(prepared, accounts, undefined, 8);
    const row = bal.find((b) => b.accountId === 'btc')!;
    const bs = computeBalanceSheet(bal, 8);
    const tb = computeTrialBalance(bal, 8);
    const gl = computeGeneralLedger(prepared, accounts, undefined, 8).filter(
      (e) => e.accountName === 'BTC Wallet',
    );
    expect(row.balance).toBe(0.00000018);
    expect(bs.assets.total).toBe(row.balance);
    expect(tb.totalDebits).toBe(row.balance);
    expect(gl[gl.length - 1].runningBalance).toBe(row.balance);
  });

  it('a chart parent over 10,000 children of 10.1 BTC shows 101,000', () => {
    const closure = new Map<string, CoaClosureRow>([
      ['parent', { id: 'parent', parentId: null, name: 'Assets', code: '1', accountType: 'ASSET' }],
    ]);
    const leaves = [];
    for (let k = 0; k < 10000; k++) {
      closure.set(`a${k}`, {
        id: `a${k}`,
        parentId: 'parent',
        name: `A${k}`,
        code: `1${k}`,
        accountType: 'ASSET',
      });
      leaves.push({
        accountId: `a${k}`,
        accountName: `A${k}`,
        accountCode: `1${k}`,
        primaryAmount: 10.1,
        nativeAmount: 10.1,
        nativeCurrency: 'BTC',
      });
    }
    const roots = buildReportHierarchyRoots(leaves, closure, () => true, 'BTC', 8);
    expect(roots[0].rollupPrimaryAmount).toBe(101000);
    // Negative control: the same subtotal without decimals is the floating-point sum.
    const plain = buildReportHierarchyRoots(leaves, closure, () => true, 'BTC');
    expect(plain[0].rollupPrimaryAmount).not.toBe(101000);
  });
});

describe('round 7: chart subtotals and comparison differences stay in whole satoshis', () => {
  const parentOf = (amounts: number[], prev?: number[]) => {
    const closure = new Map<string, CoaClosureRow>([
      ['p', { id: 'p', parentId: null, name: 'Assets', code: '1', accountType: 'ASSET' }],
    ]);
    const leaves = amounts.map((a, k) => {
      closure.set(`c${k}`, {
        id: `c${k}`,
        parentId: 'p',
        name: `C${k}`,
        code: `1${k}`,
        accountType: 'ASSET',
      });
      return {
        accountId: `c${k}`,
        accountName: `C${k}`,
        accountCode: `1${k}`,
        primaryAmount: a,
        nativeAmount: a,
        nativeCurrency: 'BTC',
        ...(prev ? { prevPrimaryAmount: prev[k] } : {}),
      };
    });
    return buildReportHierarchyRoots(leaves, closure, () => true, 'BTC', 8)[0];
  };
  const big = [17000000, 17000000.00000019, -17000000, -17000000];

  it('four large children netting to 19 sats give a 19 sat parent, now and prior', () => {
    const p = parentOf(big, big);
    expect(p.rollupPrimaryAmount).toBe(0.00000019);
    expect(p.rollupPrevPrimaryAmount).toBe(0.00000019);
  });

  it('negative control: rounding each partial sum to BTC and back gives 20 sats', () => {
    const u = 1e8;
    const add = (a: number, b: number) => (Math.round(a * u) + Math.round(b * u)) / u;
    expect(big.reduce(add, 0)).toBe(0.0000002);
  });

  it('a Bitcoin variance keeps the last satoshi; a fiat variance subtracts as before', () => {
    expect(reportDifference(20000000, -20000000.00000002, 'BTC')).toBe(40000000.00000002);
    expect(reportDifference(20000000, -20000000.00000002, 'BTC')).not.toBe(
      20000000 - -20000000.00000002,
    );
    expect(reportDifference(10.1, 3.3, 'USD')).toBe(10.1 - 3.3);
  });
});

describe('round 8: a large Bitcoin amount converts to the exact satoshi count', () => {
  it('34000000.00000019 BTC is 19 satoshis over 34000000, in a variance and in a chart parent', () => {
    expect(reportDifference(34000000.00000019, 34000000, 'BTC')).toBe(0.00000019);
    const closure = new Map<string, CoaClosureRow>([
      ['p', { id: 'p', parentId: null, name: 'Assets', code: '1', accountType: 'ASSET' }],
      ['a', { id: 'a', parentId: 'p', name: 'A', code: '11', accountType: 'ASSET' }],
      ['b', { id: 'b', parentId: 'p', name: 'B', code: '12', accountType: 'ASSET' }],
    ]);
    const leaf = (id: string, amt: number) => ({
      accountId: id,
      accountName: id,
      accountCode: id,
      primaryAmount: amt,
      nativeAmount: amt,
      nativeCurrency: 'BTC',
    });
    const [p] = buildReportHierarchyRoots(
      [leaf('a', 34000000.00000019), leaf('b', -34000000)],
      closure,
      () => true,
      'BTC',
      8,
    );
    expect(p.rollupPrimaryAmount).toBe(0.00000019);
  });

  it('negative control: multiplying by 1e8 first rounds to 20', () => {
    expect(Math.round(34000000.00000019 * 1e8) - 3400000000000000).toBe(20);
  });

  it('negative amounts, zero and whole sats convert exactly', () => {
    expect(toMinorUnits(34000000.00000019, 8) - toMinorUnits(34000000, 8)).toBe(19);
    expect(toMinorUnits(-0.00000019, 8)).toBe(-19);
    expect(Object.is(toMinorUnits(-0, 8), 0)).toBe(true);
    expect(toMinorUnits(21000000, 8)).toBe(2100000000000000);
    expect(toMinorUnits(1234, 0)).toBe(1234);
  });
});

describe('round 9: report preparation and CSV keep the exact satoshi', () => {
  it('a balanced pair of 34000000.00000019 BTC is prepared unchanged', () => {
    const big = [
      line('big', 'btc', 34000000.00000019, {
        amountPrimary: 34000000.00000019,
        walletCurrency: 'BTC',
      }),
      line('big', 'equity', -34000000.00000019, {
        amountPrimary: -34000000.00000019,
        walletCurrency: 'BTC',
      }),
    ];
    const ready = prepareReportLines(big, 'BTC', null, 8).lines;
    expect(ready.map((l) => l.amountPrimary)).toEqual([34000000.00000019, -34000000.00000019]);
  });

  it('negative control: scaling by 1e8 before rounding gives 20 satoshis', () => {
    expect(Math.round(34000000.00000019 * 1e8) % 100).toBe(20);
  });

  it('rounds the written decimal half away from zero, small and exponent forms included', () => {
    expect(toMinorUnits(12.345, 2)).toBe(1235);
    expect(toMinorUnits(-12.345, 2)).toBe(-1235);
    expect(toMinorUnits(5e-7, 8)).toBe(50);
    expect(toMinorUnits(1.5e-8, 8)).toBe(2);
    expect(toMinorUnits(-1.5e-8, 8)).toBe(-2);
    expect(toMinorUnits(1e-9, 8)).toBe(0);
    expect(Object.is(toMinorUnits(-1e-9, 8), 0)).toBe(true);
    expect(toMinorUnits(0.1 + 0.2, 8)).toBe(30000000);
  });

  it('CSV cells keep the last satoshi in both BTC and sats display', () => {
    expect(formatNumericForCsvCell(34000000.00000019)).toBe('34000000.00000019');
    expect(transactionAmountNumericForCsv(34000000.00000019, 'BTC', 'sats') % 100).toBe(19);
  });
});

describe('round 10: exact entry totals and CSV of whole satoshis', () => {
  it('an exactly balanced entry stays balanced when its rounded lines are off by two', () => {
    const amts = [
      17000000.000000015, 17000000.000000015, 17000000.000000015, 17000000.000000015,
      -34000000.00000003, -34000000.00000003,
    ];
    const ls = amts.map((a, k) =>
      line('e', k < 4 ? 'btc' : 'equity', a, { amountPrimary: a, walletCurrency: 'BTC' }),
    );
    const units = prepareReportLines(ls, 'BTC', null, 8).lines.map((l) =>
      toMinorUnits(l.amountPrimary!, 8),
    );
    expect(units.reduce((s, u) => s + u, 0)).toBe(0);
  });

  it('negative control: floating remainders leave one satoshi outstanding', () => {
    const amts = [
      17000000.000000015, 17000000.000000015, 17000000.000000015, 17000000.000000015,
      -34000000.00000003, -34000000.00000003,
    ];
    const units = amts.map((a) => toMinorUnits(a, 8));
    const rest = amts.map((a, j) => (a - units[j] / 1e8) * 1e8);
    const leftover = Math.round(rest.reduce((s, r) => s + r, 0));
    expect(units.reduce((s, u) => s + u, 0) + leftover).not.toBe(0);
  });

  it('a single half line is prepared as one unit, not taken back to zero', () => {
    const one = (a: number) =>
      prepareReportLines(
        [line('h', 'cash', a, { amountPrimary: a, walletCurrency: 'BTC' })],
        'BTC',
        null,
        0,
      ).lines[0].amountPrimary;
    expect(one(0.5)).toBe(1);
    expect(one(-0.5)).toBe(-1);
  });

  it('a single half rounds once and is not taken back', () => {
    expect(roundGroupToMinorUnits([0.5], 0, () => 0)).toEqual([1]);
    expect(roundGroupToMinorUnits([-0.5], 0, () => 0)).toEqual([-1]);
    expect(roundGroupToMinorUnits([0.4, 0.4, 0.4], 0, () => 0).reduce((s, u) => s + u, 0)).toBe(1);
  });

  it('an entry with more lines than a call takes arguments still rounds', () => {
    const many = Array.from({ length: 200000 }, (_, k) => (k % 2 ? -0.123456789 : 0.123456789));
    const units = roundGroupToMinorUnits(many, 8, () => 0);
    expect(units.length).toBe(200000);
    expect(units.reduce((s, u) => s + u, 0)).toBe(0);
  });

  it('a CSV of a whole satoshi count is written exactly', () => {
    const sats = transactionAmountNumericForCsv(34000000.00000019, 'BTC', 'sats');
    expect(formatNumericForCsvCell(sats)).toBe('3400000000000019');
    expect(formatNumericForCsvCell(0.1 + 0.2)).toBe('0.3');
    expect(formatNumericForCsvCell(-0)).toBe('0');
    expect(formatNumericForCsvCell(-0.000000001)).toBe('0');
    expect(formatNumericForCsvCell(1e-7)).toBe('0.0000001');
    expect(formatNumericForCsvCell(-12.5)).toBe('-12.5');
  });
});

describe('wallet-mode General Ledger keeps each wallet in its own currency', () => {
  const walletLines = [
    line('w1', 'btc', 0.00000019, { walletCurrency: 'BTC' }),
    line('w2', 'btc', 0.1, { walletCurrency: 'BTC', date: '2026-03-02' }),
    line('w3', 'btc', 0.2, { walletCurrency: 'BTC', date: '2026-03-03' }),
    line('w4', 'cad', 10.005, { walletCurrency: 'CAD' }),
  ];
  const gl = (wallet: boolean) =>
    computeGeneralLedger(walletLines, accounts, undefined, undefined, wallet);
  const btcRows = (wallet: boolean) => gl(wallet).filter((e) => e.accountName === 'BTC Wallet');

  it('a Bitcoin wallet running balance keeps every satoshi', () => {
    expect(btcRows(true).map((e) => e.runningBalance)).toEqual([
      0.00000019, 0.10000019, 0.30000019,
    ]);
    expect(btcRows(true).map((e) => e.currency)).toEqual(['BTC', 'BTC', 'BTC']);
    expect(btcRows(true)[0].debit).toBe(0.00000019);
  });

  it('a fiat wallet rounds as before and is labelled with its own currency', () => {
    const cad = gl(true).find((e) => e.accountName === 'CAD Wallet')!;
    const before = gl(false).find((e) => e.accountName === 'CAD Wallet')!;
    expect(cad.runningBalance).toBe(before.runningBalance);
    expect(cad.debit).toBe(before.debit);
    expect(cad.currency).toBe('CAD');
  });

  it('negative control: outside wallet mode rows carry no currency and round to cents as before', () => {
    expect(btcRows(false).map((e) => e.runningBalance)).toEqual([0, 0.1, 0.3]);
    expect(btcRows(false).every((e) => e.currency === undefined)).toBe(true);
  });

  it('a CSV of a Bitcoin wallet row in sats keeps the satoshis', () => {
    const e = btcRows(true)[0];
    expect(transactionAmountNumericForCsv(e.runningBalance, e.currency!, 'sats')).toBe(19);
  });
});
