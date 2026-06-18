-- S12 — Extend D9 last-role-removal trigger to clean up stale rows
--
-- The last-role-removal trigger `enforce_last_role_removal()` already deletes
-- the user's `org_keys` row when their last active role in an org is
-- revoked, and writes a `vault_security_events` audit. Two adjacent
-- tables hold equivalent per-(user,org) access material that should
-- also be dropped at the same moment:
--
--   • period_unlock_sessions — temporary unlock windows for closed
--     periods. A stale row here doesn't grant write access on its own
--     (RLS still requires capability), but it gives a revoked user a
--     "valid" unlock context referenced by audit logs and downstream
--     period-lock checks. Safer to drop.
--
--   • org_member_signing_key_wraps — the user's wrap of the Org Signing Key.
--     With the wrap in place, a revoked user with a still-valid token
--     could load + use the signing key. The D9 cleanup removed their org_keys
--     wrap (so DEK is gone), but the signing-key wrap survived — leaving a
--     small window where they could still sign payment mutations or
--     other signing-key-gated operations. Drop the wrap as part of the same
--     atomic cleanup so signing capability dies with the role.
--
-- Implementation: redefine `enforce_last_role_removal()` to add two
-- DELETEs alongside the existing org_keys cleanup. SECURITY DEFINER
-- already lets the trigger cross policy boundaries. No new RLS or
-- column changes needed.
--
-- Surfaced by 2026-05-16 security review (findings E.3 + E.4).
-- Tracked as S12.

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
  -- Identify the affected user + org from the row being changed.
  -- For DELETE we read OLD; for UPDATE we read OLD (revoked row was OLD
  -- active, NEW revoked) and also check NEW to confirm this is a
  -- revocation event (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL).
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

  -- Count remaining active grants for this (user, org).
  SELECT COUNT(*) INTO v_active_count
    FROM public.org_member_roles
   WHERE user_id = v_user_id
     AND org_id  = v_org_id
     AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > now());

  IF v_active_count = 0 THEN
    -- Drop the DEK wrap.
    DELETE FROM public.org_keys
     WHERE user_id = v_user_id
       AND org_id  = v_org_id;

    -- S12: drop any active period unlock session this user had for this
    -- org. They can't reopen a locked period anymore; the row should
    -- not linger as referenced state.
    DELETE FROM public.period_unlock_sessions
     WHERE user_id = v_user_id
       AND org_id  = v_org_id;

    -- S12: drop the signing-key wrap so a revoked user can't sign mutations
    -- with the org's signing key even within the residual token window.
    DELETE FROM public.org_member_signing_key_wraps
     WHERE user_id = v_user_id
       AND org_id  = v_org_id;

    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (
      v_user_id,
      'org_access_revoked',
      jsonb_build_object(
        'org_id',   v_org_id,
        'trigger',  TG_OP,
        'reason',   'last_active_role_removed',
        'cleanup',  jsonb_build_array('org_keys', 'period_unlock_sessions', 'org_member_signing_key_wraps')
      )
    );
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.enforce_last_role_removal() IS
  'Last-role-removal cleanup: on last-active-role removal for a (user, org), '
  'drop the org_keys wrap, the period unlock session, and the signing-key wrap, then '
  'audit the event. Fires AFTER UPDATE (revocation) and AFTER DELETE on '
  'org_member_roles. SECURITY DEFINER to cross policy boundaries.';
