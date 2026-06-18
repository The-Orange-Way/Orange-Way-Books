-- ============================================================
-- Multi-user schema + keypair lifecycle
-- ============================================================
-- Adds the six new tables and one helper function that Phase 4.1
-- depends on. Phase 4.2 will seed capabilities + role_definitions
-- rows and rewrite mutating RLS policies to route through
-- user_has_capability(). Phase 4.3 adds the invite-wrap pipeline
-- that populates org_keys beyond the owner's self-wrap.
--
-- Design references:
--   docs/OWB-MULTIUSER-DESIGN.md §2 (capability schema) and §8 "Decisions locked"
--   docs/OWB-USER-MANAGEMENT-ZKA.md §14 (DDL sketches)
--
-- What this migration does NOT do (explicitly — future phases):
--   * Seed capabilities or role_definitions rows (4.2)
--   * Rewrite existing RLS policies to use user_has_capability (4.2)
--   * Add WRITE policies to the six new tables beyond lifecycle needs (4.2)
--   * Extend org_keys with grant_scope / expires_at / revoked_at (4.3+)
--   * Bump key_version on org_keys (4.5 hard re-key owns that)
--
-- Safety: every CREATE is `IF NOT EXISTS`; every ALTER is guarded
-- with `IF NOT EXISTS` on the column. Running this migration twice
-- is a no-op.

-- ── user_vault_keys ──────────────────────────────────────────────────
-- Per-user hybrid keypair. Shared across all orgs for a given user
-- (one master keypair per user, v1). The private key is
-- wrapped under the user's MEK before it touches the server — we only
-- ever see ciphertext. Password change re-wraps with the new MEK via
-- atomic UPDATE (Decision D5).
--
-- algorithm column ships as x25519-mlkem768-v1 (X25519 classical half
-- concatenated with ML-KEM-768 post-quantum half, HKDF-SHA-256
-- combiner). See src/lib/pqc.ts for the byte-length constants.
CREATE TABLE IF NOT EXISTS public.user_vault_keys (
  user_id               UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  public_key_b64        TEXT NOT NULL,
  encrypted_private_key TEXT NOT NULL,
  iv                    TEXT NOT NULL,
  key_algorithm         TEXT NOT NULL DEFAULT 'x25519-mlkem768-v1',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.user_vault_keys ENABLE ROW LEVEL SECURITY;

-- The owner of the row can see and maintain it. No peer reads yet:
-- Phase 4.3 adds a SELECT policy that lets Owner/Admin read a
-- prospective invitee's public key to wrap the Org DEK for them.
DROP POLICY IF EXISTS "user_vault_keys_select_own" ON public.user_vault_keys;
CREATE POLICY "user_vault_keys_select_own"
  ON public.user_vault_keys
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "user_vault_keys_insert_own" ON public.user_vault_keys;
CREATE POLICY "user_vault_keys_insert_own"
  ON public.user_vault_keys
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

-- UPDATE policy intentionally permits only in-place re-wrap of the
-- user's own row. This is the guardrail behind atomic
-- UPDATE, no DELETE+INSERT.
DROP POLICY IF EXISTS "user_vault_keys_update_own" ON public.user_vault_keys;
CREATE POLICY "user_vault_keys_update_own"
  ON public.user_vault_keys
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE public.user_vault_keys IS
  'Per-user hybrid keypair (X25519 + ML-KEM-768). '
  'One row per user, shared across all orgs. '
  'Private key is MEK-wrapped client-side before upload.';

COMMENT ON COLUMN public.user_vault_keys.public_key_b64 IS
  'Base64 of concat(x25519_pub[32], mlkem768_pub[1184]) = 1216 bytes.';

COMMENT ON COLUMN public.user_vault_keys.encrypted_private_key IS
  'AES-256-GCM ciphertext of the hybrid secret key (2432 bytes), '
  'wrapped with a key derived from the user MEK via HKDF. '
  'Server never sees plaintext.';

COMMENT ON COLUMN public.user_vault_keys.key_algorithm IS
  'Algorithm identifier; bump when changing KEM combiner or adding '
  'ML-DSA signing half.';

-- updated_at auto-touch trigger — mirrors the pattern used by
-- org_settings so the re-wrap path does not have to set it manually.
CREATE OR REPLACE FUNCTION public.touch_user_vault_keys_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_user_vault_keys_updated_at ON public.user_vault_keys;
CREATE TRIGGER trg_user_vault_keys_updated_at
  BEFORE UPDATE ON public.user_vault_keys
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_user_vault_keys_updated_at();

-- ── org_keys extension ───────────────────────────────────────────────
-- org_keys already exists (migration 20260416110000) with
-- (id, org_id, user_id, wrapped_dek, iv, key_version, created_at, updated_at).
-- Phase 4.1 leaves that shape intact and only reaffirms the defaults.
-- Phase 4.3 adds grant_scope + granted_by + expires_at + revoked_at
-- when the real invite / revoke pipeline lands; keeping them out here
-- so Phase 4.1 can ship without touching the revoke semantics.
ALTER TABLE public.org_keys
  ALTER COLUMN key_version SET DEFAULT 1;

COMMENT ON COLUMN public.org_keys.key_version IS
  'Bumps on hard re-key. Phase 4.1 pins everything at 1.';

-- ── capabilities registry ────────────────────────────────────────────
-- Registry, not data: every capability the app knows about.
-- Rows are seeded by migrations in Phase 4.2 per the capability
-- list finalized under Decision D7. No runtime inserts.
CREATE TABLE IF NOT EXISTS public.capabilities (
  key              TEXT PRIMARY KEY,
  feature          TEXT NOT NULL,
  description      TEXT NOT NULL,
  requires_osk     BOOLEAN NOT NULL DEFAULT FALSE,
  requires_dek     BOOLEAN NOT NULL DEFAULT TRUE,
  added_in_version TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.capabilities ENABLE ROW LEVEL SECURITY;

-- Every authenticated user may read the capability registry — this
-- is how the frontend renders the "what can I do" surface. Writes
-- arrive exclusively via migrations, never via the client, so no
-- INSERT/UPDATE/DELETE policies are defined.
DROP POLICY IF EXISTS "capabilities_select_all_authenticated" ON public.capabilities;
CREATE POLICY "capabilities_select_all_authenticated"
  ON public.capabilities
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.capabilities IS
  'Capability registry (empty until 4.2 seeds it). '
  'Adding a new feature = INSERT capabilities + role_capabilities rows '
  'in a migration; never at runtime. Capability checks at RLS and UI '
  'route through user_has_capability().';

-- ── role_definitions ─────────────────────────────────────────────────
-- Each row is a role bundle. System presets (is_system = TRUE) arrive
-- in Phase 4.2 per Decision D2. Custom roles created by Owners/Admins
-- on Advanced+ tiers (custom-roles tier) carry is_system = FALSE and a
-- non-NULL org_id that scopes them to that org.
CREATE TABLE IF NOT EXISTS public.role_definitions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, name)
);

-- Look up a role by org scope quickly (drives the admin UI).
CREATE INDEX IF NOT EXISTS idx_role_definitions_org
  ON public.role_definitions(org_id)
  WHERE org_id IS NOT NULL;

ALTER TABLE public.role_definitions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "role_definitions_select_all_authenticated" ON public.role_definitions;
CREATE POLICY "role_definitions_select_all_authenticated"
  ON public.role_definitions
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.role_definitions IS
  'Role bundle definitions (empty until 4.2 seeds the nine '
  'system presets). org_id IS NULL for global presets, non-NULL for '
  'org-local custom roles.';

-- ── role_capabilities ────────────────────────────────────────────────
-- Junction table: one row per (role, capability) grant.
CREATE TABLE IF NOT EXISTS public.role_capabilities (
  role_id        UUID NOT NULL REFERENCES public.role_definitions(id) ON DELETE CASCADE,
  capability_key TEXT NOT NULL REFERENCES public.capabilities(key) ON DELETE CASCADE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, capability_key)
);

CREATE INDEX IF NOT EXISTS idx_role_capabilities_capability
  ON public.role_capabilities(capability_key);

ALTER TABLE public.role_capabilities ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "role_capabilities_select_all_authenticated" ON public.role_capabilities;
CREATE POLICY "role_capabilities_select_all_authenticated"
  ON public.role_capabilities
  FOR SELECT TO authenticated
  USING (true);

COMMENT ON TABLE public.role_capabilities IS
  'Role-capability junction (empty until 4.2). Inserts '
  'happen in migrations, never at runtime for system presets; '
  'Advanced+ tier customs edit via RLS-gated writes added in 4.2.';

-- ── org_member_roles ─────────────────────────────────────────────────
-- Per-grant row linking a user to a role in a specific org. The legacy
-- plaintext role column lives on org_members; Phase 4.1 creates the
-- table fresh with role_definition_id as the sole role pointer
-- (per instructions: "DO NOT add a legacy role TEXT column — we're
-- creating fresh so no legacy to preserve").
--
-- Population is Phase 4.2+: the solo-user flow currently leans on
-- org_members.role. The switchover to capability-checked RLS will
-- backfill this table from org_members and, eventually, drop the
-- legacy role column from org_members.
CREATE TABLE IF NOT EXISTS public.org_member_roles (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_definition_id UUID NOT NULL REFERENCES public.role_definitions(id),
  granted_by         UUID REFERENCES auth.users(id),
  granted_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  UNIQUE (org_id, user_id, role_definition_id)
);

CREATE INDEX IF NOT EXISTS idx_org_member_roles_org_user_active
  ON public.org_member_roles(org_id, user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_org_member_roles_user
  ON public.org_member_roles(user_id)
  WHERE revoked_at IS NULL;

ALTER TABLE public.org_member_roles ENABLE ROW LEVEL SECURITY;

-- A user can see only their own grants for now. Phase 4.2 expands
-- this with a second policy that lets Admin/Owner list all grants in
-- their orgs for the role-editing UI.
DROP POLICY IF EXISTS "org_member_roles_select_own" ON public.org_member_roles;
CREATE POLICY "org_member_roles_select_own"
  ON public.org_member_roles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.org_member_roles IS
  'Phase 4.1: user-to-role grants (empty until 4.2 starts assigning). '
  'granted_by, expires_at, and revoked_at are populated by the invite '
  'and soft-revoke flows shipped in 4.3. Auditor role uses expires_at '
  'for the time-boxed access primitive.';

-- ── helper: user_has_capability ──────────────────────────────────────
-- SECURITY DEFINER so RLS policies on the 4.2 mutating-table rewrites
-- can call it from any org context without recursing through the
-- caller's own RLS. STABLE because it is a pure read within the
-- transaction. Returns FALSE (not NULL) when the user has no grant —
-- including the empty-table case we will live in until 4.2 seeds data.
CREATE OR REPLACE FUNCTION public.user_has_capability(
  p_user_id    UUID,
  p_capability TEXT,
  p_org_id     UUID
) RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.org_member_roles omr
    JOIN public.role_capabilities rc
      ON rc.role_id = omr.role_definition_id
    WHERE omr.user_id        = p_user_id
      AND omr.org_id         = p_org_id
      AND rc.capability_key  = p_capability
      AND omr.revoked_at IS NULL
      AND (omr.expires_at IS NULL OR omr.expires_at > now())
  );
$$;

COMMENT ON FUNCTION public.user_has_capability(UUID, TEXT, UUID) IS
  'Phase 4.1: capability check used by Phase 4.2 RLS. Empty-table safe '
  '(returns FALSE when no grants exist). SECURITY DEFINER so callers '
  'cannot starve themselves by lacking direct SELECT on the role '
  'tables.';
