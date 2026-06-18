import type { ReactElement } from 'react';
import { cn } from '@/lib/utils';

export type ReportViewMode = 'summary' | 'details';

const MODES: readonly { value: ReportViewMode; label: string }[] = [
  { value: 'summary', label: 'Summary' },
  { value: 'details', label: 'Details' },
];

interface ReportsViewToggleProps {
  readonly viewMode: ReportViewMode;
  readonly onChange: (mode: ReportViewMode) => void;
}

/**
 * Summary vs Details for P&amp;L, Balance Sheet, and Cash Flow.
 * Active segment uses neutral foreground (on-brand with Vault, not Material blue).
 */
export function ReportsViewToggle({ viewMode, onChange }: ReportsViewToggleProps): ReactElement {
  return (
    <div className="flex justify-center my-3" role="group" aria-label="View mode toggle">
      {MODES.map((mode) => (
        <button
          key={mode.value}
          type="button"
          className={cn(
            'px-6 py-2 text-xs font-bold border-2 border-border cursor-pointer transition-colors first:rounded-l-full first:border-r-0 last:rounded-r-full font-sans',
            viewMode === mode.value
              ? 'bg-foreground text-background border-foreground'
              : 'bg-background text-muted-foreground hover:bg-muted',
          )}
          onClick={() => onChange(mode.value)}
          aria-pressed={viewMode === mode.value}
        >
          {mode.label}
        </button>
      ))}
    </div>
  );
}
