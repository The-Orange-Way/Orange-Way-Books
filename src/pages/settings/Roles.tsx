/**
 * Roles & Capabilities — Phase 4.2 Admin UI (D8 resolution).
 *
 * Single-screen, two-column layout:
 *   - Left : role list (system presets + org-scoped customs)
 *   - Right: capability checklist for the selected role, grouped by feature
 *
 * Core-tier orgs see system presets read-only. Advanced+ tier orgs can
 * clone any preset into an editable custom role (`is_system = FALSE`,
 * `org_id = current org`) and toggle capabilities.
 *
 * User-role assignment section sits below the two-column layout. Admin
 * / Owner (any user with `users.manage_roles`) can add/remove role
 * grants for members.
 *
 * Mount points:
 *   - /admin?tab=roles (canonical — renders with `embedded` prop inside
 *     the Admin shell)
 *   - /settings/roles now redirects to /admin?tab=roles (back-compat).
 */

import React, { useMemo, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import {
  useCapability,
  useRoles,
  useRoleCapabilities,
  useAllCapabilities,
  useHasAdvancedTier,
  type RoleDefinition,
} from '@/hooks/useCapability';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { toast } from 'sonner';
import { Copy, Save, Lock, Shield, UserPlus, X, ChevronDown, ChevronRight } from 'lucide-react';
import RoleSummary from '@/components/roles/RoleSummary';

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function PresetBadge({ isSystem }: { isSystem: boolean }) {
  if (isSystem)
    return (
      <Badge variant="secondary" className="ml-2">
        Default role
      </Badge>
    );
  return <Badge className="ml-2">Custom</Badge>;
}

function FeatureHeader({ feature }: { feature: string }) {
  return (
    <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mt-4 mb-2">
      {feature.replace(/_/g, ' ')}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Role list column.
// ---------------------------------------------------------------------------

function RoleListColumn({
  roles,
  selectedRoleId,
  onSelect,
}: {
  roles: RoleDefinition[];
  selectedRoleId: string | null;
  onSelect: (id: string) => void;
}) {
  const systemRoles = roles.filter((r) => r.is_system);
  const customRoles = roles.filter((r) => !r.is_system);

  return (
    <div className="border rounded-md bg-card overflow-hidden">
      <div className="px-4 py-3 border-b bg-muted/50">
        <div className="font-semibold text-sm">Roles</div>
      </div>
      <div className="p-2 space-y-1">
        {systemRoles.length > 0 && (
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-2 py-1">
            Default roles
          </div>
        )}
        {systemRoles.map((r) => (
          <button
            key={r.id}
            onClick={() => onSelect(r.id)}
            className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
              selectedRoleId === r.id ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-accent'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="truncate">{r.name}</span>
              <Lock className="w-3 h-3 text-muted-foreground" />
            </div>
          </button>
        ))}
        {customRoles.length > 0 && (
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground px-2 py-1 pt-3">
            Custom Roles
          </div>
        )}
        {customRoles.map((r) => (
          <button
            key={r.id}
            onClick={() => onSelect(r.id)}
            className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
              selectedRoleId === r.id ? 'bg-primary/10 text-primary font-medium' : 'hover:bg-accent'
            }`}
          >
            <div className="truncate">{r.name}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Capability checklist column.
// ---------------------------------------------------------------------------

function CapabilityChecklist({
  selectedRole,
  orgId,
  hasAdvancedTier,
  canManageRoles,
}: {
  selectedRole: RoleDefinition | null;
  orgId: string;
  hasAdvancedTier: boolean;
  canManageRoles: boolean;
}) {
  const { capabilities, byFeature, loading: capsLoading } = useAllCapabilities();
  const {
    keys,
    loading: roleCapsLoading,
    refresh: refreshRoleCaps,
  } = useRoleCapabilities(selectedRole?.id ?? null);

  // Local draft state for unsaved edits.
  const [draft, setDraft] = useState<Set<string> | null>(null);
  const [saving, setSaving] = useState(false);
  // Gap 4: for system presets (read-only) we collapse the not-granted
  // capabilities by default so the summary dominates the view.
  const [showAllCaps, setShowAllCaps] = useState(false);

  // Reset draft + collapse state when the selected role changes.
  React.useEffect(() => {
    setDraft(null);
    setShowAllCaps(false);
  }, [selectedRole?.id]);

  const editable =
    selectedRole != null && !selectedRole.is_system && hasAdvancedTier && canManageRoles;
  const effective = draft ?? keys;
  const dirty = draft != null;

  const toggle = (key: string) => {
    if (!editable) return;
    const next = new Set(effective);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setDraft(next);
  };

  const save = async () => {
    if (!selectedRole || !draft || !editable) return;
    setSaving(true);

    // Diff against the persisted set to emit minimal row changes.
    const toAdd = [...draft].filter((k) => !keys.has(k));
    const toRemove = [...keys].filter((k) => !draft.has(k));

    if (toAdd.length) {
      const { error } = await supabase
        .from('role_capabilities')
        .insert(toAdd.map((capability_key) => ({ role_id: selectedRole.id, capability_key })));
      if (error) {
        setSaving(false);
        toast.error(`Failed to add permissions: ${error.message}`);
        return;
      }
    }
    if (toRemove.length) {
      const { error } = await supabase
        .from('role_capabilities')
        .delete()
        .eq('role_id', selectedRole.id)
        .in('capability_key', toRemove);
      if (error) {
        setSaving(false);
        toast.error(`Failed to remove permissions: ${error.message}`);
        return;
      }
    }

    setSaving(false);
    setDraft(null);
    refreshRoleCaps();
    toast.success(
      toAdd.length + toRemove.length === 0
        ? 'No changes to save'
        : `Saved ${toAdd.length} added, ${toRemove.length} removed`,
    );
  };

  if (!selectedRole) {
    return (
      <div className="border rounded-md bg-card p-6 text-muted-foreground text-sm">
        Select a role to view its permissions.
      </div>
    );
  }

  return (
    <div className="border rounded-md bg-card overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b bg-muted/50 flex items-center justify-between">
        <div>
          <div className="font-semibold text-sm flex items-center">
            Permissions for {selectedRole.name}
            <PresetBadge isSystem={selectedRole.is_system} />
          </div>
          {selectedRole.description && (
            <div className="text-xs text-muted-foreground mt-0.5">{selectedRole.description}</div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!editable && selectedRole.is_system && (
            <span className="text-xs text-muted-foreground">Built-in role (can't be edited)</span>
          )}
          {!editable && !selectedRole.is_system && !hasAdvancedTier && (
            <span className="text-xs text-amber-600">Upgrade required</span>
          )}
          <Button size="sm" onClick={save} disabled={!editable || !dirty || saving}>
            <Save className="w-3 h-3" />
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
      <div className="p-4 max-h-[calc(100vh-400px)] overflow-y-auto space-y-4">
        {capsLoading || roleCapsLoading ? (
          <div className="text-sm text-muted-foreground">Loading permissions…</div>
        ) : (
          <>
            {/* Plain-English summary of what the role CAN do. For custom
                roles with unsaved edits, preview the draft so the summary
                reflects the pending set. */}
            <RoleSummary
              grantedKeys={effective}
              byFeature={byFeature}
              totalCapabilities={capabilities.length}
            />

            {/* For read-only system presets, collapse the full matrix
                behind a toggle — the summary above is enough for 99% of
                the scan use cases. For editable custom roles, show the
                full matrix inline (the user needs it to toggle
                capabilities). */}
            {!editable && (
              <button
                type="button"
                onClick={() => setShowAllCaps((v) => !v)}
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              >
                {showAllCaps ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
                {showAllCaps ? 'Hide' : 'Show'} all permissions ({capabilities.length} total)
              </button>
            )}

            {editable ||
              (showAllCaps && (
                <div>
                  {[...byFeature.entries()].map(([feature, capsInFeature]) => (
                    <div key={feature}>
                      <FeatureHeader feature={feature} />
                      <div className="space-y-1.5">
                        {capsInFeature.map((c) => (
                          <label
                            key={c.key}
                            className={`flex items-start gap-2 py-1.5 px-2 rounded hover:bg-accent/50 ${
                              editable ? 'cursor-pointer' : 'cursor-default opacity-90'
                            }`}
                          >
                            <Checkbox
                              checked={effective.has(c.key)}
                              onCheckedChange={() => toggle(c.key)}
                              disabled={!editable}
                              className="mt-0.5"
                            />
                            <div className="flex-1 min-w-0">
                              {/* User-facing label is the plain-English description.
                                We intentionally do NOT render c.key, signing key, or Scoped-DEK
                                badges — those are internal cryptography primitives
                                that accountants and bookkeepers don't need to see. */}
                              <div className="text-sm">{c.description}</div>
                            </div>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ))}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// User-role assignment section.
// ---------------------------------------------------------------------------

interface OrgMemberRow {
  user_id: string;
  email: string | null;
  /** display_name from auth.users.user_metadata (full_name | name), if any. */
  name: string | null;
}

interface GrantRow {
  id: string;
  user_id: string;
  role_definition_id: string;
  role_name: string;
  revoked_at: string | null;
}

/**
 * Format a member for the Members section label. Priority:
 *   1. display_name (auth.users.user_metadata.full_name | .name)
 *   2. email
 *   3. shortened UUID ("73db615f…") — never the full UUID.
 * The caller is responsible for passing trimmed values.
 */
function formatMemberLabel(m: {
  user_id: string;
  email: string | null;
  name: string | null;
}): string {
  const name = (m.name ?? '').trim();
  if (name) return name;
  const email = (m.email ?? '').trim();
  if (email) return email;
  return `${m.user_id.slice(0, 8)}…`;
}

function UserAssignmentSection({
  orgId,
  roles,
  canManage,
}: {
  orgId: string;
  roles: RoleDefinition[];
  canManage: boolean;
}) {
  const [members, setMembers] = useState<OrgMemberRow[]>([]);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [newRoleByUser, setNewRoleByUser] = useState<Record<string, string>>({});

  const refresh = React.useCallback(async () => {
    setLoading(true);
    // Pull org_members for the membership list. We no longer surface the
    // legacy `role` text in this section — role grants are the source of
    // truth and display names/emails come from lookup-user-profiles.
    const { data: memberRows } = await supabase
      .from('org_members')
      .select('user_id')
      .eq('org_id', orgId);

    // Pull active grants and their role_definitions.name.
    const { data: grantRows } = await supabase
      .from('org_member_roles')
      .select('id, user_id, role_definition_id, revoked_at, role_definitions(name)')
      .eq('org_id', orgId)
      .is('revoked_at', null);

    const userIds = (memberRows ?? []).map((m: any) => m.user_id as string);

    // Resolve display name + email via the lookup-user-profiles edge
    // function. Wait for the session first so cold-start invocations
    // don't race the auth token being attached (401 on first render).
    const profileMap: Record<string, { email: string; name: string }> = {};
    if (userIds.length > 0) {
      try {
        await supabase.auth.getSession();
        const { data: profiles, error: profilesErr } = await supabase.functions.invoke(
          'lookup-user-profiles',
          { body: { userIds } },
        );
        if (profilesErr) {
          // Non-2xx from the edge function (likely not deployed yet or
          // auth mismatch). Surface it instead of silently falling
          // through — we need to notice if lookup dies in prod.
          console.warn('lookup-user-profiles returned an error:', profilesErr);
        } else if (Array.isArray(profiles)) {
          for (const p of profiles as Array<{ id: string; email?: string; name?: string }>) {
            profileMap[p.id] = { email: p.email ?? '', name: p.name ?? '' };
          }
        }
      } catch (err) {
        // Network / transport error — log and fall back to the
        // current-user patch below so at least the signed-in user's
        // row shows their own name.
        console.warn('lookup-user-profiles unavailable:', err);
      }
    }

    // Fallback patch: even if the edge function worked (or failed), make
    // sure the signed-in user's own row never renders as a bare UUID.
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user && !profileMap[user.id]) {
        profileMap[user.id] = {
          email: user.email ?? '',
          name:
            (user.user_metadata as { full_name?: string; name?: string } | null)?.full_name ??
            (user.user_metadata as { full_name?: string; name?: string } | null)?.name ??
            '',
        };
      }
    } catch {
      // Ignore — worst case we just render a truncated UUID for that row.
    }

    setMembers(
      (memberRows ?? []).map((m: any) => ({
        user_id: m.user_id,
        email: profileMap[m.user_id]?.email || null,
        name: profileMap[m.user_id]?.name || null,
      })),
    );
    setGrants(
      (grantRows ?? []).map((g: any) => ({
        id: g.id,
        user_id: g.user_id,
        role_definition_id: g.role_definition_id,
        role_name: g.role_definitions?.name ?? '(unknown)',
        revoked_at: g.revoked_at,
      })),
    );
    setLoading(false);
  }, [orgId]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const addGrant = async (userId: string) => {
    const roleId = newRoleByUser[userId];
    if (!roleId) {
      toast.error('Pick a role first');
      return;
    }
    const { error } = await supabase.from('org_member_roles').insert({
      org_id: orgId,
      user_id: userId,
      role_definition_id: roleId,
    });
    if (error) {
      toast.error(`Failed to add role: ${error.message}`);
      return;
    }
    toast.success('Role added');
    setNewRoleByUser({ ...newRoleByUser, [userId]: '' });
    void refresh();
  };

  const revokeGrant = async (grantId: string) => {
    const { error } = await supabase
      .from('org_member_roles')
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', grantId);
    if (error) {
      toast.error(`Failed to revoke: ${error.message}`);
      return;
    }
    toast.success('Role revoked');
    void refresh();
  };

  // Group grants by user_id for the render loop.
  const grantsByUser = useMemo(() => {
    const m = new Map<string, GrantRow[]>();
    for (const g of grants) {
      if (!m.has(g.user_id)) m.set(g.user_id, []);
      m.get(g.user_id)!.push(g);
    }
    return m;
  }, [grants]);

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold flex items-center gap-2">
          <UserPlus className="w-4 h-4" /> Who has a role
        </div>
        {!canManage && (
          <span className="text-xs text-muted-foreground">
            Viewer mode — ask an Owner/Admin to edit
          </span>
        )}
      </div>
      {loading ? (
        <div className="text-sm text-muted-foreground">Loading members…</div>
      ) : members.length === 0 ? (
        <div className="text-sm text-muted-foreground">No members in this org.</div>
      ) : (
        <div className="space-y-2">
          {members.map((m) => {
            const userGrants = grantsByUser.get(m.user_id) ?? [];
            return (
              <div key={m.user_id} className="border rounded-md p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate" title={m.email ?? m.user_id}>
                      {formatMemberLabel(m)}
                    </div>
                    {/* Secondary line: show email under the name when
                        both are known. Never show the raw UUID. */}
                    {m.name && m.email && (
                      <div className="text-xs text-muted-foreground truncate">{m.email}</div>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 mb-2">
                  {userGrants.length === 0 ? (
                    <span className="text-xs text-muted-foreground">No roles assigned yet</span>
                  ) : (
                    userGrants.map((g) => (
                      <Badge key={g.id} variant="secondary" className="flex items-center gap-1">
                        {g.role_name}
                        {canManage && (
                          <button
                            onClick={() => revokeGrant(g.id)}
                            className="ml-1 opacity-60 hover:opacity-100"
                            aria-label={`Remove ${g.role_name}`}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        )}
                      </Badge>
                    ))
                  )}
                </div>
                {canManage && (
                  <div className="flex items-center gap-2">
                    <select
                      value={newRoleByUser[m.user_id] ?? ''}
                      onChange={(e) =>
                        setNewRoleByUser({ ...newRoleByUser, [m.user_id]: e.target.value })
                      }
                      className="h-8 rounded-md border border-input bg-background px-2 text-xs"
                    >
                      <option value="">Add another role…</option>
                      {roles
                        .filter((r) => !userGrants.some((g) => g.role_definition_id === r.id))
                        .map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name} {r.is_system ? '(default)' : '(custom)'}
                          </option>
                        ))}
                    </select>
                    <Button size="sm" variant="outline" onClick={() => addGrant(m.user_id)}>
                      Add
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Main page.
// ---------------------------------------------------------------------------

export interface RolesProps {
  /**
   * When `true`, Roles is rendered as a tab inside the /admin layout and
   * the outer page chrome (padding, page heading, width clamp) is
   * removed. Defaults to `false` — standalone /settings/roles route.
   */
  embedded?: boolean;
}

export default function Roles({ embedded = false }: RolesProps = {}) {
  const { orgId } = useUserOrg();
  const { roles, loading, refresh: refreshRoles } = useRoles(orgId);
  const canManageRoles = useCapability('roles.manage', orgId);
  const canManageUsers = useCapability('users.manage_roles', orgId);
  const hasAdvancedTier = useHasAdvancedTier(orgId);

  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [cloneBusy, setCloneBusy] = useState(false);

  // Auto-select the first role once loaded.
  React.useEffect(() => {
    if (!selectedRoleId && roles.length > 0) {
      setSelectedRoleId(roles[0].id);
    }
  }, [roles, selectedRoleId]);

  const selectedRole = useMemo(
    () => roles.find((r) => r.id === selectedRoleId) ?? null,
    [roles, selectedRoleId],
  );

  const cloneEnabled = selectedRole != null && hasAdvancedTier && canManageRoles;

  const onClone = async () => {
    if (!selectedRole || !orgId || !cloneEnabled) return;
    setCloneBusy(true);
    // Copy the role_definitions row as a new org-scoped custom role.
    const newName = `${selectedRole.name} (copy)`;
    const { data: newRole, error: roleErr } = await supabase
      .from('role_definitions')
      .insert({
        org_id: orgId,
        name: newName,
        is_system: false,
        description: selectedRole.description,
      })
      .select('id')
      .single();
    if (roleErr || !newRole) {
      setCloneBusy(false);
      toast.error(`Failed to clone: ${roleErr?.message ?? 'unknown error'}`);
      return;
    }

    // Copy the source role's capabilities into the new role.
    const { data: srcCaps } = await supabase
      .from('role_capabilities')
      .select('capability_key')
      .eq('role_id', selectedRole.id);
    if (srcCaps && srcCaps.length > 0) {
      const { error: capsErr } = await supabase.from('role_capabilities').insert(
        srcCaps.map((c: { capability_key: string }) => ({
          role_id: newRole.id,
          capability_key: c.capability_key,
        })),
      );
      if (capsErr) {
        setCloneBusy(false);
        toast.error(`Copied role but failed to copy permissions: ${capsErr.message}`);
        return;
      }
    }

    setCloneBusy(false);
    toast.success(`Created custom role "${newName}"`);
    refreshRoles();
    setSelectedRoleId(newRole.id);
  };

  if (!orgId) {
    return <div className="p-6 text-sm text-muted-foreground">Waiting for org context…</div>;
  }

  // When embedded in /admin the shell already supplies padding and a
  // page-level heading ("Admin") — we render a slimmer header and skip
  // the width clamp/outer padding.
  const outerClasses = embedded ? 'space-y-6' : 'p-6 max-w-7xl mx-auto space-y-6';

  return (
    <div className={outerClasses}>
      <div className="flex items-start justify-between">
        <div>
          {embedded ? (
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Shield className="w-4 h-4" />
              Roles &amp; Permissions
            </div>
          ) : (
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Shield className="w-5 h-5" />
              Roles &amp; Permissions
            </h1>
          )}
          <p className="text-sm text-muted-foreground mt-1">
            Manage default and custom roles for this organization.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!hasAdvancedTier && (
            <div className="text-xs text-muted-foreground rounded-md border px-3 py-1 bg-amber-50">
              Custom roles require an Advanced plan.
              <Button variant="link" size="sm" className="h-auto p-0 ml-1 text-xs">
                Upgrade
              </Button>
            </div>
          )}
          <Button
            variant="outline"
            onClick={onClone}
            disabled={!cloneEnabled || cloneBusy}
            title={
              !hasAdvancedTier
                ? 'Requires Advanced plan'
                : !canManageRoles
                  ? "You don't have permission to manage roles"
                  : undefined
            }
          >
            <Copy className="w-4 h-4" />
            {cloneBusy ? 'Copying…' : 'Create custom role from this'}
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading roles…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4">
          <RoleListColumn
            roles={roles}
            selectedRoleId={selectedRoleId}
            onSelect={setSelectedRoleId}
          />
          <CapabilityChecklist
            selectedRole={selectedRole}
            orgId={orgId}
            hasAdvancedTier={hasAdvancedTier}
            canManageRoles={canManageRoles}
          />
        </div>
      )}

      <UserAssignmentSection orgId={orgId} roles={roles} canManage={canManageUsers} />
    </div>
  );
}
