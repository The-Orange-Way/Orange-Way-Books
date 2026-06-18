import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useFormatCurrency } from '@/hooks/useOrgSettings';
import { useSecondaryDisplayRate } from '@/lib/exchange/hooks';
import {
  InsightsDonutRing,
  buildDonutSliceViews,
  type InsightsDonutSliceView,
} from './InsightsDonutChart';
import type { WalletBalance } from '@/lib/ledger-engine';

export interface WalletsInsightsCardProps {
  readonly wallets: WalletBalance[];
  readonly primaryCurrency: string;
  readonly secondaryCurrency: string | null;
  readonly walletsHref: string;
  readonly balanceSheetHref: string;
}

/** Use balancePrimary (from JE dual amounts) when available, else fall back to currentBalance. */
function primaryWeight(w: WalletBalance): number {
  const val = w.balancePrimary ?? w.currentBalance;
  return Math.max(0, val);
}

function chipTooltip(
  row: InsightsDonutSliceView,
  w: WalletBalance,
  formatAmount: (n: number, c: string) => string,
  primaryCurrency: string,
  secondaryRate: number | null,
  secondaryCurrency: string | null,
): string {
  const nativeLine = formatAmount(w.currentBalance, w.asset);
  const primaryLine = w.balancePrimary != null
    ? ` · ${formatAmount(w.balancePrimary, primaryCurrency)}`
    : '';
  const secondaryLine = (secondaryRate != null && w.balancePrimary != null && secondaryCurrency)
    ? ` · ≈${formatAmount(w.balancePrimary * secondaryRate, secondaryCurrency)}`
    : '';
  return `${row.label}: ${nativeLine}${primaryLine}${secondaryLine} (${row.percent.toFixed(0)}%)`;
}

export function WalletsInsightsCard({
  wallets,
  primaryCurrency,
  secondaryCurrency,
  walletsHref,
  balanceSheetHref,
}: WalletsInsightsCardProps) {
  const { formatAmount } = useFormatCurrency();
  const { rate: secondaryRate } = useSecondaryDisplayRate(primaryCurrency, secondaryCurrency);

  const weighted = useMemo(
    () => wallets.filter((w) => primaryWeight(w) > 1e-9),
    [wallets],
  );

  const baseSlices = useMemo(
    () => weighted.map((w) => ({ label: w.name, value: primaryWeight(w) })),
    [weighted],
  );

  const donutViews = useMemo(() => buildDonutSliceViews(baseSlices), [baseSlices]);

  const totalPrimary = useMemo(
    () => weighted.reduce((s, w) => {
      const bal = w.balancePrimary ?? w.currentBalance;
      return s + Math.max(0, bal);
    }, 0),
    [weighted],
  );

  const totalSecondary = (secondaryRate != null && secondaryCurrency)
    ? totalPrimary * secondaryRate
    : null;

  return (
    <section className="owb-insights-card" aria-labelledby="owb-insights-wallets-title">
      <div className="owb-insights-card-head">
        <h2 id="owb-insights-wallets-title" className="owb-insights-card-title">
          Accounts
        </h2>
        <Link className="owb-insights-card-link" to={walletsHref}>
          View accounts
        </Link>
      </div>
      <p className="owb-insights-card-caption">
        Hover a chip for balance ·{' '}
        <Link to={balanceSheetHref}>Balance sheet</Link>
      </p>
      {wallets.length === 0 ? (
        <p className="owb-insights-card-empty">
          No accounts yet.{' '}
          <Link to={walletsHref}>Add an account</Link> to see balances here.
        </p>
      ) : donutViews.length === 0 ? (
        <p className="owb-insights-card-empty">No balances to chart yet.</p>
      ) : (
        <div className="owb-donut-panel">
          <div className="owb-donut-ring-wrap">
            <InsightsDonutRing slices={donutViews} />
            <div className="owb-donut-center" aria-hidden="true">
              <span className="owb-donut-center-primary">
                {formatAmount(totalPrimary, primaryCurrency)}
              </span>
              {totalSecondary != null && secondaryCurrency && (
                <span className="owb-donut-center-secondary" style={{ fontSize: '0.65em', display: 'block', opacity: 0.6 }}>
                  ≈{formatAmount(totalSecondary, secondaryCurrency)}
                </span>
              )}
            </div>
          </div>
          <div className="owb-donut-chips" role="list" aria-label="Accounts breakdown">
            {donutViews.map((row, i) => {
              const w = weighted[i];
              if (!w) return null;
              return (
                <span
                  key={w.walletId}
                  role="listitem"
                  className="owb-donut-chip"
                  title={chipTooltip(row, w, formatAmount, primaryCurrency, secondaryRate, secondaryCurrency)}
                >
                  <span className="owb-donut-chip-dot" style={{ background: row.color }} aria-hidden="true" />
                  <span className="owb-donut-chip-name">{row.label}</span>
                  <span className="owb-donut-chip-pct">{row.percent.toFixed(0)}%</span>
                </span>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
