-- ============================================================
-- OWB-T0210: catch up the migration history to the live schema.
-- ============================================================
-- Design reference: OWB-T0205 (accounts renamed to wallets, same pattern).
--
-- What actually happened, verified live 2026-09-23 on both OWB DEV
-- (kbjvvhjkaanvyibjezsv) and OWB PROD (mgnlerblrfetziusbjrt), via
-- information_schema, pg_indexes, pg_constraint and pg_policies:
--
--   - public.org_member_signing_key_wraps (created by
--     20260425000000_phase4_4_auditor_support_signing_key.sql) was
--     renamed to public.org_member_osk_wraps
--   - its primary key constraint org_member_signing_key_wraps_pkey became
--     org_member_osk_wraps_pkey
--   - its two foreign keys (org_id, user_id) were renamed to match
--   - its secondary index idx_org_member_signing_key_wraps_org became
--     idx_org_member_osk_wraps_org
--   - its RLS SELECT policy signing_key_wraps_select_own became
--     osk_wraps_select_own
--
-- None of that was ever recorded as a migration, so a fresh build that
-- replays every migration file in order would still land on the OLD
-- table name, while every application call site and edge function
-- (see OWB-T0210) queries the NEW one. This file is the missing
-- record.
--
-- It is a documented no-op on both live databases as of 2026-09-23 (both
-- already show the new names, 0 rows in the table on either database).
-- Every step below is individually guarded so it is also safe to run on:
--   - a fresh build, where the table still carries its original 20260425
--     name and this migration performs the real rename
--   - a database where only part of the rename was done by hand
--   - this same migration re-run any number of times
--
-- Idempotent: every statement is guarded. Running this migration twice,
-- or on a database already in either state, is a no-op.

BEGIN;

-- 1. The table itself.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'org_member_signing_key_wraps'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'org_member_osk_wraps'
  ) THEN
    ALTER TABLE public.org_member_signing_key_wraps RENAME TO org_member_osk_wraps;
  END IF;
END $$;

-- 2. Primary key constraint.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_member_signing_key_wraps_pkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_member_osk_wraps_pkey'
  ) THEN
    ALTER TABLE public.org_member_osk_wraps
      RENAME CONSTRAINT org_member_signing_key_wraps_pkey TO org_member_osk_wraps_pkey;
  END IF;
END $$;

-- 3. Foreign keys.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_member_signing_key_wraps_org_id_fkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_member_osk_wraps_org_id_fkey'
  ) THEN
    ALTER TABLE public.org_member_osk_wraps
      RENAME CONSTRAINT org_member_signing_key_wraps_org_id_fkey TO org_member_osk_wraps_org_id_fkey;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_member_signing_key_wraps_user_id_fkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'org_member_osk_wraps_user_id_fkey'
  ) THEN
    ALTER TABLE public.org_member_osk_wraps
      RENAME CONSTRAINT org_member_signing_key_wraps_user_id_fkey TO org_member_osk_wraps_user_id_fkey;
  END IF;
END $$;

-- 4. Secondary index. A plain index, not a constraint, so this needs
--    ALTER INDEX ... RENAME rather than ALTER TABLE ... RENAME CONSTRAINT.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'idx_org_member_signing_key_wraps_org'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'idx_org_member_osk_wraps_org'
  ) THEN
    ALTER INDEX public.idx_org_member_signing_key_wraps_org RENAME TO idx_org_member_osk_wraps_org;
  END IF;
END $$;

-- 5. RLS policy. DROP IF EXISTS + CREATE is idempotent by construction,
--    matching the pattern the rest of this migration set already uses
--    for policies, so no extra guard is needed here.
DROP POLICY IF EXISTS "signing_key_wraps_select_own" ON public.org_member_osk_wraps;
DROP POLICY IF EXISTS "osk_wraps_select_own" ON public.org_member_osk_wraps;
CREATE POLICY "osk_wraps_select_own"
  ON public.org_member_osk_wraps
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- 6. Table comment, matched to the live text verified on both databases
--    2026-09-23 (with an em dash normalized to a colon; no functional
--    change). COMMENT ON is always idempotent, no guard needed.
COMMENT ON TABLE public.org_member_osk_wraps IS
  'Phase 4.4: per-writer wrapped private half of the Org Signing Key. '
  'Hybrid-KEM wrapped to the recipient''s user_vault_keys public key. '
  'Auditor and Viewer members never have a row here: that is the '
  'cryptographic read-only enforcement (OSK never issued). RLS SELECT '
  'is scoped to the recipient so nobody else can fetch another user''s '
  'wrapped signing key even over an admin API.';

COMMIT;
