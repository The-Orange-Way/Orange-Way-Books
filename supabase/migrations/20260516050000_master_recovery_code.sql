-- S14, Multi-org master recovery code
--
-- Today every (user, org) has its own recovery code (12-word BIP-39).
-- A user with N orgs has to keep track of N codes; lose any one of
-- them and that org's data is unrecoverable. This migration adds an
-- optional MASTER recovery code per user that, when set up, unlocks
-- every org the user is currently a member of with a single code.
--
-- Design:
--   • One per-user 32-byte random salt + a "verifier" envelope (so we
--     can confirm a typed code matches the user's master) stored in
--     public.user_master_recovery (one row per user).
--   • For each (user, org) where master recovery is enabled, store
--     org_master_wraps.wrapped_mek_under_master_kek, the org's MEK
--     wrapped under a master-KEK derived from the master code.
--   • Recovery flow on the client:
--       1. Enter master code → derive master KEK (HKDF over normalized
--          12-word phrase, salt = user_master_recovery.master_salt).
--       2. Decrypt verifier → confirm code is correct.
--       3. For each membership, query org_master_wraps, unwrap MEK,
--          re-wrap under a fresh password the user picks.
--       4. Generate fresh per-org recovery codes too (old ones consumed).
--
-- ZKA: nothing here weakens the model, the master code lives only in
-- the browser, the salt is non-sensitive, the verifier + wraps are
-- ciphertext the server can't read.
--
-- This migration only adds the schema. Client logic + UI ship in
-- separate commits. Surfaced by 2026-05-16 security review.
-- Tracked as S14.

-- ── Per-user master record ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.user_master_recovery (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  master_salt TEXT NOT NULL,             -- base64(32 random bytes), public
  master_verifier_ciphertext TEXT NOT NULL,  -- AES-GCM blob proving code correctness
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ NULL,           -- last rotation time
  key_version INT NOT NULL DEFAULT 1
);

ALTER TABLE public.user_master_recovery ENABLE ROW LEVEL SECURITY;

-- A user can fully manage their own master record. No one else can see it.
CREATE POLICY "user_master_recovery_select_self" ON public.user_master_recovery
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "user_master_recovery_insert_self" ON public.user_master_recovery
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_master_recovery_update_self" ON public.user_master_recovery
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "user_master_recovery_delete_self" ON public.user_master_recovery
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.user_master_recovery IS
  'S14: per-user master recovery code. Stores only ciphertext + salt, the master code itself is shown once at setup and never persisted.';
COMMENT ON COLUMN public.user_master_recovery.master_salt IS
  'Base64 of 32 random bytes. Used as HKDF salt for the master KEK derivation. Not sensitive.';
COMMENT ON COLUMN public.user_master_recovery.master_verifier_ciphertext IS
  'AES-GCM ciphertext of a fixed verifier string under the master KEK. Decrypt = code correct. Server cannot read.';

-- ── Per-(user, org) master wrap ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.org_master_wraps (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  master_wrapped_mek TEXT NOT NULL,      -- AES-GCM(MEK, master_KEK)
  key_version INT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);

ALTER TABLE public.org_master_wraps ENABLE ROW LEVEL SECURITY;

-- A user can manage only their own wraps, and only for orgs they're
-- currently a member of. The org-membership check protects against a
-- revoked user re-inserting a stale wrap row to a still-existing
-- master_recovery record after they've been kicked out.
CREATE POLICY "org_master_wraps_select_self" ON public.org_master_wraps
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "org_master_wraps_insert_self" ON public.org_master_wraps
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
  );

CREATE POLICY "org_master_wraps_update_self" ON public.org_master_wraps
  FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    AND org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
  )
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
  );

CREATE POLICY "org_master_wraps_delete_self" ON public.org_master_wraps
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

COMMENT ON TABLE public.org_master_wraps IS
  'S14: per (user, org) wrap of the org MEK under the user master recovery KEK. Lets a single master code unwrap MEKs across all the user''s orgs.';

-- ── S12 cleanup extended ──────────────────────────────────────────────
-- When a user's last active role in an org is revoked, the D9 trigger
-- already drops org_keys, period_unlock_sessions, and org_member_signing_key_wraps.
-- Extend it once more to drop org_master_wraps so a revoked user can't
-- decrypt that org's MEK via their master code anymore.

CREATE OR REPLACE FUNCTION public.enforce_last_role_removal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active_count INTEGER;
  v_user_id      UUID;
  v_org_id       UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
    v_org_id  := OLD.org_id;
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
      RETURN NULL;
    END IF;
    v_user_id := NEW.user_id;
    v_org_id  := NEW.org_id;
  ELSE
    RETURN NULL;
  END IF;

  SELECT COUNT(*) INTO v_active_count
    FROM public.org_member_roles
   WHERE user_id = v_user_id
     AND org_id  = v_org_id
     AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > now());

  IF v_active_count = 0 THEN
    DELETE FROM public.org_keys                WHERE user_id = v_user_id AND org_id = v_org_id;
    DELETE FROM public.period_unlock_sessions  WHERE user_id = v_user_id AND org_id = v_org_id;
    DELETE FROM public.org_member_signing_key_wraps    WHERE user_id = v_user_id AND org_id = v_org_id;
    DELETE FROM public.org_master_wraps        WHERE user_id = v_user_id AND org_id = v_org_id;

    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (
      v_user_id,
      'org_access_revoked',
      jsonb_build_object(
        'org_id',   v_org_id,
        'trigger',  TG_OP,
        'reason',   'last_active_role_removed',
        'cleanup',  jsonb_build_array('org_keys', 'period_unlock_sessions', 'org_member_signing_key_wraps', 'org_master_wraps')
      )
    );
  END IF;

  RETURN NULL;
END;
$$;
