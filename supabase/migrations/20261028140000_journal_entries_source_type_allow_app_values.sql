-- Widen journal_entries.source_type to the values the app already writes.
--
-- The phase-1 check (20260601000030) allows: manual, or_import, invoice,
-- payment, void_reversal, fx_revaluation, opening_balance, takeout_import.
-- Several app flows insert values outside that list, so the insert fails
-- with 23514 journal_entries_source_type_check and nothing is saved:
--
--   TRANSACTION_TRANSFER     src/components/transactions/transaction-modal.tsx
--   TRANSACTION_SPLIT        src/components/transactions/transaction-modal.tsx
--   VOID_REVERSAL            src/lib/transactions/void-transaction.ts,
--                            src/lib/transactions/reverse-journal-entry.ts
--                            (JournalEntries.tsx also reads this exact value)
--   fx_revaluation_reversal  src/components/fx-revaluation/RevaluationWizard.tsx
--   quickbooks               src/lib/imports/quickbooks/commit.ts
--   orangerails              src/lib/orImportBridge.ts
--
-- This migration only ADDS allowed values. Every existing row already
-- satisfies the old list, so it satisfies the new one; no data changes.
-- The original eight values are kept unchanged.

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;

ALTER TABLE public.journal_entries
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
    'VOID_REVERSAL',
    'fx_revaluation_reversal',
    'quickbooks',
    'orangerails'
  ));

COMMENT ON COLUMN public.journal_entries.source_type IS
  'D9 plaintext. Which workflow created this entry: manual, or_import, invoice, payment, void_reversal, fx_revaluation, opening_balance, takeout_import, TRANSACTION_TRANSFER, TRANSACTION_SPLIT, VOID_REVERSAL, fx_revaluation_reversal, quickbooks, orangerails. Not customer content.';
