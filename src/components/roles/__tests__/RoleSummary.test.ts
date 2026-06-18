/**
 * @vitest-environment node
 *
 * Unit tests for the RoleSummary pure helpers (Gap 4 of Phase 4.2 polish).
 *
 * We only test the deterministic bits — `buildRoleSummary` and
 * `humanizeFeature` — and intentionally skip the React component render
 * path because that's covered by manual UI verification and would
 * require jsdom + @testing-library infrastructure that the codebase
 * doesn't currently use for other components.
 */
import { describe, it, expect } from 'vitest';
import {
  buildRoleSummary,
  humanizeFeature,
} from '@/components/roles/RoleSummary';
import type { CapabilityRow } from '@/hooks/useCapability';

function cap(
  key: string,
  feature: string,
  description: string,
): CapabilityRow {
  return {
    key,
    feature,
    description,
    requires_osk: false,
    requires_dek: true,
    added_in_version: '4.2',
  };
}

describe('humanizeFeature', () => {
  it('title-cases and un-snake-cases feature keys', () => {
    expect(humanizeFeature('transactions')).toBe('Transactions');
    expect(humanizeFeature('payment_requests')).toBe('Payment requests');
    expect(humanizeFeature('journal_entries')).toBe('Journal entries');
  });

  it('handles already-pretty keys safely', () => {
    expect(humanizeFeature('Audit')).toBe('Audit');
  });
});

describe('buildRoleSummary', () => {
  const byFeature: Map<string, CapabilityRow[]> = new Map([
    [
      'transactions',
      [
        cap('transactions.read', 'transactions', 'View transactions'),
        cap('transactions.write', 'transactions', 'Create and edit transactions'),
      ],
    ],
    [
      'payments',
      [
        cap('payments.read', 'payments', 'View payment requests'),
        cap('payments.approve', 'payments', 'Approve payment requests'),
        cap('payments.pay', 'payments', 'Execute approved payments'),
      ],
    ],
    [
      'reports',
      [cap('reports.read', 'reports', 'View financial reports')],
    ],
  ]);

  it('returns empty array when no capabilities are granted', () => {
    expect(buildRoleSummary(new Set(), byFeature)).toEqual([]);
  });

  it('groups granted capabilities by feature and drops features with zero grants', () => {
    // PaymentsApprover-style bundle: can view txs, view + approve payments, view reports.
    const granted = new Set([
      'transactions.read',
      'payments.read',
      'payments.approve',
      'reports.read',
    ]);
    const summary = buildRoleSummary(granted, byFeature);

    // No "write" tx grants → transactions feature still appears but only
    // with the read description.
    expect(summary).toEqual([
      { feature: 'transactions', descriptions: ['View transactions'] },
      {
        feature: 'payments',
        descriptions: ['View payment requests', 'Approve payment requests'],
      },
      { feature: 'reports', descriptions: ['View financial reports'] },
    ]);
  });

  it('omits features where no capability is granted even if they exist in the registry', () => {
    const granted = new Set(['reports.read']);
    const summary = buildRoleSummary(granted, byFeature);
    expect(summary.map((s) => s.feature)).toEqual(['reports']);
  });

  it('ignores granted keys that are not in the registry (unknown capabilities)', () => {
    const granted = new Set(['nonexistent.cap', 'transactions.read']);
    const summary = buildRoleSummary(granted, byFeature);
    expect(summary).toEqual([
      { feature: 'transactions', descriptions: ['View transactions'] },
    ]);
  });

  it('preserves the iteration order of the input Map (feature order is stable)', () => {
    // Insertion order: transactions, payments, reports. Grant one from each.
    const granted = new Set(['payments.pay', 'transactions.read', 'reports.read']);
    const summary = buildRoleSummary(granted, byFeature);
    expect(summary.map((s) => s.feature)).toEqual([
      'transactions',
      'payments',
      'reports',
    ]);
  });

  it('skips capabilities with blank/whitespace descriptions', () => {
    const sparse: Map<string, CapabilityRow[]> = new Map([
      [
        'x',
        [
          cap('x.a', 'x', 'Do A'),
          cap('x.b', 'x', '   '),
          cap('x.c', 'x', ''),
        ],
      ],
    ]);
    const summary = buildRoleSummary(new Set(['x.a', 'x.b', 'x.c']), sparse);
    expect(summary).toEqual([{ feature: 'x', descriptions: ['Do A'] }]);
  });
});
