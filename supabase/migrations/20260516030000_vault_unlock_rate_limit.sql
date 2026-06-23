-- S10, Vault unlock rate-limit RPC
--
-- The client already logs every unlock attempt (success or failure) to
-- public.vault_security_events via the logSecurityEvent helper:
--   • 'vault_unlock'         on success
--   • 'vault_unlock_failed'  on bad-password attempt
--
-- This migration adds a SECURITY DEFINER RPC `check_vault_unlock_rate_limit`
-- the client can call BEFORE attempting an unlock. It returns the recent
-- failure count + the next allowed-attempt timestamp + a boolean ok flag.
--
-- Policy: 5 failed attempts in a 15-minute rolling window → rate-limited.
-- The 6th attempt is blocked until 15 minutes have passed since the FIRST
-- failure in the window (sliding cooldown).
--
-- A successful unlock counts as "ok", the client should call this AFTER
-- every wrong-password attempt as well as before each attempt; the RPC
-- itself is read-only, so calling it during normal use is cheap.
--
-- Surfaced by 2026-05-16 security review. Tracked as S10.

CREATE OR REPLACE FUNCTION public.check_vault_unlock_rate_limit()
RETURNS TABLE (
  ok            BOOLEAN,
  failed_count  INTEGER,
  window_minutes INTEGER,
  cooldown_until TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id        UUID := auth.uid();
  v_window_min     INTEGER := 15;
  v_max_failures   INTEGER := 5;
  v_failed_count   INTEGER;
  v_first_failure  TIMESTAMPTZ;
  v_cooldown_until TIMESTAMPTZ;
BEGIN
  IF v_user_id IS NULL THEN
    -- Not authenticated → nothing to gate; bubble up via ok=false so the
    -- client treats this as a no-op rather than a free pass.
    RETURN QUERY SELECT FALSE, 0, v_window_min, NULL::timestamptz;
    RETURN;
  END IF;

  -- Count failures inside the rolling window for this user.
  SELECT COUNT(*), MIN(created_at)
    INTO v_failed_count, v_first_failure
    FROM public.vault_security_events
   WHERE user_id = v_user_id
     AND event = 'vault_unlock_failed'
     AND created_at >= (now() - (v_window_min | ' minutes')::interval);

  IF v_failed_count >= v_max_failures AND v_first_failure IS NOT NULL THEN
    v_cooldown_until := v_first_failure + (v_window_min | ' minutes')::interval;
    RETURN QUERY SELECT FALSE, v_failed_count, v_window_min, v_cooldown_until;
  ELSE
    RETURN QUERY SELECT TRUE, COALESCE(v_failed_count, 0), v_window_min, NULL::timestamptz;
  END IF;
END;
$$;

GRANT EXECUTE ON FUNCTION public.check_vault_unlock_rate_limit() TO authenticated;

COMMENT ON FUNCTION public.check_vault_unlock_rate_limit() IS
  'S10: returns rate-limit status for the caller''s vault unlock attempts. '
  '5 failed attempts within a 15-minute rolling window triggers the gate. '
  'Reads vault_security_events (event=vault_unlock_failed) for the caller '
  'via auth.uid(). SECURITY DEFINER so the function can read the table '
  'without exposing per-row RLS to the client.';

-- Index supporting the lookup. Filters by user_id + event type + recency.
CREATE INDEX IF NOT EXISTS idx_vault_security_events_unlock_attempts
  ON public.vault_security_events (user_id, event, created_at DESC)
  WHERE event IN ('vault_unlock', 'vault_unlock_failed');
