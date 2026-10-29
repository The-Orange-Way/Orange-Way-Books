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

import { roundGroupToMinorUnits, toMinorUnits } from './minor-units';

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
  /** The currency of the line's journal entry; the only currency an old imported line carries. */
  entryCurrency?: string | null;
  /** The entry this line's entry reverses or voids, if any. */
  reversalOfId?: string | null;
  /** The posting currency is stored but could not be read, so the line cannot be valued safely. */
  postingCurrencyUnreadable?: boolean;
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

/**
 * True for income accounts. The default chart seeds them as INCOME and some
 * imports use REVENUE, so both count.
 */
export function isIncomeType(accountType: string): boolean {
  const t = accountType.toLowerCase();
  return t === 'revenue' || t === 'income';
}

function isDebitNormal(accountType: string): boolean {
  const t = accountType.toLowerCase();
  return t === 'asset' || t === 'expense';
}

function normalBalance(debits: number, credits: number, accountType: string): number {
  return isDebitNormal(accountType) ? debits - credits : credits - debits;
}

/**
 * The range a Balance Sheet is computed over: everything up to the end date. A Balance Sheet is a
 * position at a date, so it must include opening balances and earlier periods, not only movements
 * inside the selected range.
 */
export function balanceSheetRange(range?: DateRange): DateRange | undefined {
  return range?.to ? { to: range.to } : undefined;
}

/** Local calendar day of `d` as yyyy-MM-dd. */
function localDay(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Whether an entry dated `dateStr` (yyyy-MM-dd) falls in `range`, both ends inclusive. Compares
 * calendar days: parsing a date-only string gives UTC midnight, which west of UTC is the day before.
 */
export function journalLineInDateRange(dateStr: string, range?: DateRange): boolean {
  if (!range) return true;
  const day = dateStr.slice(0, 10);
  if (range.from && day < localDay(range.from)) return false;
  if (range.to && day > localDay(range.to)) return false;
  return true;
}

export { toMinorUnits };

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Rounding for a report. With no `decimals` (every caller except a Bitcoin report) it is the
 * original two-place rounding. With `decimals`, amounts keep that many places.
 */
function roundTo(decimals?: number): (n: number) => number {
  if (decimals == null) return round2;
  const f = 10 ** decimals;
  return (n) => toMinorUnits(n, decimals) / f;
}

/**
 * Turns a total into the amount shown. With no `decimals` it is two-place rounding. With `decimals`
 * the total is a whole number of minor units (satoshis for BTC), so it is only scaled back.
 */
function fromUnits(decimals?: number): (n: number) => number {
  if (decimals == null) return round2;
  const f = 10 ** decimals;
  return (n) => n / f;
}

/**
 * Sums behind each AccountBalance a Bitcoin report computes, in whole minor units. Totals add these
 * integers and scale once, so neither per-account rounding nor floating point can unbalance them.
 */
const rawSums = new WeakMap<AccountBalance, { debits: number; credits: number; balance: number }>();

/** The value to add into a total: minor units for a Bitcoin report, the row balance otherwise. */
function addable(b: AccountBalance, decimals?: number): number {
  if (decimals == null) return b.balance;
  return rawSums.get(b)?.balance ?? toMinorUnits(b.balance, decimals);
}

/** True for a Bitcoin unit. Reports in these units keep their full precision. */
export function isBitcoinCurrency(currency: string | null | undefined): boolean {
  const c = (currency ?? '').toUpperCase();
  return c === 'BTC' || c === 'SATS' || c === 'SAT';
}

/**
 * a - b for a comparison column. In a Bitcoin unit the difference is taken in whole minor units so a
 * satoshi is never lost; every other currency subtracts as before.
 */
export function reportDifference(a: number, b: number, currency: string): number {
  if (!isBitcoinCurrency(currency)) return a - b;
  const d = currencyDecimals(currency);
  return (toMinorUnits(a, d) - toMinorUnits(b, d)) / 10 ** d;
}

/** Decimal places a report in `currency` is kept to: 8 for BTC, 0 for sats, else the ISO minor unit. */
export function currencyDecimals(currency: string): number {
  const c = currency.toUpperCase();
  if (c === 'BTC') return 8;
  if (c === 'SATS' || c === 'SAT') return 0;
  try {
    return (
      new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).resolvedOptions()
        .maximumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * Why a line cannot be added to primary-currency totals, or null when it can.
 * - 'awaiting-rate': its amount is in another currency and has no primary amount yet.
 * - 'other-primary': it was posted when the company had a different primary currency.
 * - 'unknown-currency': it carries neither a primary amount nor its own currency, so the unit of
 *   its debit and credit cannot be known.
 */
export type LineExclusionReason = 'awaiting-rate' | 'other-primary' | 'unknown-currency';

export function lineExclusionReason(
  line: JournalLine,
  primaryCurrency: string,
): LineExclusionReason | null {
  const primary = primaryCurrency.toUpperCase();
  if (line.ratePending) return 'awaiting-rate';
  if (line.postingCurrencyUnreadable) return 'unknown-currency';
  if (line.primaryCurrencyAtPosting && line.primaryCurrencyAtPosting.toUpperCase() !== primary) {
    return 'other-primary';
  }
  if (line.amountPrimary != null) return null;
  const currency = line.walletCurrency || line.entryCurrency;
  if (!currency) return 'unknown-currency';
  return currency.toUpperCase() === primary ? null : 'awaiting-rate';
}

/** An entry left out of a report, with its date so a report can count only those in its period. */
export interface ExcludedEntry {
  journalEntryId: string;
  date: string;
  reason: LineExclusionReason;
}

/**
 * Lines ready for a primary or secondary currency report in a Bitcoin company. Whole entries with a
 * line that cannot be valued are left out, so totals still balance, and listed in `excluded`. An
 * entry that reverses a left-out entry is left out with it (and the other way round), so a reversal
 * never shows on its own.
 * Every kept line is rewritten so its debit and credit are its primary amount, times `rate` when a
 * secondary display rate is given. The General Ledger and the drill-down rows read debit and
 * credit, so they then show the same amounts as the balances.
 * With `decimals`, each kept amount is rounded to the smallest unit shown, and any unit lost to
 * rounding inside an entry is given back to the line that lost the most, so every entry still
 * balances and every row, subtotal and total adds up exactly to what is displayed.
 */
export function prepareReportLines(
  lines: JournalLine[],
  primaryCurrency: string,
  rate: number | null,
  decimals?: number,
): { lines: JournalLine[]; excluded: ExcludedEntry[] } {
  const excluded = new Map<string, ExcludedEntry>();
  for (const l of lines) {
    const reason = lineExclusionReason(l, primaryCurrency);
    if (reason && !excluded.has(l.journalEntryId)) {
      excluded.set(l.journalEntryId, { journalEntryId: l.journalEntryId, date: l.date, reason });
    }
  }
  // A reversal and the entry it reverses stay or go together.
  const pairs: [string, string, string][] = [];
  for (const l of lines) {
    if (l.reversalOfId) pairs.push([l.journalEntryId, l.reversalOfId, l.date]);
  }
  const dateOf = new Map(lines.map((l) => [l.journalEntryId, l.date]));
  for (let changed = true; changed; ) {
    changed = false;
    for (const [rev, orig, revDate] of pairs) {
      const gone = excluded.get(rev) ?? excluded.get(orig);
      if (!gone) continue;
      if (!excluded.has(rev)) {
        excluded.set(rev, { journalEntryId: rev, date: revDate, reason: gone.reason });
        changed = true;
      }
      if (!excluded.has(orig) && dateOf.has(orig)) {
        excluded.set(orig, { journalEntryId: orig, date: dateOf.get(orig)!, reason: gone.reason });
        changed = true;
      }
    }
  }
  const k = rate ?? 1;
  const kept = lines.filter((l) => !excluded.has(l.journalEntryId));
  const amounts = kept.map((l) => primaryAmount(l) * k);
  if (decimals != null) roundWithinEntries(kept, amounts, decimals);
  return {
    lines: kept.map((l, i) => {
      const amt = amounts[i];
      return { ...l, debit: amt > 0 ? amt : 0, credit: amt < 0 ? -amt : 0, amountPrimary: amt };
    }),
    excluded: [...excluded.values()],
  };
}

/**
 * Rounds `amounts` in place to `decimals`, entry by entry. Within an entry the rounded amounts are
 * made to sum to the rounded sum of the exact amounts, by moving the leftover units to the lines
 * whose rounding moved them furthest.
 */
function roundWithinEntries(lines: JournalLine[], amounts: number[], decimals: number): void {
  const f = 10 ** decimals;
  const byEntry = new Map<string, number[]>();
  lines.forEach((l, i) => {
    const idx = byEntry.get(l.journalEntryId);
    if (idx) idx.push(i);
    else byEntry.set(l.journalEntryId, [i]);
  });
  for (const idx of byEntry.values()) {
    // Exact decimal arithmetic, so a balanced entry stays balanced however large its amounts.
    // Ties go by account, then by size, never by input order, so a reversal written in another
    // order rounds as a mirror image.
    const key = (j: number) => lines[idx[j]].accountId ?? '';
    const units = roundGroupToMinorUnits(
      idx.map((i) => amounts[i]),
      decimals,
      (a, b) =>
        key(a).localeCompare(key(b)) || Math.abs(amounts[idx[b]]) - Math.abs(amounts[idx[a]]),
    );
    idx.forEach((i, j) => {
      amounts[i] = units[j] / f;
    });
  }
}

/** The excluded entries that fall inside `range`. */
export function excludedInRange(excluded: ExcludedEntry[], range?: DateRange): ExcludedEntry[] {
  return excluded.filter((e) => journalLineInDateRange(e.date, range));
}

/** How many excluded entries fall inside `range`. */
export function countExcludedInRange(excluded: ExcludedEntry[], range?: DateRange): number {
  return excludedInRange(excluded, range).length;
}

// ---------------------------------------------------------------------------
// Core: Account Balances
// ---------------------------------------------------------------------------

/**
 * Groups journal lines by account, sums debits/credits, computes normal balance.
 * Optionally filters by date range.
 * With `decimals` (a Bitcoin report), each line is added in whole minor units, so pass lines
 * already rounded entry by entry by prepareReportLines with the same `decimals`.
 */
export function computeAccountBalances(
  lines: JournalLine[],
  accounts: AccountInfo[],
  dateRange?: DateRange,
  decimals?: number,
): AccountBalance[] {
  const rnd = roundTo(decimals);
  const unit = 10 ** (decimals ?? 0);
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
    // A Bitcoin report adds whole minor units, so a long book cannot drift by a satoshi.
    const amt =
      decimals == null ? primaryAmount(line) : toMinorUnits(primaryAmount(line), decimals);
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
  for (const [accountId, added] of totals) {
    const info = accountMap.get(accountId);
    if (!info) continue;
    const sums =
      decimals == null ? added : { debits: added.debits / unit, credits: added.credits / unit };

    // A Bitcoin report takes the balance from the whole-unit sums too, so the row matches the totals.
    const balance =
      decimals == null
        ? normalBalance(sums.debits, sums.credits, info.accountType)
        : normalBalance(added.debits, added.credits, info.accountType) / unit;
    const row: AccountBalance = {
      accountId,
      accountName: info.name,
      accountCode: info.code,
      accountType: info.accountType,
      accountGroup: info.accountGroup,
      accountCategory: info.accountCategory,
      totalDebits: rnd(sums.debits),
      totalCredits: rnd(sums.credits),
      balance: rnd(balance),
    };
    if (decimals != null)
      rawSums.set(row, {
        debits: added.debits,
        credits: added.credits,
        balance: normalBalance(added.debits, added.credits, info.accountType),
      });
    results.push(row);
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
    if (isIncomeType(t)) {
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
    const initial = Number(w.initial_balance) || 0;
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

export function computePnL(balances: AccountBalance[], decimals?: number): PnLReport {
  const fin = fromUnits(decimals);
  const incomeRows: ReportDataRow[] = [];
  const expenseRows: ReportDataRow[] = [];
  let income = 0;
  let expenses = 0;

  for (const b of balances) {
    const t = b.accountType.toLowerCase();
    if (isIncomeType(t)) income += addable(b, decimals);
    else if (t === 'expense') expenses += addable(b, decimals);
    if (isIncomeType(t)) {
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

  const totalIncome = fin(income);
  const totalExpenses = fin(expenses);

  return {
    income: { header: 'Income', rows: incomeRows, total: totalIncome },
    expenses: { header: 'Expenses', rows: expenseRows, total: totalExpenses },
    netProfit: fin(decimals == null ? totalIncome - totalExpenses : income - expenses),
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

/** Row id of the earnings line the Balance Sheet adds to equity: all income less expenses not yet closed to an equity account. Not a chart account. */
export const NET_INCOME_ROW_ID = 'net-income';

export function computeBalanceSheet(
  balances: AccountBalance[],
  decimals?: number,
): BalanceSheetReport {
  const fin = fromUnits(decimals);
  const assetRows: ReportDataRow[] = [];
  const liabilityRows: ReportDataRow[] = [];
  const equityRows: ReportDataRow[] = [];
  // Income and expense not yet closed to equity belong in equity, or the sheet cannot balance.
  let netIncome = 0;
  const sums = { asset: 0, liability: 0, equity: 0 };

  for (const b of balances) {
    const t = b.accountType.toLowerCase();
    const row: ReportDataRow = {
      accountId: b.accountId,
      name: b.accountName,
      code: b.accountCode,
      balance: b.balance,
    };
    const v = addable(b, decimals);
    if (t === 'asset') assetRows.push(row);
    else if (t === 'liability') liabilityRows.push(row);
    else if (t === 'equity') equityRows.push(row);
    else if (isIncomeType(t)) netIncome += v;
    else if (t === 'expense') netIncome -= v;
    if (t === 'asset' || t === 'liability' || t === 'equity') sums[t] += v;
  }
  sums.equity += netIncome;
  if (fin(netIncome) !== 0) {
    equityRows.push({
      accountId: NET_INCOME_ROW_ID,
      name: 'Earnings to Date',
      code: null,
      balance: fin(netIncome),
    });
  }

  const totalAssets = fin(
    decimals == null ? assetRows.reduce((s, r) => s + r.balance, 0) : sums.asset,
  );
  const totalLiabilities = fin(
    decimals == null ? liabilityRows.reduce((s, r) => s + r.balance, 0) : sums.liability,
  );
  const totalEquity = fin(
    decimals == null ? equityRows.reduce((s, r) => s + r.balance, 0) : sums.equity,
  );

  return {
    assets: { header: 'Assets', rows: assetRows, total: totalAssets },
    liabilities: { header: 'Liabilities', rows: liabilityRows, total: totalLiabilities },
    equity: { header: 'Equity', rows: equityRows, total: totalEquity },
    totalLiabilitiesAndEquity: fin(
      decimals == null ? totalLiabilities + totalEquity : sums.liability + sums.equity,
    ),
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

export function computeTrialBalance(
  balances: AccountBalance[],
  decimals?: number,
): TrialBalanceReport {
  const rnd = fromUnits(decimals);
  const unit = 10 ** (decimals ?? 0);
  let rawDebits = 0;
  let rawCredits = 0;
  const rows: TrialBalanceRow[] = balances.map((b) => {
    const raw = decimals == null ? undefined : rawSums.get(b);
    const asUnits = (n: number) => (decimals == null ? n : toMinorUnits(n, decimals));
    const d = raw ? raw.debits : asUnits(b.totalDebits);
    const c = raw ? raw.credits : asUnits(b.totalCredits);
    if (d - c >= 0) rawDebits += d - c;
    else rawCredits += c - d;
    // Show balance in debit or credit column based on normal side
    if (isDebitNormal(b.accountType)) {
      const net = d - c;
      return {
        accountName: b.accountName,
        accountCode: b.accountCode,
        debit: net >= 0 ? rnd(net) : 0,
        credit: net < 0 ? rnd(Math.abs(net)) : 0,
      };
    } else {
      const net = c - d;
      return {
        accountName: b.accountName,
        accountCode: b.accountCode,
        debit: net < 0 ? rnd(Math.abs(net)) : 0,
        credit: net >= 0 ? rnd(net) : 0,
      };
    }
  });

  if (decimals == null) {
    const totalDebits = round2(rows.reduce((s, r) => s + r.debit, 0));
    const totalCredits = round2(rows.reduce((s, r) => s + r.credit, 0));
    return {
      rows,
      totalDebits,
      totalCredits,
      isBalanced: Math.abs(totalDebits - totalCredits) < 0.01,
    };
  }
  // Totals from the sums in whole minor units (satoshis for BTC), so they compare exactly.
  return {
    rows,
    totalDebits: rnd(rawDebits),
    totalCredits: rnd(rawCredits),
    isBalanced: rawDebits === rawCredits,
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
  decimals?: number,
): GLEntry[] {
  const rnd = roundTo(decimals);
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
      ? (Number(line.debit) || 0) - (Number(line.credit) || 0)
      : (Number(line.credit) || 0) - (Number(line.debit) || 0);
    // A Bitcoin report carries the running balance in whole minor units, so it cannot drift.
    const running =
      decimals == null ? rnd(current + delta) : current + toMinorUnits(delta, decimals);
    const newBalance = decimals == null ? running : running / 10 ** decimals;
    runningBalances.set(line.accountId!, running);

    entries.push({
      date: line.date,
      accountName: info.name,
      accountCode: info.code,
      description: line.description,
      debit: decimals == null ? Number(line.debit) || 0 : rnd(Number(line.debit) || 0),
      credit: decimals == null ? Number(line.credit) || 0 : rnd(Number(line.credit) || 0),
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

  if (isIncomeType(t) || t === 'expense') {
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

export function computeCashFlow(balances: AccountBalance[], decimals?: number): CashFlowReport {
  const fin = fromUnits(decimals);
  const operating: ReportDataRow[] = [];
  const investing: ReportDataRow[] = [];
  const financing: ReportDataRow[] = [];
  const sums = { operating: 0, investing: 0, financing: 0 };

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

    const v = addable(b, decimals);
    if (bucket === 'operating') {
      if (t === 'asset' && !g.includes('cash') && !g.includes('bank')) {
        operating.push({ ...base, balance: -base.balance });
        sums.operating -= v;
      } else {
        operating.push(base);
        sums.operating += v;
      }
    } else if (bucket === 'investing') {
      investing.push({ ...base, balance: -base.balance });
      sums.investing -= v;
    } else {
      financing.push(base);
      sums.financing += v;
    }
  }

  const legacy = (rows: ReportDataRow[]) => rows.reduce((s, r) => s + r.balance, 0);
  const opTotal = fin(decimals == null ? legacy(operating) : sums.operating);
  const invTotal = fin(decimals == null ? legacy(investing) : sums.investing);
  const finTotal = fin(decimals == null ? legacy(financing) : sums.financing);

  return {
    operating: { header: 'Operating Activities', rows: operating, total: opTotal },
    investing: { header: 'Investing Activities', rows: investing, total: invTotal },
    financing: { header: 'Financing Activities', rows: financing, total: finTotal },
    netChange: fin(
      decimals == null
        ? opTotal + invTotal + finTotal
        : sums.operating + sums.investing + sums.financing,
    ),
  };
}
