/**
 * RoleSummary, Phase 4.2 polish (Gap 4).
 *
 * Presents a plain-English "Can: …" sentence for the currently selected
 * role, built from the `description` fields of the capabilities actually
 * granted to that role. For non-technical users this is a much faster
 * scan than reading 31 checkboxes (most of them unchecked) to figure out
 * what a role like PaymentsApprover actually does.
 *
 * The component is intentionally display-only, all data comes in via
 * props so the Roles page can keep its existing data-fetching hooks and
 * so this can be unit-tested in isolation.
 */
import React from 'react';
import type { CapabilityRow } from '@/hooks/useCapability';

// ---------------------------------------------------------------------------
// Pure helper, exported for unit-tests. Given the granted capability keys
// and the full capability registry grouped by feature, emit a compact
// per-feature summary suitable for rendering.
// ---------------------------------------------------------------------------

export interface FeatureSummary {
  feature: string;
  descriptions: string[];
}

export function buildRoleSummary(
  grantedKeys: Set<string>,
  byFeature: Map<string, CapabilityRow[]>,
): FeatureSummary[] {
  const out: FeatureSummary[] = [];
  for (const [feature, caps] of byFeature) {
    const granted = caps.filter((c) => grantedKeys.has(c.key));
    if (granted.length === 0) continue;
    out.push({
      feature,
      descriptions: granted.map((c) => c.description).filter((d) => d && d.trim().length > 0),
    });
  }
  return out;
}

/**
 * Humanize a feature key like `payment_requests` → `Payment requests`.
 */
export function humanizeFeature(feature: string): string {
  const s = feature.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------------------
// React component.
// ---------------------------------------------------------------------------

export interface RoleSummaryProps {
  grantedKeys: Set<string>;
  byFeature: Map<string, CapabilityRow[]>;
  /** Total capability count in the registry, used to show "N of M" granted. */
  totalCapabilities: number;
}

export default function RoleSummary({
  grantedKeys,
  byFeature,
  totalCapabilities,
}: RoleSummaryProps) {
  const summary = buildRoleSummary(grantedKeys, byFeature);
  const grantedCount = grantedKeys.size;

  if (grantedCount === 0) {
    return (
      <div className="rounded-md border bg-muted/30 p-3 text-sm text-muted-foreground">
        This role has no permissions yet.
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-muted/30 p-3 text-sm space-y-2">
      <div className="font-medium text-foreground flex items-center justify-between">
        <span>What this role can do</span>
        <span className="text-xs text-muted-foreground font-normal">
          {grantedCount} of {totalCapabilities} permissions
        </span>
      </div>
      <ul className="space-y-1.5">
        {summary.map((s) => (
          <li key={s.feature} className="text-xs">
            <span className="font-semibold text-foreground">{humanizeFeature(s.feature)}:</span>{' '}
            <span className="text-muted-foreground">{s.descriptions.join('; ')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
