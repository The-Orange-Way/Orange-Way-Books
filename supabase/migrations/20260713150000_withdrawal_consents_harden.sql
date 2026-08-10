-- withdrawal_consents hardening: make the append only guarantee hold under
-- every replication role, and block TRUNCATE.
--
-- Context: 20260713120000 and 20260713130000_v2 are applied on DEV. Both the
-- set_expiry (BEFORE INSERT) and no_mutation (BEFORE UPDATE OR DELETE) triggers
-- were created with the default ENABLE ORIGIN (tgenabled = 'O'), so they do NOT
-- fire when the session runs as replica (logical replication apply, and any
-- session_replication_role = replica path). Row level triggers also never fire
-- on TRUNCATE, and there is no TRUNCATE trigger, so a single TRUNCATE would
-- erase the evidence and bypass the append only guard entirely.
--
-- Two independent gaps, closed here:
--   1. ENABLE ALWAYS on both existing triggers, so the server side retention
--      clock pin and the append only block hold in replica mode too, not only
--      in origin mode. Note: with ENABLE ALWAYS, set_expiry also fires during a
--      logical restore and would restamp consented_at/expires_at to restore
--      time. Supabase point in time recovery is physical (WAL replay), where no
--      trigger runs, so this does not touch the real restore path; the change
--      preserves the invariant for any future logical replication.
--   2. A statement level BEFORE TRUNCATE trigger that always raises, also
--      ENABLE ALWAYS. The retention job deletes expired rows with DELETE, never
--      TRUNCATE, so an unconditional TRUNCATE block loses no legitimate path.
--
-- Idempotent: every statement is guarded or is a plain ALTER safe to re-run.
-- Touches no key material, no seed, no ledger content: server readable legal
-- metadata only, outside the zero knowledge surface.
--
-- Rollback (in this order):
--   DROP TRIGGER IF EXISTS withdrawal_consents_no_truncate ON public.withdrawal_consents;
--   DROP FUNCTION IF EXISTS public.withdrawal_consents_block_truncate();
--   ALTER TABLE public.withdrawal_consents ENABLE TRIGGER withdrawal_consents_set_expiry;
--   ALTER TABLE public.withdrawal_consents ENABLE TRIGGER withdrawal_consents_no_mutation;

-- 1. Both existing triggers fire in every replication role, not origin only.
ALTER TABLE public.withdrawal_consents
  ENABLE ALWAYS TRIGGER withdrawal_consents_no_mutation;

ALTER TABLE public.withdrawal_consents
  ENABLE ALWAYS TRIGGER withdrawal_consents_set_expiry;

-- 2. TRUNCATE is never a legitimate operation on this table. Block it at the
-- statement level, since row level triggers do not see TRUNCATE at all.
CREATE OR REPLACE FUNCTION public.withdrawal_consents_block_truncate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION
    'withdrawal_consents is append only: TRUNCATE is not permitted on this table';
END;
$$;

DROP TRIGGER IF EXISTS withdrawal_consents_no_truncate ON public.withdrawal_consents;
CREATE TRIGGER withdrawal_consents_no_truncate
  BEFORE TRUNCATE ON public.withdrawal_consents
  FOR EACH STATEMENT
  EXECUTE FUNCTION public.withdrawal_consents_block_truncate();

ALTER TABLE public.withdrawal_consents
  ENABLE ALWAYS TRIGGER withdrawal_consents_no_truncate;
