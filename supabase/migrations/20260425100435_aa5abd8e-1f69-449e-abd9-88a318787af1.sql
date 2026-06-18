ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES public.legacy_account_map(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_account
  ON public.transactions(account_id)
  WHERE account_id IS NOT NULL;

COMMENT ON COLUMN public.transactions.account_id IS
  'Phase 5+: chart-of-accounts assignment for the transaction''s counter-side. NULL for legacy rows (predates this column) and unassigned transactions. Populated by orImportBridge for OR imports and by the transaction modal for new/edited rows.';