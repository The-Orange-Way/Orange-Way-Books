/**
 * Monetary-item classification for FX revaluation (IAS 21 / ASC 830).
 *
 * Monetary items are assets and liabilities that will be received/paid in fixed
 * amounts of currency: cash, bank accounts, receivables, payables, short-term loans.
 *
 * Non-monetary items are carried at historical cost: PP&E, inventory, prepaid
 * expenses, equity accounts, deferred revenue, intangibles.
 *
 * The heuristic below is based on standard chart-of-accounts group names. Users
 * can override per-account via the `is_monetary` column on `chart_of_accounts`.
 */

import type { AccountInfo } from '@/lib/ledger-engine';

export type MonetaryClassification = 'monetary' | 'non-monetary' | 'ignore';

const MONETARY_GROUPS = new Set([
  // Assets
  'cash', 'bank', 'receivable', 'receivables', 'accounts receivable',
  'notes receivable', 'short-term investment', 'short-term investments',
  'other current assets',
  // Liabilities
  'payable', 'payables', 'accounts payable', 'credit card', 'credit cards',
  'short-term loan', 'short-term loans', 'accrued liabilities', 'current liabilities',
  'other current liabilities', 'long-term liabilities', 'notes payable',
]);

const NON_MONETARY_GROUPS = new Set([
  'fixed assets', 'property plant equipment', 'intangible', 'intangibles',
  'inventory', 'prepaid', 'prepaid expenses', 'deferred revenue',
  "owner's equity", 'retained earnings', 'dividends paid', 'equity',
  'capital', 'opening balance equity',
]);

/**
 * Classify an account as monetary or non-monetary.
 *
 * Rules (in priority order):
 * 1. If `is_monetary` override is provided (from DB), use it.
 * 2. Revenue and Expense accounts → 'ignore' (they flow through P&L, not B/S revaluation).
 * 3. Match accountGroup (lowercase) against known sets.
 * 4. Asset/Liability accounts without a group match → 'monetary' (safe default).
 * 5. Equity → 'non-monetary'.
 */
export function classifyMonetary(
  account: AccountInfo,
  override?: boolean | null,
): MonetaryClassification {
  if (override === true) return 'monetary';
  if (override === false) return 'non-monetary';

  const type = account.accountType?.toUpperCase() ?? '';
  const group = (account.accountGroup ?? '').toLowerCase().trim();

  // Revenue/Expense don't get revalued on the B/S
  if (type === 'REVENUE' | type === 'INCOME' | type === 'EXPENSE') return 'ignore';

  if (MONETARY_GROUPS.has(group)) return 'monetary';
  if (NON_MONETARY_GROUPS.has(group)) return 'non-monetary';

  // Default by type
  if (type === 'ASSETS' | type === 'ASSET') return 'monetary';
  if (type === 'LIABILITIES' | type === 'LIABILITY') return 'monetary';
  if (type === 'EQUITY') return 'non-monetary';

  return 'ignore';
}

/**
 * Filter a list of accounts down to those that are monetary and in a foreign
 * currency (i.e., wallet currency ≠ primary currency).
 *
 * @param accounts         - Full account list from ledger engine
 * @param walletCurrencies - Map of accountId → wallet currency (from wallets table)
 * @param primaryCurrency  - Org's primary currency
 * @param overrides        - Optional map of accountId → is_monetary override
 */
export function getMonetaryForeignAccounts(
  accounts: AccountInfo[],
  walletCurrencies: Map<string, string>,
  primaryCurrency: string,
  overrides?: Map<string, boolean>,
): AccountInfo[] {
  return accounts.filter(account => {
    const override = overrides?.get(account.id) ?? null;
    if (classifyMonetary(account, override) !== 'monetary') return false;
    const currency = walletCurrencies.get(account.id);
    if (!currency) return false;
    return currency.toUpperCase() !== primaryCurrency.toUpperCase();
  });
}
