/**
 * Pure-logic helpers for the capability model — Phase 4.2.
 *
 * Extracted from `useCapability.ts` so these helpers can be imported
 * in node-env tests without dragging in `@/lib/supabase` (which touches
 * `localStorage` at module scope and explodes outside jsdom).
 *
 * The contract mirrors the server-side `public.user_has_capability()`
 * function shipped in migration 20260422000000 so a "does the user have
 * capability X?" question resolves the same way on both sides.
 */

export interface CurrentUserRole {
  role_definition_id: string;
  role_name: string;
  is_system: boolean;
  expires_at: string | null;
}

export interface RawGrant {
  role_definition_id: string;
  expires_at: string | null;
  revoked_at?: string | null;
  role_definitions: { id: string; name: string; is_system: boolean } | null;
}

/**
 * Given the raw grant rows returned by the org_member_roles + joined
 * role_definitions query and the role_capabilities rows, compute the
 * active roles + aggregated capability set.
 */
export function aggregateActiveGrants(
  grants: RawGrant[],
  roleCaps: Array<{ role_id: string; capability_key: string }>,
  now: number = Date.now(),
): { roles: CurrentUserRole[]; capabilities: Set<string> } {
  const active: CurrentUserRole[] = (grants ?? [])
    .filter((g) => !g.revoked_at)
    .filter((g) => !g.expires_at | (new Date(g.expires_at).getTime() > now))
    .map((g) => ({
      role_definition_id: g.role_definition_id,
      role_name: g.role_definitions?.name ?? '(unknown role)',
      is_system: !!g.role_definitions?.is_system,
      expires_at: g.expires_at ?? null,
    }));

  const roleIds = new Set(active.map((r) => r.role_definition_id));
  const capabilities = new Set(
    (roleCaps ?? []).filter((c) => roleIds.has(c.role_id)).map((c) => c.capability_key),
  );

  return { roles: active, capabilities };
}
