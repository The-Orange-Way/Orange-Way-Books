-- Widen journal_entries.source_type to the values the app and the database
-- functions already write.
--
-- The phase-1 check (20260601000030) allows: manual, or_import, invoice,
-- payment, void_reversal, fx_revaluation, opening_balance, takeout_import.
-- These writers insert values outside that list, so the insert fails with
-- 23514 journal_entries_source_type_check and nothing is saved:
--
--   TRANSACTION_TRANSFER     src/components/transactions/transaction-modal.tsx
--   TRANSACTION_SPLIT        src/components/transactions/transaction-modal.tsx
--   fx_revaluation_reversal  src/components/fx-revaluation/RevaluationWizard.tsx
--   quickbooks               src/lib/imports/quickbooks/commit.ts
--   wave                     src/lib/imports/orange-rails/commit-orange-rails.ts
--   invoice_payment          SQL function apply_invoice_payment
--   invoice_payment_merge    SQL function merge_invoice_payment
--
-- Voids and reversals now write the existing 'void_reversal', and entries
-- that came from Orange Rails now write the existing 'or_import' (same
-- change), so no second spelling of either value is added.
--
-- This migration only ADDS allowed values. Every existing row already
-- satisfies the old list, so it satisfies the new one; no data changes.
-- One statement, so the drop and the add apply together.

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check,
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IS NULL OR source_type IN (
    'manual',
    'or_import',
    'invoice',
    'payment',
    'void_reversal',
    'fx_revaluation',
    'opening_balance',
    'takeout_import',
    'TRANSACTION_TRANSFER',
    'TRANSACTION_SPLIT',
    'fx_revaluation_reversal',
    'quickbooks',
    'wave',
    'invoice_payment',
    'invoice_payment_merge'
  ));

COMMENT ON COLUMN public.journal_entries.source_type IS
  'D9 plaintext. Which workflow created this entry: manual, or_import, invoice, payment, void_reversal, fx_revaluation, opening_balance, takeout_import, TRANSACTION_TRANSFER, TRANSACTION_SPLIT, fx_revaluation_reversal, quickbooks, wave, invoice_payment, invoice_payment_merge. Not customer content.';
