/**
 * Capability hooks — Phase 4.2.
 *
 * Drives UI gating off the capability model seeded in migration
 * 20260423000000_phase4_2_capabilities_and_presets.sql. Three public
 * hooks:
 *
 *   - useRoles(orgId)              — list of role_definitions for the
 *                                    org (system presets + custom).
 *   - useCurrentUserRoles(orgId)   — current user's active role grants
 *                                    plus the aggregated capability set.
 *   - useCapability(key, orgId)    — boolean check; subscribes to
 *                                    realtime changes on
 *                                    org_member_roles + role_capabilities
 *                                    so capability loss takes effect
 *                                    without a page reload (design
 *                                    doc §2.4 hard requirement #4).
 *
 * Realtime: we open a single Supabase channel per (orgId, userId) pair
 * via the shared `useCapabilityChannel` internal and fan-out refreshes
 * to every hook instance. That keeps the number of open channels equal
 * to the number of distinct orgs a user is switching between (always 1
 * today) rather than the number of capability checks rendered.
 */

import { useEffect, useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { aggregateActiveGrants, type CurrentUserRole, type RawGrant } from './capability-logic';

export type { CurrentUserRole, RawGrant } from './capability-logic';
export { aggregateActiveGrants } from './capability-logic';

export interface RoleDefinition {
  id: string;
  org_id: string | null;
  name: string;
  is_system: boolean;
  description: string | null;
}

export interface CurrentUserRoles {
  roles: CurrentUserRole[];
  capabilities: Set<string>;
  loading: boolean;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Module-level refresh bus. Each (orgId, userId) key keeps a counter that
// bumps on any realtime event. Hook instances subscribe to the counter and
// re-run their fetch when it changes. This keeps the number of open
// Supabase channels bounded and gives every hook instance the same
// invalidation signal.
// ---------------------------------------------------------------------------

type Listener = () => void;
const channelRefCounts = new Map<string, number>();
const channelHandles = new Map<string, ReturnType<typeof supabase.channel>>();
const listeners = new Map<string, Set<Listener>>();

function channelKey(orgId: string, userId: string): string {
  return `${orgId}::${userId}`;
}

function notifyAll(key: string) {
  const set = listeners.get(key);
  if (!set) return;
  for (const fn of set) fn();
}

function subscribeChannel(orgId: string, userId: string, onChange: Listener): () => void {
  const key = channelKey(orgId, userId);
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key)!.add(onChange);

  const current = channelRefCounts.get(key) ?? 0;
  channelRefCounts.set(key, current + 1);

  if (current === 0) {
    // Open a single realtime channel for this (orgId, userId) pair.
    // We watch org_member_roles for THIS user+org (revocations,
    // grants) and role_capabilities for the whole org (a capability
    // added/removed on a role the user holds still affects them).
    // We don't try to filter role_capabilities by role_id — the set of
    // roles the user holds is dynamic, and overfetching on role_capabilities
    // edits is cheap (table is small, events are rare).
    const channel = supabase
      .channel(`capability:${key}`)
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        {
          event: '*',
          schema: 'public',
          table: 'org_member_roles',
          filter: `user_id=eq.${userId}`,
        },
        () => notifyAll(key),
      )
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        { event: '*', schema: 'public', table: 'role_capabilities' },
        () => notifyAll(key),
      )
      .on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        'postgres_changes' as any,
        { event: '*', schema: 'public', table: 'role_definitions' },
        () => notifyAll(key),
      )
      .subscribe();
    channelHandles.set(key, channel);
  }

  return () => {
    const set = listeners.get(key);
    if (set) {
      set.delete(onChange);
      if (set.size === 0) listeners.delete(key);
    }
    const nextCount = (channelRefCounts.get(key) ?? 1) - 1;
    if (nextCount <= 0) {
      const handle = channelHandles.get(key);
      if (handle) {
        void supabase.removeChannel(handle);
        channelHandles.delete(key);
      }
      channelRefCounts.delete(key);
    } else {
      channelRefCounts.set(key, nextCount);
    }
  };
}

// ---------------------------------------------------------------------------
// useCurrentUserRoles — primary data source. Fetches the active role
// grants for the calling user in an org and unions their capability
// keys. Every other hook derives from this.
// ---------------------------------------------------------------------------

async function fetchCurrentUserRoles(
  orgId: string,
  userId: string,
): Promise<Omit<CurrentUserRoles, 'loading'>> {
  // Pull active grants with their role_definitions.name. Filter at the
  // DB layer on revoked_at IS NULL. expires_at is filtered client-side
  // (cheap, table is small per user) so we don't rely on now() in a
  // PostgREST filter.
  const { data: grants, error: grantsErr } = await supabase
    .from('org_member_roles')
    .select('role_definition_id, expires_at, role_definitions ( id, name, is_system )')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .is('revoked_at', null);

  if (grantsErr) {
    return { roles: [], capabilities: new Set(), error: grantsErr.message };
  }

  // First pass: filter to active (non-revoked, non-expired) grants so we
  // know which role_ids to pull capabilities for.
  const rawGrants = (grants ?? []) as unknown as RawGrant[];
  const firstPass = aggregateActiveGrants(rawGrants, []);
  if (firstPass.roles.length === 0) {
    return { roles: [], capabilities: new Set(), error: null };
  }

  // Aggregate capabilities. One round-trip via `in` filter.
  const roleIds = firstPass.roles.map((r) => r.role_definition_id);
  const { data: caps, error: capsErr } = await supabase
    .from('role_capabilities')
    .select('role_id, capability_key')
    .in('role_id', roleIds);

  if (capsErr) {
    return { roles: firstPass.roles, capabilities: new Set(), error: capsErr.message };
  }

  const secondPass = aggregateActiveGrants(
    rawGrants,
    (caps ?? []) as Array<{ role_id: string; capability_key: string }>,
  );
  return { roles: secondPass.roles, capabilities: secondPass.capabilities, error: null };
}

/**
 * Returns the calling user's active role grants in the given org plus
 * the aggregated capability set. Subscribes to realtime updates so
 * loss-of-capability takes effect without a reload.
 */
export function useCurrentUserRoles(orgId: string | null): CurrentUserRoles {
  const [state, setState] = useState<CurrentUserRoles>({
    roles: [],
    capabilities: new Set(),
    loading: true,
    error: null,
  });

  useEffect(() => {
    let active = true;
    if (!orgId) {
      setState({ roles: [], capabilities: new Set(), loading: false, error: null });
      return;
    }

    let cleanup: (() => void) | null = null;

    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        if (active)
          setState({ roles: [], capabilities: new Set(), loading: false, error: 'no-user' });
        return;
      }

      const refresh = async () => {
        const result = await fetchCurrentUserRoles(orgId, user.id);
        if (!active) return;
        setState({
          roles: result.roles,
          capabilities: result.capabilities,
          loading: false,
          error: result.error,
        });
      };

      await refresh();
      cleanup = subscribeChannel(orgId, user.id, () => {
        void refresh();
      });
    })();

    return () => {
      active = false;
      if (cleanup) cleanup();
    };
  }, [orgId]);

  return state;
}

// ---------------------------------------------------------------------------
// useCapability — boolean gate on a single capability key.
// ---------------------------------------------------------------------------

/**
 * Returns TRUE when the calling user holds `capabilityKey` via an active
 * role grant in the given org. Empty/NULL orgId returns FALSE. Re-evaluates
 * on realtime changes to org_member_roles + role_capabilities.
 */
export function useCapability(capabilityKey: string, orgId: string | null): boolean {
  const { capabilities } = useCurrentUserRoles(orgId);
  return useMemo(() => capabilities.has(capabilityKey), [capabilities, capabilityKey]);
}

// ---------------------------------------------------------------------------
// useRoles — role list for the org (system + custom), for the Admin UI.
// ---------------------------------------------------------------------------

export interface UseRolesResult {
  roles: RoleDefinition[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useRoles(orgId: string | null): UseRolesResult {
  const [roles, setRoles] = useState<RoleDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    if (!orgId) {
      setRoles([]);
      setLoading(false);
      return;
    }

    let cleanup: (() => void) | null = null;

    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) {
        if (active) {
          setLoading(false);
          setError('no-user');
        }
        return;
      }

      const refresh = async () => {
        // System presets (org_id IS NULL) + this org's custom roles.
        const { data, error: err } = await supabase
          .from('role_definitions')
          .select('id, org_id, name, is_system, description')
          .or(`org_id.is.null,org_id.eq.${orgId}`)
          .order('is_system', { ascending: false })
          .order('name');
        if (!active) return;
        if (err) {
          setError(err.message);
          setRoles([]);
        } else {
          setError(null);
          setRoles((data ?? []) as RoleDefinition[]);
        }
        setLoading(false);
      };

      await refresh();
      cleanup = subscribeChannel(orgId, user.id, () => {
        void refresh();
      });
    })();

    return () => {
      active = false;
      if (cleanup) cleanup();
    };
  }, [orgId, tick]);

  return { roles, loading, error, refresh: () => setTick((t) => t + 1) };
}

// ---------------------------------------------------------------------------
// useRoleCapabilities — capability set for a given role. Drives the
// right-column checklist in the Admin UI. Not realtime-subscribed at
// this level — the Admin UI itself pulls a fresh list on save to avoid
// stomping on another admin's concurrent edit.
// ---------------------------------------------------------------------------

export interface UseRoleCapabilitiesResult {
  keys: Set<string>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useRoleCapabilities(roleId: string | null): UseRoleCapabilitiesResult {
  const [keys, setKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    if (!roleId) {
      setKeys(new Set());
      setLoading(false);
      return;
    }
    (async () => {
      const { data, error: err } = await supabase
        .from('role_capabilities')
        .select('capability_key')
        .eq('role_id', roleId);
      if (!active) return;
      if (err) {
        setError(err.message);
        setKeys(new Set());
      } else {
        setError(null);
        setKeys(new Set((data ?? []).map((r: { capability_key: string }) => r.capability_key)));
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [roleId, tick]);

  return { keys, loading, error, refresh: () => setTick((t) => t + 1) };
}

// ---------------------------------------------------------------------------
// useAllCapabilities — the full registry, grouped by feature for the UI.
// ---------------------------------------------------------------------------

export interface CapabilityRow {
  key: string;
  feature: string;
  description: string;
  requires_osk: boolean;
  requires_dek: boolean;
  added_in_version: string | null;
}

export interface UseAllCapabilitiesResult {
  capabilities: CapabilityRow[];
  byFeature: Map<string, CapabilityRow[]>;
  loading: boolean;
  error: string | null;
}

export function useAllCapabilities(): UseAllCapabilitiesResult {
  const [capabilities, setCapabilities] = useState<CapabilityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      const { data, error: err } = await supabase
        .from('capabilities')
        .select('key, feature, description, requires_osk, requires_dek, added_in_version')
        .order('feature')
        .order('key');
      if (!active) return;
      if (err) {
        setError(err.message);
      } else {
        setCapabilities((data ?? []) as CapabilityRow[]);
        setError(null);
      }
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  const byFeature = useMemo(() => {
    const m = new Map<string, CapabilityRow[]>();
    for (const c of capabilities) {
      if (!m.has(c.feature)) m.set(c.feature, []);
      m.get(c.feature)!.push(c);
    }
    return m;
  }, [capabilities]);

  return { capabilities, byFeature, loading, error };
}

// ---------------------------------------------------------------------------
// Tier gate — no billing state yet. Stubbed to `hasAdvancedTier = true`
// so the Admin UI's clone/edit controls are usable in dev. Phase 4.x wires
// this to whatever tier/plan column the billing pipeline introduces.
// ---------------------------------------------------------------------------

/**
 * Returns whether the current org can use Advanced+ features (custom
 * role creation, clone preset, capability editing). Currently stubbed
 * to TRUE pending billing integration.
 *
 * TODO(Phase 4.x): wire this to the org's subscription tier once OWB
 * persists one. Decisions D1 + D23 both track this.
 */
export function useHasAdvancedTier(_orgId: string | null): boolean {
  // TODO: replace with a real tier lookup (org.subscription_tier or
  // billing service RPC) once billing tiers land. Hardcoded to true so
  // the UI is testable now.
  return true;
}
