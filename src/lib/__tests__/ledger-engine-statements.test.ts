// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  type AccountInfo,
  type JournalLine,
  NET_INCOME_ROW_ID,
  balanceSheetRange,
  classifyAccountForCashFlow,
  computeAccountBalances,
  computeBalanceSheet,
  computePnL,
  computeTrialBalance,
} from '../ledger-engine';
import {
  type CoaClosureRow,
  bsSectionPredicate,
  buildReportHierarchyRoots,
  plSectionPredicate,
} from '../reports/report-hierarchy';

// Account types exactly as the default chart seeds them (init-chart-of-accounts.ts).
const accounts: AccountInfo[] = [
  {
    id: 'wallet',
    name: 'Operating Wallet',
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
  {
    id: 'sales',
    name: 'Sales Revenue',
    code: '4100',
    accountType: 'INCOME',
    accountGroup: 'Revenue',
    accountCategory: null,
  },
  {
    id: 'rent',
    name: 'Rent Expense',
    code: '5300',
    accountType: 'EXPENSE',
    accountGroup: 'Expenses',
    accountCategory: null,
  },
];

const line = (
  je: string,
  accountId: string,
  debit: number,
  credit: number,
  date = '2026-03-01',
): JournalLine => ({
  date,
  accountId,
  accountName: null,
  accountCode: null,
  debit,
  credit,
  description: null,
  journalEntryId: je,
});

// Opening balance 100, a sale of 50, rent of 20.
const lines: JournalLine[] = [
  line('open', 'wallet', 100, 0),
  line('open', 'equity', 0, 100),
  line('sale', 'wallet', 50, 0),
  line('sale', 'sales', 0, 50),
  line('rent', 'rent', 20, 0),
  line('rent', 'wallet', 0, 20),
];
const balances = computeAccountBalances(lines, accounts);

describe('statements on the default chart', () => {
  it('trial balance control: 150 = 150', () => {
    const tb = computeTrialBalance(balances);
    expect([tb.totalDebits, tb.totalCredits, tb.isBalanced]).toEqual([150, 150, true]);
  });

  it('P&L counts INCOME accounts: income 50, expenses 20, net 30', () => {
    const pnl = computePnL(balances);
    expect(pnl.income.rows.map((r) => r.accountId)).toEqual(['sales']);
    expect([pnl.income.total, pnl.expenses.total, pnl.netProfit]).toEqual([50, 20, 30]);
  });

  it('Balance Sheet carries Net Income in equity and balances', () => {
    const bs = computeBalanceSheet(balances);
    expect(bs.assets.total).toBe(130);
    expect(bs.equity.rows.find((r) => r.accountId === NET_INCOME_ROW_ID)?.balance).toBe(30);
    expect(bs.equity.total).toBe(130);
    expect(bs.totalLiabilitiesAndEquity).toBe(bs.assets.total);
  });

  it('adds no Net Income row when there is no income or expense', () => {
    const bs = computeBalanceSheet(computeAccountBalances(lines.slice(0, 2), accounts));
    expect(bs.equity.rows.map((r) => r.accountId)).toEqual(['equity']);
  });

  it('the grouped P&L view and the cash flow treat INCOME as income', () => {
    const sales = { accountType: 'INCOME' } as Parameters<ReturnType<typeof plSectionPredicate>>[0];
    expect(plSectionPredicate('revenue')(sales)).toBe(true);
    expect(plSectionPredicate('expense')(sales)).toBe(false);
    expect(classifyAccountForCashFlow(balances.find((b) => b.accountId === 'sales')!)).toBe(
      'operating',
    );
  });

  it('negative control: the old P&L and Balance Sheet rules give the wrong numbers', () => {
    const oldIncome = balances.filter((b) => b.accountType.toLowerCase() === 'revenue');
    expect(oldIncome).toHaveLength(0); // "No income accounts", net profit -20
    const oldEquity = balances
      .filter((b) => b.accountType.toLowerCase() === 'equity')
      .reduce((s, b) => s + b.balance, 0);
    expect(oldEquity).toBe(100); // 130 assets against 100
  });

  it('the grouped section view shows the earnings line exactly once', () => {
    const bs = computeBalanceSheet(balances);
    const closure = new Map<string, CoaClosureRow>(
      accounts.map((a) => [
        a.id,
        { id: a.id, parentId: null, name: a.name, code: a.code, accountType: a.accountType },
      ]),
    );
    const roots = buildReportHierarchyRoots(
      bs.equity.rows.map((r) => ({
        accountId: r.accountId,
        accountName: r.name,
        accountCode: r.code,
        primaryAmount: r.balance,
        nativeAmount: r.balance,
        nativeCurrency: 'USD',
      })),
      closure,
      bsSectionPredicate('equity'),
      'USD',
    );
    expect(roots.filter((n) => n.accountId === NET_INCOME_ROW_ID)).toHaveLength(1);
    expect(roots.reduce((s, n) => s + n.rollupPrimaryAmount, 0)).toBe(bs.equity.total);
  });
});

describe('Balance Sheet is a position at the end date', () => {
  // Opening 100 in 2025, profit 50 in 2025, profit 10 in 2026. Report range is 2026.
  const history: JournalLine[] = [
    line('open', 'wallet', 100, 0, '2025-01-02'),
    line('open', 'equity', 0, 100, '2025-01-02'),
    line('s25', 'wallet', 50, 0, '2025-06-01'),
    line('s25', 'sales', 0, 50, '2025-06-01'),
    line('s26', 'wallet', 10, 0, '2026-06-01'),
    line('s26', 'sales', 0, 10, '2026-06-01'),
  ];
  const range = { from: new Date('2026-01-01'), to: new Date('2026-12-31') };

  it('includes opening balances and earlier earnings: 160 = 160, earnings 60', () => {
    const bs = computeBalanceSheet(
      computeAccountBalances(history, accounts, balanceSheetRange(range)),
    );
    expect(bs.assets.total).toBe(160);
    expect(bs.equity.rows.find((r) => r.accountId === NET_INCOME_ROW_ID)?.balance).toBe(60);
    expect(bs.totalLiabilitiesAndEquity).toBe(160);
  });

  it('leaves out entries after the end date', () => {
    const bs = computeBalanceSheet(
      computeAccountBalances(history, accounts, balanceSheetRange({ to: new Date('2025-12-31') })),
    );
    expect(bs.assets.total).toBe(150);
  });

  it('negative control: the period range shows only movements, 10 = 10', () => {
    const bs = computeBalanceSheet(computeAccountBalances(history, accounts, range));
    expect(bs.assets.total).toBe(10);
  });

  it('a loss gives a negative earnings line and still balances', () => {
    const loss = [...history.slice(0, 2), line('r', 'rent', 30, 0), line('r', 'wallet', 0, 30)];
    const bs = computeBalanceSheet(
      computeAccountBalances(loss, accounts, balanceSheetRange(range)),
    );
    expect(bs.equity.rows.find((r) => r.accountId === NET_INCOME_ROW_ID)?.balance).toBe(-30);
    expect(bs.totalLiabilitiesAndEquity).toBe(bs.assets.total);
    expect(bs.assets.total).toBe(70);
  });

  it('after a closing entry the earnings sit in equity and no earnings line is added', () => {
    const closed = [...history, line('close', 'sales', 60, 0), line('close', 'equity', 0, 60)];
    const bs = computeBalanceSheet(
      computeAccountBalances(closed, accounts, balanceSheetRange(range)),
    );
    expect(bs.equity.rows.map((r) => r.accountId)).toEqual(['equity']);
    expect([bs.equity.total, bs.assets.total]).toEqual([160, 160]);
  });
});
