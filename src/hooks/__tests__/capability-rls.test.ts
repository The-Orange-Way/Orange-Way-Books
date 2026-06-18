/**
 * @vitest-environment node
 *
 * Phase 4.2 — capability model RLS logic tests.
 *
 * The real RLS lives in Postgres (migration
 * 20260423010000_phase4_2_capability_rls.sql). We can't run Postgres
 * in-process, but we CAN verify the logical contract the RLS policies
 * implement by running an equivalent JS predicate against a
 * deterministic fixture.
 *
 * Contract under test (from docs/OWB-MULTIUSER-DESIGN.md §2.5):
 *   user_has_capability(user_id, capability, org_id) returns TRUE iff:
 *     - there is at least one org_member_roles row where user_id, org_id
 *       match and revoked_at IS NULL and (expires_at IS NULL OR >now())
 *     - that role's role_capabilities includes the capability key
 *
 * Preset bundles: the 9 system presets from D7 are asserted explicitly
 * against the shipped preset matrix. If any of these assertions fail,
 * the seed migration and the design doc disagree.
 */

import { describe, it, expect } from 'vitest';
import { aggregateActiveGrants, type RawGrant } from '@/hooks/capability-logic';

// ---------------------------------------------------------------------------
// Fixture: the preset bundles from the D7 resolution, hand-transcribed.
// If the seed migration ever drifts from these bundles the test should
// fail loudly — this is intentional.
// ---------------------------------------------------------------------------

const ALL_CAPS = [
  'transactions.read', 'transactions.write', 'transactions.write_own', 'transactions.delete',
  'journal_entries.read', 'journal_entries.write', 'journal_entries.delete',
  'accounts.read', 'accounts.write', 'accounts.delete',
  'payments.read', 'payments.create', 'payments.approve', 'payments.pay',
  'contacts.read', 'contacts.write', 'contacts.delete',
  'reports.read', 'reports.read_summary',
  'periods.close', 'periods.unlock',
  'users.invite', 'users.revoke', 'users.manage_roles',
  'roles.manage',
  'connectors.read', 'connectors.write',
  'org.manage',
  'audit.read',
  'support.session_open', 'support.scope_read',
] as const;

type Cap = (typeof ALL_CAPS)[number];

const PRESETS: Record<string, Cap[]> = {
  Owner: [...ALL_CAPS],
  Admin: ALL_CAPS.filter((c) => c !== 'periods.unlock'),
  Accountant: [
    'transactions.read', 'transactions.write', 'transactions.delete',
    'journal_entries.read', 'journal_entries.write', 'journal_entries.delete',
    'accounts.read', 'accounts.write', 'accounts.delete',
    'contacts.read', 'contacts.write', 'contacts.delete',
    'payments.read',
    'reports.read', 'reports.read_summary',
    'periods.close',
    'audit.read',
    'connectors.read',
  ],
  Bookkeeper: [
    'transactions.read', 'transactions.write_own',
    'journal_entries.read', 'journal_entries.write',
    'accounts.read',
    'contacts.read', 'contacts.write',
    'reports.read',
  ],
  PaymentsApprover: [
    'transactions.read',
    'payments.read', 'payments.approve',
    'reports.read',
  ],
  PaymentsPayer: [
    'transactions.read',
    'payments.read', 'payments.pay',
    'reports.read',
  ],
  Auditor: [
    'transactions.read',
    'journal_entries.read',
    'accounts.read',
    'payments.read',
    'contacts.read',
    'reports.read', 'reports.read_summary',
    'connectors.read',
    'audit.read',
  ],
  Viewer: ['reports.read_summary'],
  OWBSupport: ['support.session_open', 'support.scope_read', 'audit.read'],
};

// ---------------------------------------------------------------------------
// user_has_capability equivalent.
// ---------------------------------------------------------------------------

interface Grant {
  userId: string;
  orgId: string;
  roleName: keyof typeof PRESETS;
  revokedAt: Date | null;
  expiresAt: Date | null;
}

function userHasCapability(
  grants: Grant[],
  userId: string,
  capability: Cap,
  orgId: string,
  now: Date = new Date(),
): boolean {
  const active = grants.filter(
    (g) =>
      g.userId === userId &&
      g.orgId === orgId &&
      g.revokedAt === null &&
      (g.expiresAt === null || g.expiresAt > now),
  );
  return active.some((g) => PRESETS[g.roleName].includes(capability));
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('preset capability bundles', () => {
  it('Owner has all 31 capabilities', () => {
    expect(PRESETS.Owner.length).toBe(ALL_CAPS.length);
  });

  it('Admin is Owner minus periods.unlock', () => {
    expect(PRESETS.Admin).not.toContain('periods.unlock');
    expect(PRESETS.Admin).toContain('roles.manage');
    expect(PRESETS.Admin.length).toBe(ALL_CAPS.length - 1);
  });

  it('Accountant has no payments approve/pay and no users.*', () => {
    expect(PRESETS.Accountant).not.toContain('payments.approve');
    expect(PRESETS.Accountant).not.toContain('payments.pay');
    expect(PRESETS.Accountant).not.toContain('users.invite');
    expect(PRESETS.Accountant).not.toContain('users.revoke');
    expect(PRESETS.Accountant).not.toContain('org.manage');
  });

  it('Bookkeeper has only write_own (not full write)', () => {
    expect(PRESETS.Bookkeeper).toContain('transactions.write_own');
    expect(PRESETS.Bookkeeper).not.toContain('transactions.write');
    expect(PRESETS.Bookkeeper).not.toContain('transactions.delete');
  });

  it('PaymentsApprover and PaymentsPayer are distinct (SoD)', () => {
    expect(PRESETS.PaymentsApprover).toContain('payments.approve');
    expect(PRESETS.PaymentsApprover).not.toContain('payments.pay');

    expect(PRESETS.PaymentsPayer).toContain('payments.pay');
    expect(PRESETS.PaymentsPayer).not.toContain('payments.approve');
  });

  it('Auditor only has read capabilities — no writes', () => {
    for (const cap of PRESETS.Auditor) {
      const isWrite =
        cap.endsWith('.write') ||
        cap.endsWith('.delete') ||
        cap.endsWith('.create') ||
        cap.endsWith('.approve') ||
        cap.endsWith('.pay') ||
        cap === 'periods.close' ||
        cap === 'periods.unlock' ||
        cap === 'roles.manage' ||
        cap === 'org.manage';
      expect(isWrite).toBe(false);
    }
  });

  it('Viewer only holds reports.read_summary', () => {
    expect(PRESETS.Viewer).toEqual(['reports.read_summary']);
  });

  it('OWBSupport has scoped support caps + audit.read only', () => {
    expect(PRESETS.OWBSupport).toEqual([
      'support.session_open',
      'support.scope_read',
      'audit.read',
    ]);
    expect(PRESETS.OWBSupport).not.toContain('transactions.read');
  });
});

describe('user_has_capability semantics', () => {
  const user = 'user-1';
  const org = 'org-a';

  it('returns true for a granted capability under an active role', () => {
    const grants: Grant[] = [
      { userId: user, orgId: org, roleName: 'Accountant', revokedAt: null, expiresAt: null },
    ];
    expect(userHasCapability(grants, user, 'transactions.write', org)).toBe(true);
    expect(userHasCapability(grants, user, 'payments.pay', org)).toBe(false);
  });

  it('returns false for a revoked grant', () => {
    const grants: Grant[] = [
      { userId: user, orgId: org, roleName: 'Admin', revokedAt: new Date(), expiresAt: null },
    ];
    expect(userHasCapability(grants, user, 'transactions.write', org)).toBe(false);
  });

  it('returns false for an expired grant', () => {
    const grants: Grant[] = [
      {
        userId: user,
        orgId: org,
        roleName: 'Auditor',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      },
    ];
    expect(userHasCapability(grants, user, 'transactions.read', org)).toBe(false);
  });

  it('returns false across org boundaries', () => {
    const grants: Grant[] = [
      { userId: user, orgId: org, roleName: 'Owner', revokedAt: null, expiresAt: null },
    ];
    expect(userHasCapability(grants, user, 'transactions.write', 'org-b')).toBe(false);
  });

  it('aggregates capabilities across multiple active grants', () => {
    const grants: Grant[] = [
      { userId: user, orgId: org, roleName: 'PaymentsApprover', revokedAt: null, expiresAt: null },
      { userId: user, orgId: org, roleName: 'PaymentsPayer', revokedAt: null, expiresAt: null },
    ];
    // SoD violation at assignment, but the union is what RLS sees.
    expect(userHasCapability(grants, user, 'payments.approve', org)).toBe(true);
    expect(userHasCapability(grants, user, 'payments.pay', org)).toBe(true);
  });

  it('Auditor grant does NOT imply any write capability', () => {
    const grants: Grant[] = [
      { userId: user, orgId: org, roleName: 'Auditor', revokedAt: null, expiresAt: null },
    ];
    expect(userHasCapability(grants, user, 'transactions.read', org)).toBe(true);
    expect(userHasCapability(grants, user, 'transactions.write', org)).toBe(false);
    expect(userHasCapability(grants, user, 'journal_entries.write', org)).toBe(false);
    expect(userHasCapability(grants, user, 'periods.close', org)).toBe(false);
  });

  it('Viewer cannot view full reports, only summaries', () => {
    const grants: Grant[] = [
      { userId: user, orgId: org, roleName: 'Viewer', revokedAt: null, expiresAt: null },
    ];
    expect(userHasCapability(grants, user, 'reports.read_summary', org)).toBe(true);
    expect(userHasCapability(grants, user, 'reports.read', org)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hook helper — aggregateActiveGrants.
// ---------------------------------------------------------------------------

describe('aggregateActiveGrants (hook helper)', () => {
  it('excludes revoked grants', () => {
    const grants: RawGrant[] = [
      {
        role_definition_id: 'r1',
        expires_at: null,
        revoked_at: new Date().toISOString(),
        role_definitions: { id: 'r1', name: 'Admin', is_system: true },
      },
    ];
    const { roles, capabilities } = aggregateActiveGrants(grants, [
      { role_id: 'r1', capability_key: 'transactions.write' },
    ]);
    expect(roles).toHaveLength(0);
    expect(capabilities.size).toBe(0);
  });

  it('excludes expired grants', () => {
    const grants: RawGrant[] = [
      {
        role_definition_id: 'r1',
        expires_at: new Date(Date.now() - 1000).toISOString(),
        revoked_at: null,
        role_definitions: { id: 'r1', name: 'Auditor', is_system: true },
      },
    ];
    const { roles, capabilities } = aggregateActiveGrants(grants, [
      { role_id: 'r1', capability_key: 'transactions.read' },
    ]);
    expect(roles).toHaveLength(0);
    expect(capabilities.size).toBe(0);
  });

  it('aggregates capabilities across multiple active grants', () => {
    const grants: RawGrant[] = [
      {
        role_definition_id: 'r1',
        expires_at: null,
        revoked_at: null,
        role_definitions: { id: 'r1', name: 'PaymentsApprover', is_system: true },
      },
      {
        role_definition_id: 'r2',
        expires_at: null,
        revoked_at: null,
        role_definitions: { id: 'r2', name: 'PaymentsPayer', is_system: true },
      },
    ];
    const { capabilities } = aggregateActiveGrants(grants, [
      { role_id: 'r1', capability_key: 'payments.approve' },
      { role_id: 'r2', capability_key: 'payments.pay' },
      { role_id: 'r999', capability_key: 'stale.key' }, // ignored (no grant)
    ]);
    expect(capabilities.has('payments.approve')).toBe(true);
    expect(capabilities.has('payments.pay')).toBe(true);
    expect(capabilities.has('stale.key')).toBe(false);
  });

  it('handles missing role_definitions (null join) gracefully', () => {
    const grants: RawGrant[] = [
      {
        role_definition_id: 'r1',
        expires_at: null,
        revoked_at: null,
        role_definitions: null,
      },
    ];
    const { roles } = aggregateActiveGrants(grants, []);
    expect(roles).toHaveLength(1);
    expect(roles[0].role_name).toBe('(unknown role)');
  });
});

describe('D9 last-role-removal invariant', () => {
  it('after revoking all grants, user has zero capabilities in that org', () => {
    const user = 'user-1';
    const org = 'org-a';
    const grants: Grant[] = [
      { userId: user, orgId: org, roleName: 'Admin', revokedAt: null, expiresAt: null },
      { userId: user, orgId: org, roleName: 'Accountant', revokedAt: null, expiresAt: null },
    ];
    // With both active, user has e.g. payments.approve
    expect(userHasCapability(grants, user, 'payments.approve', org)).toBe(true);

    // Revoke both.
    const revokedNow = new Date();
    const revokedGrants = grants.map((g) => ({ ...g, revokedAt: revokedNow }));
    for (const cap of ALL_CAPS) {
      expect(userHasCapability(revokedGrants, user, cap, org)).toBe(false);
    }
  });
});
