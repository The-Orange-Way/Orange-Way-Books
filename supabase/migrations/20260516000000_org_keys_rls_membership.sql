-- S1 — Fix org_keys UPDATE / DELETE RLS to require active org membership
--
-- Background
-- ──────────
-- The original org_keys policies (from 20260416110000 and the idempotent
-- backfill in 20260417130000) gated SELECT and INSERT on both
-- `user_id = auth.uid()` AND membership in `org_members`. UPDATE and DELETE,
-- however, were gated on `user_id = auth.uid()` ONLY.
--
-- This creates a defense-in-depth gap: a user whose role is revoked still
-- holds a valid Supabase JWT for the remainder of their session lifetime
-- (typically up to 1 hour). During that window they could:
--   • UPDATE their wrapped_dek to a malformed blob, corrupting the DEK wrap
--     so subsequent admins can't unwrap it (DoS against the org)
--   • DELETE their org_keys row outright before the D9 revocation trigger
--     has finalized cleanup
--
-- The D9 trigger (enforce_last_role_removal) deletes org_keys on the
-- "last active role revoked" event, but that runs *after* role revocation;
-- the attack window is the gap between revocation and key drop.
--
-- Fix: require both `user_id = auth.uid()` AND active membership in
-- `org_members` for both UPDATE and DELETE, matching the SELECT/INSERT
-- pattern. A revoked user no longer satisfies the EXISTS check, so the
-- write is blocked regardless of token validity.
--
-- This is idempotent: DROP POLICY IF EXISTS + CREATE POLICY.
--
-- Refs:
--   • Security review 2026-05-16 — finding E.1 (CRITICAL)
--   • Earlier policies: supabase/migrations/20260416110000_org_keys.sql
--                       supabase/migrations/20260417130000_idempotent_schema_backfill.sql

DROP POLICY IF EXISTS "org_keys_update_own" ON public.org_keys;
CREATE POLICY "org_keys_update_own" ON public.org_keys FOR UPDATE TO authenticated
  USING (
    user_id = auth.uid()
    AND org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
  )
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "org_keys_delete_own" ON public.org_keys;
CREATE POLICY "org_keys_delete_own" ON public.org_keys FOR DELETE TO authenticated
  USING (
    user_id = auth.uid()
    AND org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
  );
