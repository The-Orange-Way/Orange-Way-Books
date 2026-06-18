import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useFormatCurrency } from '@/hooks/useOrgSettings';
import {
  InsightsDonutChart,
  buildDonutSliceViews,
} from './InsightsDonutChart';
import type { JournalLine, AccountInfo } from '@/lib/ledger-engine';

export type ExpenseInsightsPreset = 'ytd' | 'month' | '30d' | '90d' | 'all';

export interface ExpensesInsightsCardProps {
  readonly journalLines: JournalLine[];
  readonly accounts: AccountInfo[];
  readonly primaryCurrency: string;
  readonly profitLossHref?: string;
  readonly maxSlices?: number;
}

function formatUtcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function endOfUtcMonth(year: number, monthIndex: number): Date {
  return new Date(Date.UTC(year, monthIndex + 1, 0, 23, 59, 59, 999));
}

function getRangeForPreset(preset: ExpenseInsightsPreset): {
  start: string;
  end: string;
  label: string;
} {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();

  if (preset === 'month') {
    const start = new Date(Date.UTC(y, m, 1));
    const end = endOfUtcMonth(y, m);
    return { start: formatUtcDate(start), end: formatUtcDate(end), label: 'This month' };
  }
  if (preset === '30d') {
    const end = new Date(Date.UTC(y, m, d, 23, 59, 59, 999));
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 29);
    start.setUTCHours(0, 0, 0, 0);
    return { start: formatUtcDate(start), end: formatUtcDate(end), label: 'Last 30 days' };
  }
  if (preset === '90d') {
    const end = new Date(Date.UTC(y, m, d, 23, 59, 59, 999));
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 89);
    start.setUTCHours(0, 0, 0, 0);
    return { start: formatUtcDate(start), end: formatUtcDate(end), label: 'Last 90 days' };
  }
  if (preset === 'all') {
    return { start: '2000-01-01', end: '2099-12-31', label: 'All time' };
  }
  const start = new Date(Date.UTC(y, 0, 1));
  const end = new Date(Date.UTC(y, m, d, 23, 59, 59, 999));
  return { start: formatUtcDate(start), end: formatUtcDate(end), label: 'Year to date' };
}

export function ExpensesInsightsCard({
  journalLines,
  accounts,
  primaryCurrency,
  profitLossHref = '/reports?report=pnl',
  maxSlices = 6,
}: ExpensesInsightsCardProps) {
  const { formatAmount } = useFormatCurrency();
  const [preset, setPreset] = useState<ExpenseInsightsPreset>('all');

  const range = useMemo(() => getRangeForPreset(preset), [preset]);

  const expenseAccountIds = useMemo(() => {
    const ids = new Set<string>();
    for (const a of accounts) {
      if (a.accountType === 'Expense') ids.add(a.id);
    }
    return ids;
  }, [accounts]);

  const accountNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of accounts) m.set(a.id, a.name);
    return m;
  }, [accounts]);

  const slices = useMemo(() => {
    const totals = new Map<string, number>();
    for (const line of journalLines) {
      if (!line.accountId) continue;
      if (!expenseAccountIds.has(line.accountId)) continue;
      if (line.date < range.start | line.date > range.end) continue;
      const amount = (line.debit | 0) - (line.credit | 0);
      if (amount <= 0) continue;
      const name = accountNameById.get(line.accountId) | 'Unknown';
      totals.set(name, (totals.get(name) | 0) + amount);
    }
    const entries = [...totals.entries()]
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
    if (entries.length <= maxSlices) return entries;
    const top = entries.slice(0, maxSlices);
    const rest = entries.slice(maxSlices);
    const otherTotal = rest.reduce((s, e) => s + e.value, 0);
    if (otherTotal > 1e-9) top.push({ label: 'Other', value: otherTotal });
    return top;
  }, [journalLines, expenseAccountIds, accountNameById, range, maxSlices]);

  const donutSlices = useMemo(() => buildDonutSliceViews(slices), [slices]);

  return (
    <section className="owb-insights-card" aria-labelledby="owb-insights-expenses-title">
      <div className="owb-insights-card-head">
        <h2 id="owb-insights-expenses-title" className="owb-insights-card-title">
          Expenses breakdown
        </h2>
        <Link className="owb-insights-card-link" to={profitLossHref}>
          View report
        </Link>
      </div>
      <div className="owb-insights-card-toolbar">
        <label htmlFor="owb-expense-insights-period" className="owb-insights-sr-only">
          Period
        </label>
        <select
          id="owb-expense-insights-period"
          className="owb-insights-select"
          value={preset}
          onChange={(e) => setPreset(e.target.value as ExpenseInsightsPreset)}
        >
          <option value="all">All time</option>
          <option value="ytd">Year to date</option>
          <option value="month">This month</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
        </select>
      </div>
      <p className="owb-insights-card-caption">
        {range.label} · totals in {primaryCurrency.toUpperCase()}
      </p>
      <InsightsDonutChart
        slices={donutSlices}
        formatValue={(v) => formatAmount(v, primaryCurrency)}
      />
    </section>
  );
}
