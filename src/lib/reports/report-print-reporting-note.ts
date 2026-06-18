/** Same ids as `ReportType` in Reports.tsx — kept here to avoid a circular import. */
export type PrintableReportType =
  | 'pnl'
  | 'balance-sheet'
  | 'cash-flow'
  | 'general-ledger'
  | 'trial-balance'
  | 'activity-log';

type ReportCurrencyMode = 'wallet' | 'primary' | 'secondary';

/**
 * One-line explanation for printed/PDF reports so amounts are not ambiguous.
 */
export function reportPrintReportingNote(
  reportType: PrintableReportType,
  currencyMode: ReportCurrencyMode,
  primaryCurrency: string,
  secondaryCurrency: string | null,
): string | undefined {
  if (reportType === 'activity-log') {
    return undefined;
  }

  const p = (primaryCurrency.trim() | 'USD').toUpperCase();
  const s = secondaryCurrency?.trim().toUpperCase() ?? null;

  switch (currencyMode) {
    case 'primary':
      return `All amounts are in primary currency (${p}).`;
    case 'secondary': {
      const code = s ?? p;
      return `All amounts are in secondary currency (${code}).`;
    }
    case 'wallet':
      return "Amounts use each account's wallet currency.";
    default:
      return `All amounts are in primary currency (${p}).`;
  }
}
