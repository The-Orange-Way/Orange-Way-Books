-- withdrawal_consents: an append-only record of the express consent a user gives
-- to start the service immediately and thereby lose the 14 day withdrawal right.
--
-- Legal purpose: the EU/UK Consumer Rights Directive requires express prior
-- consent plus an acknowledgement that the right is lost. This table is the
-- evidence. It is server readable legal metadata by design. It holds no key
-- material, no seed, no derived intermediate, and no ledger content, so it does
-- not touch the zero knowledge surface.
--
-- Idempotent: every statement is guarded, so a re-run is a no-op.
--
-- Rollback (in this order):
--   DROP TRIGGER IF EXISTS withdrawal_consents_no_mutation ON public.withdrawal_consents;
--   DROP FUNCTION IF EXISTS public.withdrawal_consents_block_mutation();
--   DROP TABLE IF EXISTS public.withdrawal_consents;

CREATE TABLE IF NOT EXISTS public.withdrawal_consents (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Deliberately NOT a foreign key to auth.users. A FK with ON DELETE CASCADE
  -- would erase the evidence when the account is deleted, and a cascade is not
  -- subject to RLS or to the revoked DELETE grant below. Retention after account
  -- deletion is a legal decision, not a schema default.
  user_id          uuid        NOT NULL,

  -- The subscription the consent was given for, when one exists at tick time.
  -- Nullable and unconstrained for the same reason as user_id.
  subscription_id  uuid        NULL,

  -- The row exists only because the box was ticked. False is not a state.
  consent_flag     boolean     NOT NULL DEFAULT true,

  -- The exact label the user saw, captured from the rendered string at tick
  -- time. If this can drift from what was displayed, the record is not evidence.
  consent_text     text        NOT NULL,

  -- Which version of the terms was in force when the box was ticked.
  terms_version    text        NOT NULL,

  consented_at     timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT withdrawal_consents_flag_must_be_true
    CHECK (consent_flag = true),
  CONSTRAINT withdrawal_consents_text_not_blank
    CHECK (length(btrim(consent_text)) > 0),
  CONSTRAINT withdrawal_consents_version_not_blank
    CHECK (length(btrim(terms_version)) > 0)
);

CREATE INDEX IF NOT EXISTS withdrawal_consents_user_id_idx
  ON public.withdrawal_consents (user_id);

CREATE INDEX IF NOT EXISTS withdrawal_consents_subscription_id_idx
  ON public.withdrawal_consents (subscription_id)
  WHERE subscription_id IS NOT NULL;

-- Append only, layer 1: no client may write, and nobody may edit or erase.
-- The server side insert path runs as service_role, which bypasses RLS.
ALTER TABLE public.withdrawal_consents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.withdrawal_consents FROM anon, authenticated;
GRANT SELECT ON public.withdrawal_consents TO authenticated;

DROP POLICY IF EXISTS withdrawal_consents_select_own ON public.withdrawal_consents;
CREATE POLICY withdrawal_consents_select_own
  ON public.withdrawal_consents
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- No INSERT, UPDATE or DELETE policy exists, and none should. A client cannot
-- write this table at all.

-- Append only, layer 2: a mutation raises no matter which role attempts it,
-- including the service role that does the insert. Removing a row is then a
-- deliberate, reviewed migration, never a stray statement or a cascade.
CREATE OR REPLACE FUNCTION public.withdrawal_consents_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION
    'withdrawal_consents is append only: % is not permitted on this table',
    TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS withdrawal_consents_no_mutation ON public.withdrawal_consents;
CREATE TRIGGER withdrawal_consents_no_mutation
  BEFORE UPDATE OR DELETE ON public.withdrawal_consents
  FOR EACH ROW
  EXECUTE FUNCTION public.withdrawal_consents_block_mutation();

COMMENT ON TABLE public.withdrawal_consents IS
  'Append only evidence that a user expressly consented to immediate service start and acknowledged losing the 14 day withdrawal right. Server readable legal metadata. No key material.';
COMMENT ON COLUMN public.withdrawal_consents.consent_text IS
  'The exact label rendered to the user at tick time. Never a second hardcoded copy.';
