-- Auto-sync org_members.role → org_member_roles row.
--
-- Phase 4.2 (migration 20260423010000_phase4_2_capability_rls.sql) replaced
-- the "any org member" RLS pattern with capability-based RLS that checks
-- public.user_has_capability(user_id, capability_key, org_id). That function
-- reads from public.org_member_roles, which is a join between org_members
-- and role_definitions.
--
-- Phase 4.2 seeded role_definitions and role_capabilities but did NOT add
-- the mechanism that populates org_member_roles when a new org_members row
-- lands. So every fresh org onboarding crashes at vault setup Step 4: the
-- user gets a working org_members row with role='OWNER', but
-- user_has_capability(user, 'org.manage', org_id) returns FALSE because
-- org_member_roles is empty for that pair. INSERT into org_settings is then
-- rejected by RLS with PostgreSQL error 42501.
--
-- This trigger fires AFTER INSERT or UPDATE OF role on org_members and
-- creates / refreshes the matching org_member_roles row by looking up the
-- system role_definition whose name matches org_members.role (case-insensitive,
-- since the frontend writes 'OWNER' and role_definitions seeds with 'Owner').
--
-- Backfill: at end of migration we also insert org_member_roles rows for any
-- existing org_members that don't already have one. No-op on databases that
-- were correctly populated by a future explicit code path.

CREATE OR REPLACE FUNCTION public.sync_org_member_role()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_role_id UUID;
BEGIN
  SELECT id INTO target_role_id
    FROM public.role_definitions
   WHERE org_id IS NULL
     AND lower(name) = lower(NEW.role)
   LIMIT 1;

  IF target_role_id IS NULL THEN
    RAISE EXCEPTION 'No system role_definition matches org_members.role = %', NEW.role
      USING ERRCODE = '23514';
  END IF;

  DELETE FROM public.org_member_roles
   WHERE org_id  = NEW.org_id
     AND user_id = NEW.user_id;

  INSERT INTO public.org_member_roles (org_id, user_id, role_definition_id, granted_by)
  VALUES (NEW.org_id, NEW.user_id, target_role_id, NEW.user_id);

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_sync_org_member_role ON public.org_members;

CREATE TRIGGER trg_sync_org_member_role
  AFTER INSERT OR UPDATE OF role ON public.org_members
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_org_member_role();

DO $backfill$
DECLARE
  m RECORD;
  target_role_id UUID;
BEGIN
  FOR m IN
    SELECT om.org_id, om.user_id, om.role
      FROM public.org_members om
     WHERE NOT EXISTS (
       SELECT 1 FROM public.org_member_roles omr
        WHERE omr.org_id = om.org_id AND omr.user_id = om.user_id
     )
  LOOP
    SELECT id INTO target_role_id
      FROM public.role_definitions
     WHERE org_id IS NULL AND lower(name) = lower(m.role)
     LIMIT 1;

    IF target_role_id IS NOT NULL THEN
      INSERT INTO public.org_member_roles (org_id, user_id, role_definition_id, granted_by)
      VALUES (m.org_id, m.user_id, target_role_id, m.user_id);
    END IF;
  END LOOP;
END
$backfill$;
