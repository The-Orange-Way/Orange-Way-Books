-- withdrawal_consents v2: forward delta on 20260713120000.
--
-- 20260713120000 is already applied on DEV and the table is live with zero
-- rows, so this migration carries the delta only. Do not edit that file.
--
-- Three changes:
--   1. Drop consent_flag and its CHECK. The column was constrained to true and
--      could never carry information.
--   2. Add expires_at, set server side at insert to consented_at + 5 years
--      (PSD2 Art. 43 and the AML floor). Never accepted from the caller, and
--      neither is the consented_at it is derived from: both are pinned to the
--      server clock, so the retention clock cannot be chosen by a writer.
--   3. Rewrite the append only trigger so the retention job can delete an
--      expired row, and only an expired row. Everything else still raises.
--
-- Idempotent: every statement is guarded, so a re-run is a no-op.
--
-- Rollback (in this order):
--   DROP TRIGGER IF EXISTS withdrawal_consents_set_expiry ON public.withdrawal_consents;
--   DROP FUNCTION IF EXISTS public.withdrawal_consents_set_expiry();
--   DROP INDEX IF EXISTS public.withdrawal_consents_expires_at_idx;
--   ALTER TABLE public.withdrawal_consents DROP COLUMN IF EXISTS expires_at;
--   ALTER TABLE public.withdrawal_consents
--     ADD COLUMN IF NOT EXISTS consent_flag boolean NOT NULL DEFAULT true;
--   ALTER TABLE public.withdrawal_consents
--     ADD CONSTRAINT withdrawal_consents_flag_must_be_true CHECK (consent_flag = true);
--   (then restore the unconditional body of withdrawal_consents_block_mutation)

-- 1. The flag that could only ever be true.
ALTER TABLE public.withdrawal_consents
  DROP CONSTRAINT IF EXISTS withdrawal_consents_flag_must_be_true;

ALTER TABLE public.withdrawal_consents
  DROP COLUMN IF EXISTS consent_flag;

-- 2. The retention clock. Added in three steps so it is correct whether the
-- table is empty or already holds rows: add the column nullable, backfill each
-- existing row from its own consented_at, then enforce NOT NULL. On an empty
-- table (DEV) the backfill touches nothing, so DEV behaviour is unchanged. A
-- bare NOT NULL add with no default only succeeds on an empty table, which is
-- not a migration. The v1 append-only trigger raises on any UPDATE, so it is
-- disabled for the single server-side backfill and re-enabled immediately; DDL
-- is transactional, so a mid-migration failure rolls the disable back. Every
-- future write still gets expires_at from the BEFORE INSERT trigger below, so
-- no caller ever supplies it.
ALTER TABLE public.withdrawal_consents
  ADD COLUMN IF NOT EXISTS expires_at timestamptz;

ALTER TABLE public.withdrawal_consents
  DISABLE TRIGGER withdrawal_consents_no_mutation;

UPDATE public.withdrawal_consents
  SET expires_at = consented_at + interval '5 years'
  WHERE expires_at IS NULL;

ALTER TABLE public.withdrawal_consents
  ENABLE TRIGGER withdrawal_consents_no_mutation;

ALTER TABLE public.withdrawal_consents
  ALTER COLUMN expires_at SET NOT NULL;

COMMENT ON COLUMN public.withdrawal_consents.expires_at IS
  'When this evidence may be deleted: consented_at + 5 years. Set server side at insert. A value supplied by the caller is overwritten.';

COMMENT ON COLUMN public.withdrawal_consents.consented_at IS
  'When the consent was recorded. Pinned to the server clock at insert. A value supplied by the caller is overwritten, because expires_at is derived from it.';

CREATE INDEX IF NOT EXISTS withdrawal_consents_expires_at_idx
  ON public.withdrawal_consents (expires_at);

-- Both assignments are unconditional on purpose. consented_at is an ordinary
-- column with a default, so a caller could otherwise supply its own value and
-- thereby choose the row's expiry: a consented_at backdated past the retention
-- window would produce a row born already deletable. The retention clock has to
-- be a server fact end to end, so the timestamp it derives from is pinned here
-- too, before expires_at is computed.
CREATE OR REPLACE FUNCTION public.withdrawal_consents_set_expiry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  NEW.consented_at := pg_catalog.now();
  NEW.expires_at := NEW.consented_at + interval '5 years';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS withdrawal_consents_set_expiry ON public.withdrawal_consents;
CREATE TRIGGER withdrawal_consents_set_expiry
  BEFORE INSERT ON public.withdrawal_consents
  FOR EACH ROW
  EXECUTE FUNCTION public.withdrawal_consents_set_expiry();

-- 3. Append only, with one carve out: the retention job may delete a row whose
-- clock has run out. An UPDATE always raises. A DELETE of a live row always
-- raises. There is still no INSERT, UPDATE or DELETE policy for any client
-- role, so this path is reachable only by the service role that runs retention.
CREATE OR REPLACE FUNCTION public.withdrawal_consents_block_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.expires_at < pg_catalog.now() THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    'withdrawal_consents is append only: % is not permitted on this table (DELETE is allowed only on a row past expires_at)',
    TG_OP;
END;
$$;

-- The trigger definition is unchanged (BEFORE UPDATE OR DELETE), but it is
-- recreated so a re-run of this file always binds the new function body.
DROP TRIGGER IF EXISTS withdrawal_consents_no_mutation ON public.withdrawal_consents;
CREATE TRIGGER withdrawal_consents_no_mutation
  BEFORE UPDATE OR DELETE ON public.withdrawal_consents
  FOR EACH ROW
  EXECUTE FUNCTION public.withdrawal_consents_block_mutation();
