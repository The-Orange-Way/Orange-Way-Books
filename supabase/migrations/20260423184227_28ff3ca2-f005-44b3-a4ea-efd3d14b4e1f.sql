BEGIN;

ALTER TABLE public.org_keys
  ADD COLUMN IF NOT EXISTS wrap_algo TEXT;

UPDATE public.org_keys
   SET wrap_algo = 'v3-self-mek'
 WHERE wrap_algo IS NULL;

COMMENT ON COLUMN public.org_keys.wrap_algo IS
  'Wrap strategy identifier (e.g. hybrid-x25519-mlkem768). '
  'Rows pre-Phase 4.3 carry v3-self-mek (solo-user self-wrap). '
  'Phase 4.3+ invite flows write the per-recipient hybrid wrap strategy.';

CREATE TABLE IF NOT EXISTS public.pending_invites (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email               TEXT NOT NULL,
  role_definition_id  UUID NOT NULL REFERENCES public.role_definitions(id),
  inviter_id          UUID NOT NULL REFERENCES auth.users(id),
  recipient_user_id   UUID REFERENCES auth.users(id),
  status              TEXT NOT NULL DEFAULT 'awaiting_recipient'
                      CHECK (status IN ('awaiting_recipient','ready_to_wrap','wrapped','cancelled','expired')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

CREATE INDEX IF NOT EXISTS idx_pending_invites_status_org
  ON public.pending_invites(org_id, status);

CREATE INDEX IF NOT EXISTS idx_pending_invites_email
  ON public.pending_invites(lower(email))
  WHERE status IN ('awaiting_recipient', 'ready_to_wrap');

ALTER TABLE public.pending_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pending_invites_select_inviters" ON public.pending_invites;
CREATE POLICY "pending_invites_select_inviters"
  ON public.pending_invites
  FOR SELECT TO authenticated
  USING (public.user_has_capability(auth.uid(), 'users.invite', org_id));

DROP POLICY IF EXISTS "pending_invites_update_inviters" ON public.pending_invites;
CREATE POLICY "pending_invites_update_inviters"
  ON public.pending_invites
  FOR UPDATE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'users.invite', org_id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'users.invite', org_id));

CREATE OR REPLACE FUNCTION public.touch_pending_invites_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pending_invites_updated_at ON public.pending_invites;
CREATE TRIGGER trg_pending_invites_updated_at
  BEFORE UPDATE ON public.pending_invites
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_pending_invites_updated_at();

COMMENT ON TABLE public.pending_invites IS
  'Invite rows awaiting the recipient to publish a keypair, '
  'then awaiting the Owner''s client to complete the hybrid-KEM wrap. '
  'Lifecycle: awaiting_recipient -> ready_to_wrap -> wrapped.';

COMMENT ON COLUMN public.pending_invites.recipient_user_id IS
  'Populated once the recipient exists in auth.users. NULL when the '
  'invite email pre-dates recipient signup.';

DROP POLICY IF EXISTS "user_vault_keys_select_for_inviters" ON public.user_vault_keys;
CREATE POLICY "user_vault_keys_select_for_inviters"
  ON public.user_vault_keys
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.org_members om
       WHERE om.user_id = public.user_vault_keys.user_id
         AND public.user_has_capability(auth.uid(), 'users.invite', om.org_id)
    )
    OR EXISTS (
      SELECT 1
        FROM public.pending_invites pi
       WHERE pi.recipient_user_id = public.user_vault_keys.user_id
         AND public.user_has_capability(auth.uid(), 'users.invite', pi.org_id)
    )
  );

CREATE OR REPLACE FUNCTION public.link_pending_invites_on_keypair_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_inviter_id UUID;
  v_org_id UUID;
BEGIN
  SELECT LOWER(email) INTO v_email
    FROM auth.users
   WHERE id = NEW.user_id;

  IF v_email IS NULL THEN
    RETURN NEW;
  END IF;

  FOR v_inviter_id, v_org_id IN
    UPDATE public.pending_invites
       SET status = 'ready_to_wrap',
           recipient_user_id = NEW.user_id
     WHERE LOWER(email) = v_email
       AND status = 'awaiting_recipient'
       AND expires_at > now()
   RETURNING inviter_id, org_id
  LOOP
    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (
      v_inviter_id,
      'user.wrap_ready',
      jsonb_build_object(
        'org_id',            v_org_id,
        'recipient_user_id', NEW.user_id,
        'source',            'keypair_insert_trigger'
      )
    );
  END LOOP;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.link_pending_invites_on_keypair_insert() IS
  'Phase 4.3: AFTER INSERT on user_vault_keys, transition matching '
  'pending_invites rows from awaiting_recipient to ready_to_wrap. '
  'SECURITY DEFINER so the recipient cannot influence invite status '
  'directly; trigger only runs on new keypair rows that the owner '
  'of the row inserted via the standard user_vault_keys_insert_own '
  'policy.';

DROP TRIGGER IF EXISTS trg_link_pending_invites_on_keypair ON public.user_vault_keys;
CREATE TRIGGER trg_link_pending_invites_on_keypair
  AFTER INSERT ON public.user_vault_keys
  FOR EACH ROW
  EXECUTE FUNCTION public.link_pending_invites_on_keypair_insert();

COMMIT;