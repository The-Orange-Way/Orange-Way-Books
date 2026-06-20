import { Link } from 'react-router-dom';
import { CircleCheck, CircleAlert, TriangleAlert } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import type { TrialBalanceReport } from '@/lib/ledger-engine';

export type LedgerStatusSeverity = 'healthy' | 'warning' | 'critical';

export interface LedgerStatusIconProps {
  readonly trialBalance: TrialBalanceReport;
  readonly asOfDate: string;
  readonly primaryCurrency: string;
  readonly formatAmount: (v: number, c: string) => string;
  readonly warnings?: readonly string[];
}

function severityFrom(
  trialBalance: TrialBalanceReport,
  warnings: readonly string[],
): LedgerStatusSeverity {
  if (!trialBalance.isBalanced) return 'critical';
  if (warnings.length > 0) return 'warning';
  return 'healthy';
}

export function LedgerStatusIcon({
  trialBalance,
  asOfDate,
  primaryCurrency,
  formatAmount,
  warnings = [],
}: LedgerStatusIconProps) {
  const severity = severityFrom(trialBalance, warnings);

  const color = severity === 'healthy' ? '#16a34a' : severity === 'warning' ? '#d97706' : '#dc2626';

  const Icon =
    severity === 'healthy' ? CircleCheck : severity === 'warning' ? TriangleAlert : CircleAlert;

  const title =
    severity === 'healthy'
      ? 'All accounts balanced'
      : severity === 'warning'
        ? 'Ledger balanced · review advisories'
        : 'Ledger out of balance';

  const diff = Math.abs(trialBalance.totalDebits - trialBalance.totalCredits);
  const body: React.ReactNode =
    severity === 'healthy' ? (
      <>
        <p className="font-semibold">All accounts balanced.</p>
        <p className="text-xs mt-1 opacity-80">
          Total debits equal total credits. As of {asOfDate}.
        </p>
        <p className="text-xs mt-2 underline">Open Trial Balance →</p>
      </>
    ) : severity === 'warning' ? (
      <>
        <p className="font-semibold">Ledger is balanced, but:</p>
        <ul className="text-xs mt-1 list-disc pl-4 space-y-0.5">
          {warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
        <p className="text-xs mt-2 underline">Open Trial Balance →</p>
      </>
    ) : (
      <>
        <p className="font-semibold">Ledger is out of balance.</p>
        <p className="text-xs mt-1">
          Difference: <strong>{formatAmount(diff, primaryCurrency)}</strong>
        </p>
        <p className="text-xs mt-1 opacity-80">
          How to fix: open the Trial Balance report to find which accounts don&apos;t reconcile,
          then edit the offending journal entry so its debits equal its credits. Common causes: a
          split entry where one line was edited but the offsetting line wasn&apos;t, or an import
          that skipped a row.
        </p>
        <p className="text-xs mt-2 underline">Open Trial Balance →</p>
      </>
    );

  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/app/reports?report=trial-balance"
            aria-label={title}
            className="inline-flex items-center justify-center rounded-full p-1.5 hover:bg-muted/60 transition-colors"
          >
            <Icon className="w-5 h-5" style={{ color }} strokeWidth={2.25} />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-xs">
          {body}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
