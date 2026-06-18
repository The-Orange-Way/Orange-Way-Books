
CREATE TABLE IF NOT EXISTS public.journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id),
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  ref_number TEXT,
  memo TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'DRAFT',
  source_type TEXT,
  exchange_rate NUMERIC,
  period_locked BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "je_select" ON public.journal_entries FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
CREATE POLICY "je_insert" ON public.journal_entries FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
CREATE POLICY "je_update" ON public.journal_entries FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
CREATE POLICY "je_delete" ON public.journal_entries FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

CREATE TABLE IF NOT EXISTS public.journal_entry_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id UUID NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  account_id UUID,
  account_code TEXT,
  account_name TEXT,
  debit NUMERIC DEFAULT 0,
  credit NUMERIC DEFAULT 0,
  description TEXT,
  book_value NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.journal_entry_lines ENABLE ROW LEVEL SECURITY;

CREATE POLICY "jel_select" ON public.journal_entry_lines FOR SELECT TO authenticated
  USING (journal_entry_id IN (SELECT id FROM public.journal_entries WHERE org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())));
CREATE POLICY "jel_insert" ON public.journal_entry_lines FOR INSERT TO authenticated
  WITH CHECK (journal_entry_id IN (SELECT id FROM public.journal_entries WHERE org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())));
CREATE POLICY "jel_update" ON public.journal_entry_lines FOR UPDATE TO authenticated
  USING (journal_entry_id IN (SELECT id FROM public.journal_entries WHERE org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())));
CREATE POLICY "jel_delete" ON public.journal_entry_lines FOR DELETE TO authenticated
  USING (journal_entry_id IN (SELECT id FROM public.journal_entries WHERE org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())));
