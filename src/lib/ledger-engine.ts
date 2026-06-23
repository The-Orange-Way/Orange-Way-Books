/**
 * Orange Way Books Ledger Engine — Pure Accounting Math
 *
 * Computes balances, KPIs, and report data entirely client-side.
 * All functions are pure: data in, results out, no side effects.
 *
 * Accounting convention:
 *   Assets & Expenses    → debit-normal  (balance = debits - credits)
 *   Liabilities, Equity, Revenue → credit-normal (balance = credits - debits)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface JournalLine {
  date: string;
  accountId: string | null;
  accountName: string | null;
  accountCode: string | null;
  debit: number;
  credit: number;
  description: string | null;
  journalEntryId: string;
  memo?: string | null;
  // Dual-currency fields — null for pre-dual rows (safe to ignore in all existing code)
  amountNative?: number | null;
  amountPrimary?: number | null;
  walletCurrency?: string | null;
  primaryCurrencyAtPosting?: string | null;
  ratePending?: boolean;
}

/**
 * Returns the primary-currency amount for a journal line.
 * Prefers amountPrimary when available; falls back to debit-credit for pre-dual rows.
 */
export function primaryAmount(line: JournalLine): number {
  if (line.amountPrimary != null) return line.amountPrimary;
  return line.debit - line.credit;
}

export interface AccountInfo {
  id: string;
  name: string;
  code: string | null;
  accountType: string; // Asset | Liability | Equity | Revenue | Expense
  accountGroup: string; // e.g. Cash, Receivable, Payable, Sales, COGS
  accountCategory: string | null;
  /** Optional chart parent (`chart_of_accounts.parent_id`). */
  parentAccountId?: string | null;
}

export interface AccountBalance {
  accountId: string;
  accountName: string;
  accountCode: string | null;
  accountType: string;
  accountGroup: string;
  accountCategory: string | null;
  totalDebits: number;
  totalCredits: number;
  balance: number; // normal-balance adjusted
}

export interface DateRange {
  from?: Date;
  to?: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isDebitNormal(accountType: string): boolean {
  const t = accountType.toLowerCase();
  return t === 'asset' || t === 'expense';
}

function normalBalance(debits: number, credits: number, accountType: string): number {
  return isDebitNormal(accountType) ? debits - credits : credits - debits;
}

export function journalLineInDateRange(dateStr: string, range?: DateRange): boolean {
  if (!range) return true;
  const d = new Date(dateStr);
  if (range.from && d < range.from) return false;
  if (range.to) {
    const to = new Date(range.to);
    to.setHours(23, 59, 59, 999);
    if (d > to) return false;
  }
  return true;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Core: Account Balances
// ---------------------------------------------------------------------------

/**
 * Groups journal lines by account, sums debits/credits, computes normal balance.
 * Optionally filters by date range.
 */
export function computeAccountBalances(
  lines: JournalLine[],
  accounts: AccountInfo[],
  dateRange?: DateRange,
): AccountBalance[] {
  const accountMap = new Map<string, AccountInfo>();
  for (const a of accounts) {
    accountMap.set(a.id, a);
  }

  const totals = new Map<string, { debits: number; credits: number }>();

  for (const line of lines) {
    if (!line.accountId) continue;
    if (!journalLineInDateRange(line.date, dateRange)) continue;

    // Aggregate in primary currency when dual-currency metadata is
    // present (amount_primary); fall back to signed debit-credit for
    // pre-dual rows. primaryAmount() encodes the sign — split it back
    // into debit/credit buckets so normalBalance() still works.
    const amt = primaryAmount(line);
    const debitPart = amt > 0 ? amt : 0;
    const creditPart = amt < 0 ? -amt : 0;

    const existing = totals.get(line.accountId);
    if (existing) {
      existing.debits += debitPart;
      existing.credits += creditPart;
    } else {
      totals.set(line.accountId, {
        debits: debitPart,
        credits: creditPart,
      });
    }
  }

  const results: AccountBalance[] = [];
  for (const [accountId, sums] of totals) {
    const info = accountMap.get(accountId);
    if (!info) continue;

    results.push({
      accountId,
      accountName: info.name,
      accountCode: info.code,
      accountType: info.accountType,
      accountGroup: info.accountGroup,
      accountCategory: info.accountCategory,
      totalDebits: round2(sums.debits),
      totalCredits: round2(sums.credits),
      balance: round2(normalBalance(sums.debits, sums.credits, info.accountType)),
    });
  }

  return results.sort((a, b) => (a.accountCode || '').localeCompare(b.accountCode || ''));
}

// ---------------------------------------------------------------------------
// Dashboard: KPIs
// ---------------------------------------------------------------------------

export interface KPIs {
  revenue: number;
  costOfSales: number;
  grossProfit: number;
  netProfit: number;
}

export function computeKPIs(balances: AccountBalance[]): KPIs {
  let revenue = 0;
  let costOfSales = 0;
  let totalExpenses = 0;

  for (const b of balances) {
    const t = b.accountType.toLowerCase();
    const g = b.accountGroup.toLowerCase();

    // Accept both 'revenue' and 'income' — QuickBooks-style charts of
    // accounts (including Orange Way Books' default seed) label top-level
    // revenue accounts as INCOME; some imports use REVENUE.
    if (t === 'revenue' || t === 'income') {
      revenue += b.balance;
    } else if (t === 'expense') {
      totalExpenses += b.balance;
      if (g === 'cost of goods sold' || g === 'cogs' || g === 'cost of sales') {
        costOfSales += b.balance;
      }
    }
  }

  const grossProfit = revenue - costOfSales;
  const netProfit = revenue - totalExpenses;

  return {
    revenue: round2(revenue),
    costOfSales: round2(costOfSales),
    grossProfit: round2(grossProfit),
    netProfit: round2(netProfit),
  };
}

// ---------------------------------------------------------------------------
// Dashboard: Working Capital
// ---------------------------------------------------------------------------

export interface WorkingCapital {
  cash: number;
  receivables: number;
  currentLiabilities: number;
  netWorkingCapital: number;
}

export function computeWorkingCapital(balances: AccountBalance[]): WorkingCapital {
  let cash = 0;
  let receivables = 0;
  let currentLiabilities = 0;

  for (const b of balances) {
    const t = b.accountType.toLowerCase();
    const g = b.accountGroup.toLowerCase();

    if (t === 'asset') {
      if (g.includes('cash') || g.includes('bank')) {
        cash += b.balance;
      } else if (g.includes('receivable')) {
        receivables += b.balance;
      }
    } else if (t === 'liability') {
      if (
        g.includes('current') ||
        g.includes('payable') ||
        g.includes('short-term') ||
        g.includes('credit card')
      ) {
        currentLiabilities += b.balance;
      }
    }
  }

  return {
    cash: round2(cash),
    receivables: round2(receivables),
    currentLiabilities: round2(currentLiabilities),
    netWorkingCapital: round2(cash + receivables - currentLiabilities),
  };
}

// ---------------------------------------------------------------------------
// Dashboard: Account Balances
// ---------------------------------------------------------------------------

export interface WalletBalance {
  walletId: string;
  name: string;
  asset: string;
  walletType: string | null;
  initialBalance: number;
  txTotal: number;
  /** Native (wallet-currency) balance — same as currentBalance for backward compat. */
  currentBalance: number;
  /** Alias for currentBalance — keeps all existing callers working. */
  balanceNative: number;
  /** Primary-currency equivalent balance (sum of amountPrimary for this wallet's JE lines). Null when no dual-amount data yet. */
  balancePrimary: number | null;
}

export interface WalletAccountMap {
  walletId: string;
  externalAccountId: string | null;
}

export function computeWalletBalances(
  wallets: Array<{
    id: string;
    encrypted_name: string;
    asset: string;
    account_type: string | null;
    initial_balance: number | null;
    external_account_id?: string | null;
  }>,
  transactions: Array<{ account_id: string | null; amount: number }>,
  journalLines?: JournalLine[],
  walletAccountMap?: WalletAccountMap[],
): WalletBalance[] {
  // Transaction-based native balance (legacy path, still load-bearing)
  const txByWallet = new Map<string, number>();
  for (const tx of transactions) {
    if (!tx.account_id) continue;
    txByWallet.set(tx.account_id, (txByWallet.get(tx.account_id) || 0) + Number(tx.amount));
  }

  // Build external_account_id → account_id map for JE-line primary balance
  const accountToWallet = new Map<string, string>();
  if (walletAccountMap) {
    for (const m of walletAccountMap) {
      if (m.externalAccountId) accountToWallet.set(m.externalAccountId, m.walletId);
    }
  } else {
    // Fallback: use external_account_id directly on the wallet row
    for (const w of wallets) {
      if (w.external_account_id) accountToWallet.set(w.external_account_id, w.id);
    }
  }

  // Sum amountPrimary per wallet from JE lines
  const primaryByWallet = new Map<string, number>();
  if (journalLines) {
    for (const line of journalLines) {
      if (!line.accountId || line.amountPrimary == null || line.ratePending) continue;
      const wId = accountToWallet.get(line.accountId);
      if (!wId) continue;
      primaryByWallet.set(wId, (primaryByWallet.get(wId) || 0) + line.amountPrimary);
    }
  }

  return wallets.map((w) => {
    const initial = Number(w.initial_balance) | 0;
    const txTotal = round2(txByWallet.get(w.id) || 0);
    const nativeBalance = round2(initial + txTotal);
    const hasPrimary = primaryByWallet.has(w.id);
    return {
      walletId: w.id,
      name: w.encrypted_name || '[Encrypted]',
      asset: w.asset,
      walletType: w.account_type,
      initialBalance: initial,
      txTotal,
      currentBalance: nativeBalance,
      balanceNative: nativeBalance,
      balancePrimary: hasPrimary ? round2(primaryByWallet.get(w.id)!) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Reports: Profit & Loss
// ---------------------------------------------------------------------------

/** One posted account line on a statement (client-side ledger). */
export interface ReportDataRow {
  accountId: string;
  name: string;
  code: string | null;
  balance: number;
}

export interface ReportSection {
  header: string;
  rows: ReportDataRow[];
  total: number;
}

export interface PnLReport {
  income: ReportSection;
  expenses: ReportSection;
  netProfit: number;
}

export function computePnL(balances: AccountBalance[]): PnLReport {
  const incomeRows: ReportDataRow[] = [];
  const expenseRows: ReportDataRow[] = [];

  for (const b of balances) {
    const t = b.accountType.toLowerCase();
    if (t === 'revenue') {
      incomeRows.push({
        accountId: b.accountId,
        name: b.accountName,
        code: b.accountCode,
        balance: b.balance,
      });
    } else if (t === 'expense') {
      expenseRows.push({
        accountId: b.accountId,
        name: b.accountName,
        code: b.accountCode,
        balance: b.balance,
      });
    }
  }

  const totalIncome = round2(incomeRows.reduce((s, r) => s + r.balance, 0));
  const totalExpenses = round2(expenseRows.reduce((s, r) => s + r.balance, 0));

  return {
    income: { header: 'Income', rows: incomeRows, total: totalIncome },
    expenses: { header: 'Expenses', rows: expenseRows, total: totalExpenses },
    netProfit: round2(totalIncome - totalExpenses),
  };
}

// ---------------------------------------------------------------------------
// Reports: Balance Sheet
// ---------------------------------------------------------------------------

export interface BalanceSheetReport {
  assets: ReportSection;
  liabilities: ReportSection;
  equity: ReportSection;
  totalLiabilitiesAndEquity: number;
}

export function computeBalanceSheet(balances: AccountBalance[]): BalanceSheetReport {
  const assetRows: ReportDataRow[] = [];
  const liabilityRows: ReportDataRow[] = [];
  const equityRows: ReportDataRow[] = [];

  for (const b of balances) {
    const t = b.accountType.toLowerCase();
    const row: ReportDataRow = {
      accountId: b.accountId,
      name: b.accountName,
      code: b.accountCode,
      balance: b.balance,
    };
    if (t === 'asset') assetRows.push(row);
    else if (t === 'liability') liabilityRows.push(row);
    else if (t === 'equity') equityRows.push(row);
  }

  const totalAssets = round2(assetRows.reduce((s, r) => s + r.balance, 0));
  const totalLiabilities = round2(liabilityRows.reduce((s, r) => s + r.balance, 0));
  const totalEquity = round2(equityRows.reduce((s, r) => s + r.balance, 0));

  return {
    assets: { header: 'Assets', rows: assetRows, total: totalAssets },
    liabilities: { header: 'Liabilities', rows: liabilityRows, total: totalLiabilities },
    equity: { header: 'Equity', rows: equityRows, total: totalEquity },
    totalLiabilitiesAndEquity: round2(totalLiabilities + totalEquity),
  };
}

// ---------------------------------------------------------------------------
// Reports: Trial Balance
// ---------------------------------------------------------------------------

export interface TrialBalanceRow {
  accountName: string;
  accountCode: string | null;
  debit: number;
  credit: number;
}

export interface TrialBalanceReport {
  rows: TrialBalanceRow[];
  totalDebits: number;
  totalCredits: number;
  isBalanced: boolean;
}

export function computeTrialBalance(balances: AccountBalance[]): TrialBalanceReport {
  const rows: TrialBalanceRow[] = balances.map((b) => {
    // Show balance in debit or credit column based on normal side
    if (isDebitNormal(b.accountType)) {
      const net = b.totalDebits - b.totalCredits;
      return {
        accountName: b.accountName,
        accountCode: b.accountCode,
        debit: net >= 0 ? round2(net) : 0,
        credit: net < 0 ? round2(Math.abs(net)) : 0,
      };
    } else {
      const net = b.totalCredits - b.totalDebits;
      return {
        accountName: b.accountName,
        accountCode: b.accountCode,
        debit: net < 0 ? round2(Math.abs(net)) : 0,
        credit: net >= 0 ? round2(net) : 0,
      };
    }
  });

  const totalDebits = round2(rows.reduce((s, r) => s + r.debit, 0));
  const totalCredits = round2(rows.reduce((s, r) => s + r.credit, 0));

  return {
    rows,
    totalDebits,
    totalCredits,
    isBalanced: Math.abs(totalDebits - totalCredits) < 0.01,
  };
}

// ---------------------------------------------------------------------------
// Reports: General Ledger
// ---------------------------------------------------------------------------

export interface GLEntry {
  date: string;
  accountName: string;
  accountCode: string | null;
  description: string | null;
  debit: number;
  credit: number;
  runningBalance: number;
  journalEntryId: string;
}

export function computeGeneralLedger(
  lines: JournalLine[],
  accounts: AccountInfo[],
  dateRange?: DateRange,
): GLEntry[] {
  const accountMap = new Map<string, AccountInfo>();
  for (const a of accounts) accountMap.set(a.id, a);

  // Filter and sort chronologically
  const filtered = lines
    .filter((l) => l.accountId && journalLineInDateRange(l.date, dateRange))
    .sort(
      (a, b) => a.date.localeCompare(b.date) || a.journalEntryId.localeCompare(b.journalEntryId),
    );

  // Running balance per account
  const runningBalances = new Map<string, number>();
  const entries: GLEntry[] = [];

  for (const line of filtered) {
    const info = accountMap.get(line.accountId!);
    if (!info) continue;

    const current = runningBalances.get(line.accountId!) || 0;
    const delta = isDebitNormal(info.accountType)
      ? (Number(line.debit) | 0) - (Number(line.credit) | 0)
      : (Number(line.credit) | 0) - (Number(line.debit) | 0);
    const newBalance = round2(current + delta);
    runningBalances.set(line.accountId!, newBalance);

    entries.push({
      date: line.date,
      accountName: info.name,
      accountCode: info.code,
      description: line.description,
      debit: Number(line.debit) | 0,
      credit: Number(line.credit) | 0,
      runningBalance: newBalance,
      journalEntryId: line.journalEntryId,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Reports: Cash Flow (simplified indirect method)
// ---------------------------------------------------------------------------

export type CashFlowBucket = 'operating' | 'investing' | 'financing';

/**
 * Same rules as {@link computeCashFlow} section assignment (used for hierarchy + UI).
 * Returns null when the account does not appear on the simplified cash flow statement.
 */
export function classifyAccountForCashFlow(b: AccountBalance): CashFlowBucket | null {
  const t = b.accountType.toLowerCase();
  const g = b.accountGroup.toLowerCase();

  if (t === 'revenue' || t === 'expense') {
    return 'operating';
  }
  if (t === 'asset') {
    if (g.includes('fixed') || g.includes('investment') || g.includes('long-term')) {
      return 'investing';
    }
    if (!g.includes('cash') && !g.includes('bank')) {
      return 'operating';
    }
    return null;
  }
  if (t === 'liability') {
    if (g.includes('long-term') || g.includes('loan') || g.includes('mortgage')) {
      return 'financing';
    }
    return 'operating';
  }
  if (t === 'equity') {
    return 'financing';
  }
  return null;
}

export interface CashFlowReport {
  operating: ReportSection;
  investing: ReportSection;
  financing: ReportSection;
  netChange: number;
}

export function computeCashFlow(balances: AccountBalance[]): CashFlowReport {
  const operating: ReportDataRow[] = [];
  const investing: ReportDataRow[] = [];
  const financing: ReportDataRow[] = [];

  for (const b of balances) {
    const bucket = classifyAccountForCashFlow(b);
    if (!bucket) {
      continue;
    }

    const t = b.accountType.toLowerCase();
    const g = b.accountGroup.toLowerCase();
    const base: ReportDataRow = {
      accountId: b.accountId,
      name: b.accountName,
      code: b.accountCode,
      balance: b.balance,
    };

    if (bucket === 'operating') {
      if (t === 'asset' && !g.includes('cash') && !g.includes('bank')) {
        operating.push({ ...base, balance: -base.balance });
      } else {
        operating.push(base);
      }
    } else if (bucket === 'investing') {
      investing.push({ ...base, balance: -base.balance });
    } else {
      financing.push(base);
    }
  }

  const opTotal = round2(operating.reduce((s, r) => s + r.balance, 0));
  const invTotal = round2(investing.reduce((s, r) => s + r.balance, 0));
  const finTotal = round2(financing.reduce((s, r) => s + r.balance, 0));

  return {
    operating: { header: 'Operating Activities', rows: operating, total: opTotal },
    investing: { header: 'Investing Activities', rows: investing, total: invTotal },
    financing: { header: 'Financing Activities', rows: financing, total: finTotal },
    netChange: round2(opTotal + invTotal + finTotal),
  };
}
