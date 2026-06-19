import { useMemo } from 'react';

export interface InsightsDonutSliceView {
  readonly label: string;
  readonly value: number;
  readonly percent: number;
  readonly color: string;
}

const DONUT_PALETTE = [
  '#166534',
  '#22c55e',
  '#eab308',
  '#f97316',
  '#a855f7',
  '#ec4899',
  '#38bdf8',
  '#2563eb',
  '#64748b',
];

export function assignDonutColors(count: number): string[] {
  return Array.from({ length: count }, (_, i) => DONUT_PALETTE[i % DONUT_PALETTE.length]);
}

export function buildDonutSliceViews(
  slices: readonly { label: string; value: number }[],
): InsightsDonutSliceView[] {
  const positive = slices.filter((s) => s.value > 1e-9);
  const total = positive.reduce((sum, s) => sum + s.value, 0);
  if (total <= 0 || positive.length === 0) return [];
  const colors = assignDonutColors(positive.length);
  const rawPercents = positive.map((s) => (s.value / total) * 100);
  const rounded = rawPercents.map((p) => Math.round(p * 10) / 10);
  const drift = 100 - rounded.reduce((a, b) => a + b, 0);
  if (Math.abs(drift) >= 0.05 && rounded.length > 0) {
    rounded[rounded.length - 1] = Math.round((rounded[rounded.length - 1] + drift) * 10) / 10;
  }
  return positive.map((s, i) => ({
    label: s.label,
    value: s.value,
    percent: rounded[i],
    color: colors[i],
  }));
}

function buildConicGradient(views: InsightsDonutSliceView[]): string {
  let acc = 0;
  const parts = views.map((v) => {
    const start = acc;
    acc += v.percent;
    return `${v.color} ${start}% ${acc}%`;
  });
  return `conic-gradient(from -90deg, ${parts.join(', ')})`;
}

export interface InsightsDonutRingProps {
  readonly slices: InsightsDonutSliceView[];
}

export function InsightsDonutRing({ slices }: InsightsDonutRingProps) {
  const gradient = useMemo(() => buildConicGradient(slices), [slices]);
  if (slices.length === 0) {
    return <div className="owb-insights-donut-empty" aria-hidden="true">No data</div>;
  }
  return (
    <div
      className="owb-insights-donut-ring"
      style={{
        background: gradient,
        maskImage: 'radial-gradient(circle, transparent 58%, black 59%)',
        WebkitMaskImage: 'radial-gradient(circle, transparent 58%, black 59%)',
      }}
      aria-hidden="true"
    />
  );
}

export interface InsightsDonutChartProps {
  readonly slices: InsightsDonutSliceView[];
  readonly formatValue: (value: number) => string;
  /** Shown in the center hole of the ring (e.g. total amount). */
  readonly centerLabel?: string;
}

/** Donut ring centered + compact chip pills below. Hover chip to see amount. */
export function InsightsDonutChart({ slices, formatValue, centerLabel }: InsightsDonutChartProps) {
  const total = useMemo(() => slices.reduce((s, r) => s + r.value, 0), [slices]);
  const center = centerLabel ?? formatValue(total);

  if (slices.length === 0) {
    return (
      <div className="owb-donut-panel">
        <div className="owb-insights-donut-empty">No data</div>
      </div>
    );
  }

  return (
    <div className="owb-donut-panel">
      <div className="owb-donut-ring-wrap">
        <InsightsDonutRing slices={slices} />
        <div className="owb-donut-center" aria-hidden="true">{center}</div>
      </div>
      <div className="owb-donut-chips" role="list" aria-label="Breakdown">
        {slices.map((row) => (
          <span
            key={`${row.label}-${row.color}`}
            role="listitem"
            className="owb-donut-chip"
            title={`${row.label}: ${formatValue(row.value)} (${row.percent.toFixed(0)}%)`}
          >
            <span className="owb-donut-chip-dot" style={{ background: row.color }} aria-hidden="true" />
            <span className="owb-donut-chip-name">{row.label}</span>
            <span className="owb-donut-chip-pct">{row.percent.toFixed(0)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}
