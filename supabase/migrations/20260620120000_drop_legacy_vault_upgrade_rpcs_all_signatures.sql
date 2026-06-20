-- Drop legacy vault key-version upgrade RPCs (signature-agnostic).
--
-- The prior migration `20260619060000_drop_legacy_vault_upgrade_rpcs.sql`
-- declared `DROP FUNCTION IF EXISTS f(jsonb)` for each of these four
-- functions, but the deployed signature is
-- `(p_org_id uuid, p_new_verifier text, p_new_salt text, p_updates jsonb)`.
-- The argument-list mismatch meant `IF EXISTS` matched nothing and the
-- migration was a no-op; the functions remained in place.
--
-- This migration iterates over `pg_proc` matching the four target names in
-- the `public` schema and EXECUTEs a properly-formed DROP per overload
-- found, so every overload is dropped regardless of argument list. The
-- migration is idempotent: re-running on a database where the functions
-- are already gone is a no-op (the SELECT yields zero rows; the inner
-- `DROP FUNCTION IF EXISTS` adds belt-and-suspenders).

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT oid::regprocedure AS sig
    FROM pg_proc
    WHERE proname IN (
      'rpc_upgrade_vault_to_v3',
      'rpc_upgrade_vault_to_v3_with_attachments',
      'rpc_upgrade_vault_to_v4',
      'rpc_upgrade_vault_to_v4_with_attachments'
    )
    AND pronamespace = 'public'::regnamespace
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s', r.sig);
    RAISE NOTICE 'dropped %', r.sig;
  END LOOP;
END
$$;
