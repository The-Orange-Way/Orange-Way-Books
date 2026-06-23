-- Grant CRUD on the public schema to the authenticated role.
--
-- WHY THIS EXISTS
--
-- The dev and prod Supabase projects were created with the
-- "Automatically expose new tables" Data API setting
-- OFF (intentional, so new tables don't accidentally bypass our RLS work
-- with a default-expose grant). The trade-off is that GRANTs for the
-- authenticated role must be issued explicitly.
--
-- Every existing migration assumes the authenticated role can do CRUD on
-- public tables; row-level access is then gated by RLS. Without these
-- GRANTs, every INSERT / SELECT through PostgREST fails with PostgreSQL
-- error 42501 "permission denied for table X".
--
-- The "Automatically enable RLS on new tables" setting is still ON, so
-- new tables continue to default to deny-all until a policy is added
-- which is the property we wanted from disabling auto-exposure.

BEGIN;

-- Schema access
GRANT USAGE ON SCHEMA public TO authenticated, anon, service_role;

-- All existing tables get standard CRUD for authenticated. service_role
-- gets ALL since it's the Supabase edge function role and needs full
-- access to perform user-impersonation patterns.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;

-- Sequences (id generators), authenticated needs to advance them on insert.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Functions, authenticated needs to execute the SQL helpers our migrations
-- defined (purge_expired_old_key_wraps, check_*_same_org, etc.).
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated, service_role;

-- Default privileges so future tables/sequences/functions inherit the same
-- shape without us having to remember to re-grant after each new migration.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO authenticated, service_role;

COMMIT;
