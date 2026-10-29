import type { BitcoinDisplay } from '@/types';
import { csvExportCurrencyLabel } from '@/lib/exports/csv-currency-label';
import { transactionAmountNumericForCsv } from '@/lib/exports/csv-transaction-amount';

/**
 * One General Ledger amount for a wallet-mode CSV: the number and the currency label that names
 * its units, both from the row's own currency, so the two always agree.
 * - BTC follows the Bitcoin display setting (sats or BTC), with the matching label.
 * - SATS amounts are already whole satoshis and stay so, labelled Satoshis.
 * - Fiat passes through with its code. A row with no currency is labelled Unknown.
 */
export function glWalletCsvCell(
  amount: number,
  rowCurrency: string | null,
  bitcoinDisplay: BitcoinDisplay,
): { value: number; label: string } {
  if (rowCurrency == null) return { value: amount, label: 'Unknown' };
  const c = rowCurrency.trim().toUpperCase();
  if (c === 'SATS' || c === 'SAT') return { value: amount, label: 'Satoshis' };
  return {
    value: transactionAmountNumericForCsv(amount, c, bitcoinDisplay),
    label: csvExportCurrencyLabel(c, bitcoinDisplay),
  };
}
