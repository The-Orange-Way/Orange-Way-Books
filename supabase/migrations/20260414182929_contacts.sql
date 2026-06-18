-- Migration: Create the contacts table (was missing; later migrations ALTER this table).
-- Timestamp chosen so this runs AFTER 20260414182928 (which creates `organizations`
-- and `org_members` that this table's FK + RLS policies depend on) and BEFORE
-- 20260416004500 (which adds key_version via ALTER).

CREATE TABLE public.contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  street TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  country TEXT,
  email TEXT,
  phone TEXT,
  type TEXT,
  key_version INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "contacts_select" ON public.contacts FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

CREATE POLICY "contacts_insert" ON public.contacts FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

CREATE POLICY "contacts_update" ON public.contacts FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()))
  WITH CHECK (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

CREATE POLICY "contacts_delete" ON public.contacts FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
