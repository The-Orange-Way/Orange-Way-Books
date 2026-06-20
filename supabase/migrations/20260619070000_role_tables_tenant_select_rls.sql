-- Tighten SELECT RLS on role_definitions + role_capabilities.
--
-- Both tables previously used `USING (true)` for SELECT, which made every
-- row readable by any authenticated user. role_definitions holds org-scoped
-- custom role names + descriptions (org_id non-NULL for custom rows), and
-- role_capabilities is the junction that names the capabilities each role
-- grants. Leaving them globally readable lets any user enumerate every
-- other org's custom role naming and capability grants.
--
-- The system-preset rows (org_id IS NULL on role_definitions; their
-- capabilities on role_capabilities) MUST stay readable to all
-- authenticated users because the app code (capability checks, role UI)
-- needs them to function.
--
-- New SELECT policies:
--   role_definitions: NULL org_id (global presets) OR org_id matches a
--                     row in org_members for the caller.
--   role_capabilities: same, joined through role_definitions.

DROP POLICY IF EXISTS "role_definitions_select_all_authenticated" ON public.role_definitions;
CREATE POLICY "role_definitions_select_global_or_member"
  ON public.role_definitions
  FOR SELECT TO authenticated
  USING (
    org_id IS NULL
    OR org_id IN (
      SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "role_capabilities_select_all_authenticated" ON public.role_capabilities;
CREATE POLICY "role_capabilities_select_global_or_member"
  ON public.role_capabilities
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.role_definitions rd
      WHERE rd.id = role_capabilities.role_id
        AND (
          rd.org_id IS NULL
          OR rd.org_id IN (
            SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
          )
        )
    )
  );
