-- ============================================================
-- transactions.account_id — chart-of-accounts assignment
-- ============================================================
-- Adds the column that lets the Edit Transaction modal restore
-- which Uncategorized/Revenue/Expense bucket the user picked
-- when the row was created. Without this, every existing
-- transaction shows "Select account" on re-edit because the
-- modal had no column to read from.
--
-- Plaintext FK is consistent with existing ZK posture: account_id
-- is plaintext, connection_account_map.or_external_wallet_id is
-- plaintext, and legacy_account_map row PKs are random UUIDs the
-- server already sees. The account name + type stay encrypted on
-- legacy_account_map, so the server learns "tx X uses chart row Y"
-- but Y carries no business semantics.
--
-- Existing rows stay NULL and continue to show "Select account"
-- in Edit Transaction until the user re-saves them. The Phase 5
-- import bridge populates this column for new OR imports.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES public.legacy_account_map(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_account
  ON public.transactions(account_id)
  WHERE account_id IS NOT NULL;

COMMENT ON COLUMN public.transactions.account_id IS
  'Phase 5+: chart-of-accounts assignment for the transaction''s '
  'counter-side. NULL for legacy rows (predates this column) and '
  'unassigned transactions. Populated by orImportBridge for OR '
  'imports and by the transaction modal for new/edited rows.';
