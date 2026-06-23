-- emit_self_notification, security-definer RPC that lets an
-- authenticated user write a notification for themselves.
--
-- The notifications table has default-deny INSERT for authenticated
-- users (only service-role writes). That's the right default for
-- system events emitted by edge functions and cron, but the client
-- has its own legitimate self-emit cases:
--
--   - "Import completed" after the import wizard finishes
--   - "Backup downloaded" after a takeout export
--   - "Re-import preview saved" etc.
--
-- This function lets the client write to its own inbox without
-- relaxing the table policy for all rows. The function:
--
--   1. Verifies the caller is authenticated (auth.uid() is not null)
--   2. Verifies the caller is an active member of p_org_id
--   3. Inserts a notification row scoped to the caller's user_id
--      (the client cannot impersonate another user)
--
-- Side-channel risks (deliberately scoped down):
--   - A user could spam their OWN bell. Cost is UI noise affecting
--     only themselves. Frontend should rate-limit per page.
--   - A user CANNOT write to another user's inbox. The function
--     never accepts a user_id parameter, it derives from auth.uid().

CREATE OR REPLACE FUNCTION public.emit_self_notification(
  p_org_id      UUID,
  p_kind        TEXT,
  p_body        TEXT,
  p_action_href TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_id      UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.org_members
    WHERE org_id = p_org_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Not a member of this organization';
  END IF;

  INSERT INTO public.notifications (org_id, user_id, kind, body, action_href)
  VALUES (p_org_id, v_user_id, p_kind, p_body, p_action_href)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- The function runs as definer (owner = db_owner) so it can bypass
-- the INSERT RLS on notifications. The RAISE EXCEPTIONs above stop
-- abuse, without an authenticated session + org membership the
-- caller gets nothing.
COMMENT ON FUNCTION public.emit_self_notification IS
  'Write a notification to your own inbox. Verifies auth + org membership before insert. Cannot write to another user''s inbox (user_id is auth.uid() only).';

GRANT EXECUTE ON FUNCTION public.emit_self_notification(UUID, TEXT, TEXT, TEXT) TO authenticated;
