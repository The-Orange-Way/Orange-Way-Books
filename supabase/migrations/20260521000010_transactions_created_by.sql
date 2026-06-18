-- ============================================================
-- transactions.created_by + tightened write_own RLS
-- ============================================================
-- Adds the missing audit column that lets transactions.write_own
-- (Bookkeeper capability) actually mean "your own rows only" at the
-- RLS layer. Until this migration, write_own collapsed to write
-- because there was no per-row author to compare against.
-- See: 20260423010000_phase4_2_capability_rls.sql (lines 60–73).

BEGIN;

-- 1. Column + index ─────────────────────────────────────────────
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS created_by UUID
    REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS transactions_org_created_by_idx
  ON public.transactions (org_id, created_by);

-- 2. Auto-populate on INSERT ───────────────────────────────────
-- Trigger fills created_by with auth.uid() when the client omits it.
-- Existing call sites (Transactions.tsx, transaction-modal.tsx,
-- orImportBridge.ts, takeout/import.ts, Wallets.tsx, DestinationAccountPicker.tsx)
-- don't need code changes — the trigger handles it. Clients can still
-- pass created_by explicitly (e.g. import jobs running under a service
-- role context) and the trigger respects that.
CREATE OR REPLACE FUNCTION public.set_transaction_created_by()
  RETURNS TRIGGER
  LANGUAGE plpgsql
  SECURITY INVOKER
AS $$
BEGIN
  IF NEW.created_by IS NULL THEN
    NEW.created_by := auth.uid();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_transactions_set_created_by ON public.transactions;
CREATE TRIGGER trg_transactions_set_created_by
  BEFORE INSERT ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_transaction_created_by();

-- 3. Tightened RLS — write_own now means own rows ─────────────
-- write_own is the Bookkeeper grant; it should only allow operating on
-- transactions the caller authored. Plain write (Accountant/Admin)
-- continues to allow any row in the org.
DROP POLICY IF EXISTS "tx_insert_cap" ON public.transactions;
DROP POLICY IF EXISTS "tx_update_cap" ON public.transactions;
DROP POLICY IF EXISTS "tx_delete_cap" ON public.transactions;

CREATE POLICY "tx_insert_cap"
  ON public.transactions
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_has_capability(auth.uid(), 'transactions.write', org_id)
    OR (
      public.user_has_capability(auth.uid(), 'transactions.write_own', org_id)
      AND (created_by IS NULL OR created_by = auth.uid())
    )
  );

CREATE POLICY "tx_update_cap"
  ON public.transactions
  FOR UPDATE TO authenticated
  USING (
    public.user_has_capability(auth.uid(), 'transactions.write', org_id)
    OR (
      public.user_has_capability(auth.uid(), 'transactions.write_own', org_id)
      AND created_by = auth.uid()
    )
  )
  WITH CHECK (
    public.user_has_capability(auth.uid(), 'transactions.write', org_id)
    OR (
      public.user_has_capability(auth.uid(), 'transactions.write_own', org_id)
      AND created_by = auth.uid()
    )
  );

CREATE POLICY "tx_delete_cap"
  ON public.transactions
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'transactions.delete', org_id));

COMMIT;
