-- Add missing UPDATE/DELETE policies for admin-sensitive tables.
-- Only org admins can delete organizations or mutate membership.

-- organizations: DELETE only by an admin member of that org.
CREATE POLICY "organizations_delete_admin" ON public.organizations FOR DELETE TO authenticated
  USING (
    id IN (
      SELECT org_id FROM public.org_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- org_members: UPDATE (e.g. role change) only by admin
CREATE POLICY "org_members_update_admin" ON public.org_members FOR UPDATE TO authenticated
  USING (
    org_id IN (
      SELECT org_id FROM public.org_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  )
  WITH CHECK (
    org_id IN (
      SELECT org_id FROM public.org_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- org_members: DELETE (remove member) only by admin; or user can delete their own membership
CREATE POLICY "org_members_delete_admin_or_self" ON public.org_members FOR DELETE TO authenticated
  USING (
    user_id = auth.uid()
    OR org_id IN (
      SELECT org_id FROM public.org_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- org_settings: DELETE scoped to admin only
CREATE POLICY "org_settings_delete_admin" ON public.org_settings FOR DELETE TO authenticated
  USING (
    org_id IN (
      SELECT org_id FROM public.org_members
      WHERE user_id = auth.uid() AND role = 'admin'
    )
  );

-- exchange_rates: revoke anon, ensure only authenticated read
REVOKE ALL ON public.exchange_rates FROM anon;
GRANT SELECT ON public.exchange_rates TO authenticated;
