/**
 * Seed an organization's chart_of_accounts with the canonical 43 defaults.
 *
 * Extracted from OnboardingWizard so the LedgerStatusPill retry path can
 * re-run the same logic without duplicating the catalog. Post-Phase-1:
 * pure ZKA Postgres inserts (no the ledger roundtrip).
 *
 * Pass `encryptText` from the caller's `useVault()` so the MEK stays in the
 * caller's React context — this module deliberately knows nothing about the
 * vault.
 */
import { supabase } from '@/lib/supabase';
import { encryptChartOfAccount } from '@/lib/crypto-fields';

export interface SeedAccount {
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';
  group: 'Assets' | 'Liabilities' | 'Equity' | 'Revenue' | 'Expenses';
  normalBalance: 'DEBIT' | 'CREDIT';
}

export const DEFAULT_ACCOUNTS: SeedAccount[] = [
  { code: '1000', name: 'Accounts',                  type: 'ASSET',     group: 'Assets',      normalBalance: 'DEBIT'  },
  { code: '1100', name: 'Cash & Bank',              type: 'ASSET',     group: 'Assets',      normalBalance: 'DEBIT'  },
  { code: '1110', name: 'Fiat Cash Accounts',        type: 'ASSET',     group: 'Assets',      normalBalance: 'DEBIT'  },
  { code: '1120', name: 'Digital Asset Accounts',    type: 'ASSET',     group: 'Assets',      normalBalance: 'DEBIT'  },
  { code: '1200', name: 'Accounts Receivable',      type: 'ASSET',     group: 'Assets',      normalBalance: 'DEBIT'  },
  { code: '1300', name: 'Prepaid Expenses',         type: 'ASSET',     group: 'Assets',      normalBalance: 'DEBIT'  },
  { code: '1305', name: 'Inventory',                type: 'ASSET',     group: 'Assets',      normalBalance: 'DEBIT'  },
  { code: '1500', name: 'Transfer Clearing',        type: 'ASSET',     group: 'Assets',      normalBalance: 'DEBIT'  },
  { code: '1600', name: 'Equipment',                type: 'ASSET',     group: 'Assets',      normalBalance: 'DEBIT'  },
  { code: '1700', name: 'Other Assets',             type: 'ASSET',     group: 'Assets',      normalBalance: 'DEBIT'  },
  { code: '2000', name: 'Liabilities',              type: 'LIABILITY', group: 'Liabilities', normalBalance: 'CREDIT' },
  { code: '2100', name: 'Current Liabilities',      type: 'LIABILITY', group: 'Liabilities', normalBalance: 'CREDIT' },
  { code: '2110', name: 'Accounts Payable',         type: 'LIABILITY', group: 'Liabilities', normalBalance: 'CREDIT' },
  { code: '2120', name: 'Credit Cards',             type: 'LIABILITY', group: 'Liabilities', normalBalance: 'CREDIT' },
  { code: '2130', name: 'Sales Tax Payable',        type: 'LIABILITY', group: 'Liabilities', normalBalance: 'CREDIT' },
  { code: '2140', name: 'Payroll Liabilities',      type: 'LIABILITY', group: 'Liabilities', normalBalance: 'CREDIT' },
  { code: '2200', name: 'Long-Term Liabilities',    type: 'LIABILITY', group: 'Liabilities', normalBalance: 'CREDIT' },
  { code: '2210', name: 'Notes Payable',            type: 'LIABILITY', group: 'Liabilities', normalBalance: 'CREDIT' },
  { code: '2220', name: 'Mortgage Payable',         type: 'LIABILITY', group: 'Liabilities', normalBalance: 'CREDIT' },
  { code: '3000', name: "Owner's Equity",           type: 'EQUITY',    group: 'Equity',      normalBalance: 'CREDIT' },
  { code: '3100', name: 'Starting Balance',         type: 'EQUITY',    group: 'Equity',      normalBalance: 'CREDIT' },
  { code: '3200', name: 'Retained Earnings',        type: 'EQUITY',    group: 'Equity',      normalBalance: 'CREDIT' },
  { code: '3300', name: 'Dividends Paid',           type: 'EQUITY',    group: 'Equity',      normalBalance: 'DEBIT'  },
  { code: '4000', name: 'Sales',                    type: 'INCOME',    group: 'Revenue',     normalBalance: 'CREDIT' },
  { code: '4100', name: 'Sales Revenue',            type: 'INCOME',    group: 'Revenue',     normalBalance: 'CREDIT' },
  { code: '4200', name: 'Service Revenue',          type: 'INCOME',    group: 'Revenue',     normalBalance: 'CREDIT' },
  { code: '4300', name: 'Interest Income',          type: 'INCOME',    group: 'Revenue',     normalBalance: 'CREDIT' },
  { code: '4400', name: 'Other Income',             type: 'INCOME',    group: 'Revenue',     normalBalance: 'CREDIT' },
  { code: '4500', name: 'Gain on Sale of Assets',   type: 'INCOME',    group: 'Revenue',     normalBalance: 'CREDIT' },
  { code: '4600', name: 'Unrealized Gains',         type: 'INCOME',    group: 'Revenue',     normalBalance: 'CREDIT' },
  { code: '5000', name: 'Cost of Goods Sold',       type: 'EXPENSE',   group: 'Expenses',    normalBalance: 'DEBIT'  },
  { code: '5200', name: 'Salaries & Wages',         type: 'EXPENSE',   group: 'Expenses',    normalBalance: 'DEBIT'  },
  { code: '5300', name: 'Rent Expense',             type: 'EXPENSE',   group: 'Expenses',    normalBalance: 'DEBIT'  },
  { code: '5400', name: 'Utilities',                type: 'EXPENSE',   group: 'Expenses',    normalBalance: 'DEBIT'  },
  { code: '5500', name: 'Insurance',                type: 'EXPENSE',   group: 'Expenses',    normalBalance: 'DEBIT'  },
  { code: '5600', name: 'Depreciation',             type: 'EXPENSE',   group: 'Expenses',    normalBalance: 'DEBIT'  },
  { code: '5700', name: 'Marketing & Advertising',  type: 'EXPENSE',   group: 'Expenses',    normalBalance: 'DEBIT'  },
  { code: '5800', name: 'Professional Services',    type: 'EXPENSE',   group: 'Expenses',    normalBalance: 'DEBIT'  },
  { code: '5900', name: 'Travel & Entertainment',   type: 'EXPENSE',   group: 'Expenses',    normalBalance: 'DEBIT'  },
  { code: '5950', name: 'Bank & Transaction Fees',  type: 'EXPENSE',   group: 'Expenses',    normalBalance: 'DEBIT'  },
  { code: '5960', name: 'Loss on Sale of Assets',   type: 'EXPENSE',   group: 'Expenses',    normalBalance: 'DEBIT'  },
  { code: '5970', name: 'Unrealized Losses',        type: 'EXPENSE',   group: 'Expenses',    normalBalance: 'DEBIT'  },
  { code: '5980', name: 'Other Expenses',           type: 'EXPENSE',   group: 'Expenses',    normalBalance: 'DEBIT'  },
];

/**
 * Seed an org's chart_of_accounts. Idempotent at the catalog level — each
 * row insert may fail on a uniqueness constraint if the account already
 * exists; callers should query first (or handle the constraint error) for
 * a "retry from failed state" use case.
 */
export async function initChartOfAccounts(
  orgId: string,
  encryptText: (plaintext: string) => Promise<string>,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  let done = 0;
  onProgress?.(0, DEFAULT_ACCOUNTS.length);
  for (const account of DEFAULT_ACCOUNTS) {
    try {
      const enc = await encryptChartOfAccount({
        account_name: account.name,
        account_code: account.code,
        account_type: account.type,
        account_group: null,
        account_category: null,
        account_sub_type: null,
        description: null,
        is_group: false,
        is_system: true,
        is_archived: false,
        allowed_currencies: null,
        parent_id: null,
      }, encryptText);
      const { error: insertError } = await supabase.from('chart_of_accounts').insert({
        org_id: orgId,
        ...enc,
      } as any);
      if (insertError) throw insertError;
    } catch (err) {
      console.error(`Failed to create account ${account.code}:`, err);
      throw err;
    } finally {
      done += 1;
      onProgress?.(done, DEFAULT_ACCOUNTS.length);
    }
  }
}
