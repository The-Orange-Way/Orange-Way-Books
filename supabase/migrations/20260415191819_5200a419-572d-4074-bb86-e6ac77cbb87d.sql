
CREATE TABLE public.legacy_account_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  legacy_account_id UUID NOT NULL,
  account_code TEXT,
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL,
  account_group TEXT,
  account_category TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.legacy_account_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "legacy_account_map_select" ON public.legacy_account_map
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

CREATE POLICY "legacy_account_map_insert" ON public.legacy_account_map
  FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

CREATE POLICY "legacy_account_map_update" ON public.legacy_account_map
  FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

CREATE POLICY "legacy_account_map_delete" ON public.legacy_account_map
  FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
