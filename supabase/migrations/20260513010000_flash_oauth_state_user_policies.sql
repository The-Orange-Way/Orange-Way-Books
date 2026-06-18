-- ============================================================
-- Flash Wave 1 — allow authenticated users to insert + select
-- their own flash_oauth_state rows.
-- ============================================================
-- The scaffold migration created flash_oauth_state with RLS enabled
-- and zero policies (service-role only). The frontend Admin > Flash
-- page needs to insert a state row before redirecting to the OAuth
-- authorize URL, so without a user-scoped INSERT policy the click
-- fails with "new row violates row-level security policy".
--
-- Fix: allow authenticated users to insert + select rows where
-- user_id = auth.uid(). The edge function continues to use the
-- service role (which bypasses RLS) for the post-callback validation
-- + cleanup.

BEGIN;

DROP POLICY IF EXISTS "flash_oauth_state_insert_own"
  ON public.flash_oauth_state;
CREATE POLICY "flash_oauth_state_insert_own"
  ON public.flash_oauth_state
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "flash_oauth_state_select_own"
  ON public.flash_oauth_state;
CREATE POLICY "flash_oauth_state_select_own"
  ON public.flash_oauth_state
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

COMMIT;
