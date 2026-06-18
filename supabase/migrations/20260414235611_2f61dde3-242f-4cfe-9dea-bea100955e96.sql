
-- Add missing columns to accounts
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS initial_balance DECIMAL DEFAULT 0;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS connection_type TEXT DEFAULT 'manual';

-- Fix accounts insert policy to allow authenticated users
DROP POLICY IF EXISTS "accounts_insert" ON public.accounts;
CREATE POLICY "accounts_insert" ON public.accounts FOR INSERT TO authenticated WITH CHECK (true);

-- Add update/delete policies for accounts
DROP POLICY IF EXISTS "accounts_update" ON public.accounts;
CREATE POLICY "accounts_update" ON public.accounts FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "accounts_delete" ON public.accounts;
CREATE POLICY "accounts_delete" ON public.accounts FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

-- Create transactions table
CREATE TABLE IF NOT EXISTS public.transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id),
  account_id UUID REFERENCES public.accounts(id),
  type TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount DECIMAL NOT NULL,
  usd_value DECIMAL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  memo TEXT,
  exchange_rate DECIMAL,
  legacy_transaction_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tx_insert" ON public.transactions FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "tx_select" ON public.transactions FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
CREATE POLICY "tx_update" ON public.transactions FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
CREATE POLICY "tx_delete" ON public.transactions FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
