import type { ReportCurrencyMode } from './audit-footer';

/**
 * The currency mode a report's numbers are really in. Wallet amounts exist only on the General
 * Ledger, so a wallet choice carried over to another report means primary. A secondary choice with
 * no secondary rate also means primary, because the amounts are not converted.
 */
export function effectiveReportCurrencyMode(
  chosen: ReportCurrencyMode,
  reportType: string | null,
  secondaryRateAvailable: boolean,
): ReportCurrencyMode {
  if (chosen === 'wallet') return reportType === 'general-ledger' ? 'wallet' : 'primary';
  if (chosen === 'secondary' && !secondaryRateAvailable) return 'primary';
  return chosen;
}
