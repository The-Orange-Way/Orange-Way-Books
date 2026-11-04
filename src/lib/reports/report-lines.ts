import { type ExcludedEntry, type JournalLine, prepareReportLines } from '../ledger-engine';
import type { ReportCurrencyMode } from './audit-footer';

/**
 * The lines a report adds up, for the currency view it is shown in.
 * - The wallet view keeps each line's stored amount in its own wallet currency.
 * - A Bitcoin report keeps full precision and leaves out entries it cannot value.
 * - A fiat report values every line at its primary amount from the posting date, so a wallet in
 *   another currency is never added as if it were the primary currency, and lines still waiting
 *   for a rate are left out and listed (OWB-T0232). Older entries with no currency recorded are
 *   kept and valued as before.
 * The secondary view multiplies the primary amounts by `secondaryRate`.
 * A fiat report rounds each line to `fiatDecimals` (the report currency's minor unit) within its
 * entry, so the General Ledger's running balance adds the same amounts as the balances.
 */
export function reportLinesFor(
  lines: JournalLine[],
  opts: {
    primaryCurrency: string;
    effectiveMode: ReportCurrencyMode;
    bitcoinReport: boolean;
    secondaryRate: number | null;
    decimals?: number;
    fiatDecimals?: number;
  },
): { lines: JournalLine[]; excluded: ExcludedEntry[] } {
  const { primaryCurrency, effectiveMode, bitcoinReport, secondaryRate, decimals, fiatDecimals } =
    opts;
  if (effectiveMode === 'wallet') return { lines, excluded: [] };
  const rate = effectiveMode === 'secondary' ? secondaryRate : null;
  if (bitcoinReport) return prepareReportLines(lines, primaryCurrency, rate, decimals);
  return prepareReportLines(lines, primaryCurrency, rate, fiatDecimals, {
    keepUnknownCurrency: true,
  });
}
