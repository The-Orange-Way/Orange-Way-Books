-- Period-lock RLS enforcement (Block 3 of P1)
--
-- Adds a CHECK on journal_entries INSERT/UPDATE policies that calls
-- is_date_in_closed_period(org_id, auth.uid(), date) and rejects the
-- write when the date is inside a closed period with no active unlock
-- session. Same enforcement on transactions.
--
-- Doesn't replace existing policies; adds an additional WITH CHECK
-- clause as a row-level guard. The Phase 4.2 capability policy still
-- gates "can this user write at all"; this layer gates "can this user
-- write to THIS date".
--

-- Drop and recreate the relevant policies, layering the date check in.
-- We keep the org-scope + capability check that already existed.

DO $$
DECLARE
  pol_name TEXT;
BEGIN
  -- journal_entries: drop both insert + update period-lock policies if they
  -- exist from a prior run, then recreate.
  FOR pol_name IN
    SELECT polname FROM pg_policy
     WHERE polrelid = 'public.journal_entries'::regclass
       AND polname IN ('je_period_lock_insert', 'je_period_lock_update')
  LOOP
    EXECUTE format('DROP POLICY %I ON public.journal_entries', pol_name);
  END LOOP;

  FOR pol_name IN
    SELECT polname FROM pg_policy
     WHERE polrelid = 'public.transactions'::regclass
       AND polname IN ('tx_period_lock_insert', 'tx_period_lock_update')
  LOOP
    EXECUTE format('DROP POLICY %I ON public.transactions', pol_name);
  END LOOP;
END $$;

-- journal_entries, block writes into closed period.
CREATE POLICY "je_period_lock_insert" ON public.journal_entries
  AS RESTRICTIVE
  FOR INSERT TO authenticated
  WITH CHECK (
    NOT public.is_date_in_closed_period(org_id, auth.uid(), date)
  );

CREATE POLICY "je_period_lock_update" ON public.journal_entries
  AS RESTRICTIVE
  FOR UPDATE TO authenticated
  USING (
    NOT public.is_date_in_closed_period(org_id, auth.uid(), date)
  )
  WITH CHECK (
    NOT public.is_date_in_closed_period(org_id, auth.uid(), date)
  );

-- transactions, same enforcement.
CREATE POLICY "tx_period_lock_insert" ON public.transactions
  AS RESTRICTIVE
  FOR INSERT TO authenticated
  WITH CHECK (
    NOT public.is_date_in_closed_period(org_id, auth.uid(), date)
  );

CREATE POLICY "tx_period_lock_update" ON public.transactions
  AS RESTRICTIVE
  FOR UPDATE TO authenticated
  USING (
    NOT public.is_date_in_closed_period(org_id, auth.uid(), date)
  )
  WITH CHECK (
    NOT public.is_date_in_closed_period(org_id, auth.uid(), date)
  );

COMMENT ON POLICY "je_period_lock_insert" ON public.journal_entries IS
  'P1, refuses inserts dated on or before the org''s lock-through-date unless caller has an active unlock session.';
