-- S11 — Gate import_jobs writes on the transactions.write capability
--
-- The initial import_jobs policies (migration 20260515000000) gated INSERT
-- and UPDATE on `created_by = auth.uid() AND EXISTS in org_members`. That
-- lets any org member — including the VIEWER role — kick off an import,
-- which can consume platform quota (legacy ledger backend writes, edge function calls) and
-- generate background processing load. Imports are write-equivalent
-- operations and should require the same capability as creating
-- transactions directly.
--
-- This migration replaces INSERT / UPDATE / DELETE with the same capability
-- gate the transaction tables already use (`transactions.write` for
-- INSERT+UPDATE, `transactions.delete` for DELETE). SELECT stays unchanged
-- — any member can see import history in their org.
--
-- Surfaced by 2026-05-16 security review (finding E.2). Tracked as S11.

DROP POLICY IF EXISTS "import_jobs_insert" ON public.import_jobs;
CREATE POLICY "import_jobs_insert" ON public.import_jobs
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND public.user_has_capability(auth.uid(), 'transactions.write', org_id)
  );

DROP POLICY IF EXISTS "import_jobs_update" ON public.import_jobs;
CREATE POLICY "import_jobs_update" ON public.import_jobs
  FOR UPDATE TO authenticated
  USING (
    created_by = auth.uid()
    AND public.user_has_capability(auth.uid(), 'transactions.write', org_id)
  )
  WITH CHECK (
    created_by = auth.uid()
    AND public.user_has_capability(auth.uid(), 'transactions.write', org_id)
  );

DROP POLICY IF EXISTS "import_jobs_delete" ON public.import_jobs;
CREATE POLICY "import_jobs_delete" ON public.import_jobs
  FOR DELETE TO authenticated
  USING (
    created_by = auth.uid()
    AND status IN ('parsing', 'ready', 'failed')
    AND public.user_has_capability(auth.uid(), 'transactions.delete', org_id)
  );
