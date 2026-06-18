
-- Fix accounts insert to check org membership
DROP POLICY IF EXISTS "accounts_insert" ON public.accounts;
CREATE POLICY "accounts_insert" ON public.accounts FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

-- Fix transactions insert to check org membership  
DROP POLICY IF EXISTS "tx_insert" ON public.transactions;
CREATE POLICY "tx_insert" ON public.transactions FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
