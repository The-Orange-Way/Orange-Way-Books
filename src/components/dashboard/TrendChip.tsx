import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import type { Trend } from '@/lib/dashboard-trends';

export interface TrendChipProps {
  readonly trend: Trend;
}

export function TrendChip({ trend }: TrendChipProps) {
  const Icon = trend.direction === 'up' ? ArrowUp : trend.direction === 'down' ? ArrowDown : Minus;

  const pctLabel =
    trend.pct == null ? 'new' : `${trend.pct >= 0 ? '+' : ''}${trend.pct.toFixed(1)}%`;

  return (
    <span
      className={`owb-trend owb-trend--${trend.sentiment}`}
      aria-label={`Trend ${trend.direction} ${pctLabel}`}
    >
      <Icon className="owb-trend-arrow w-3 h-3" />
      {pctLabel}
    </span>
  );
}
