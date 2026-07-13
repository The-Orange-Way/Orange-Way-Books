-- withdrawal_consents, retention and the single append only carve out.
--
-- Follow up to 20260713120000_withdrawal_consents.sql. Three changes:
--   1. expires_at, generated, always consented_at + 5 years. The retention clock.
--   2. consent_flag dropped. A column CHECK constrained to true forever holds no
--      information. The row existing is the consent.
--   3. The append only trigger gains exactly one carve out, so that a row whose
--      retention period has genuinely elapsed can be deleted and nothing else can.
--
-- The 5 year period is the confirmed retention floor for this record class.
--
-- Idempotent: every statement is guarded, so a re-run is a no-op.
--
-- Rollback (in this order):
--   CREATE OR REPLACE FUNCTION public.withdrawal_consents_block_mutation() ... -- the absolute form from 20260713120000
--   DROP INDEX IF EXISTS public.withdrawal_consents_expires_at_idx;
--   ALTER TABLE public.withdrawal_consents DROP COLUMN IF EXISTS expires_at;
--   ALTER TABLE public.withdrawal_consents
--     ADD COLUMN IF NOT EXISTS consent_flag boolean NOT NULL DEFAULT true;
--   ALTER TABLE public.withdrawal_consents
--     ADD CONSTRAINT withdrawal_consents_flag_must_be_true CHECK (consent_flag = true);
--
-- Nothing here can lose evidence. consent_flag can only ever be true, so dropping
-- it discards no information, and re-adding it restores every row to true.

-- 1. Drop the column that cannot carry information.
ALTER TABLE public.withdrawal_consents
  DROP CONSTRAINT IF EXISTS withdrawal_consents_flag_must_be_true;

ALTER TABLE public.withdrawal_consents
  DROP COLUMN IF EXISTS consent_flag;

-- 2. The retention clock, generated, not supplied.
--
-- expires_at is the predicate the retention sweep deletes on. It is GENERATED
-- ALWAYS so that no insert path, and no application bug, can hand the database a
-- retention date of its own choosing. A forgeable expiry on an append only
-- evidence table would make a row deletable years before its time.
--
-- Why the timezone() wrapping rather than the obvious (consented_at + INTERVAL
-- '5 years'): a generated expression must be IMMUTABLE, and timestamptz plus
-- interval is only STABLE, because the arithmetic reads the session TimeZone.
-- Postgres rejects the naive form outright (42P17, generation expression is not
-- immutable). Anchoring both conversions to UTC makes the expression immutable.
-- Verified on the dev database: consented_at 2026-07-13 12:00:00+00 yields
-- expires_at 2031-07-13 12:00:00+00.
ALTER TABLE public.withdrawal_consents
  ADD COLUMN IF NOT EXISTS expires_at timestamptz
    NOT NULL
    GENERATED ALWAYS AS (
      timezone('UTC', timezone('UTC', consented_at) + INTERVAL '5 years')
    ) STORED;

CREATE INDEX IF NOT EXISTS withdrawal_consents_expires_at_idx
  ON public.withdrawal_consents (expires_at);

-- 3. Append only, with one carve out and no other.
--
-- As it stood, this function raised on DELETE for every role, including the
-- service role a retention sweep runs as. That is not append only, it is keep
-- forever, and at year five keeping forever is itself the breach.
--
-- The carve out is deliberately narrow. DELETE passes only when the row's own
-- generated expires_at is already in the past. UPDATE always raises. A DELETE of
-- a row still inside its retention window always raises. Because expires_at is
-- generated rather than supplied, the predicate cannot be forged upstream.
CREATE OR REPLACE FUNCTION public.withdrawal_consents_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.expires_at < now() THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'withdrawal_consents is append only: % is not permitted on this table (retention deletes are permitted only once expires_at has passed)',
    TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS withdrawal_consents_no_mutation ON public.withdrawal_consents;
CREATE TRIGGER withdrawal_consents_no_mutation
  BEFORE UPDATE OR DELETE ON public.withdrawal_consents
  FOR EACH ROW
  EXECUTE FUNCTION public.withdrawal_consents_block_mutation();

COMMENT ON COLUMN public.withdrawal_consents.expires_at IS
  'Generated, always consented_at + 5 years. The retention clock, and the only condition under which a row may be deleted. Never supplied by the insert path, so it cannot be forged.';
