-- Allow journal_entries.source_type = 'TRANSACTION_STANDARD' (OWB-T0241).
--
-- A standard send or receive saved on the Transactions screen now writes its
-- journal entry (one wallet line and one account line), the way a split or a
-- transfer already does. The entry is marked TRANSACTION_STANDARD so a posted
-- one is edited as a standard transaction, not refused as a split.
--
-- This migration only ADDS an allowed value. Every existing row already
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
    'TRANSACTION_STANDARD',
    'fx_revaluation_reversal',
    'quickbooks',
    'wave',
    'invoice_payment',
    'invoice_payment_merge'
  ));

COMMENT ON COLUMN public.journal_entries.source_type IS
  'D9 plaintext. Which workflow created this entry: manual, or_import, invoice, payment, void_reversal, fx_revaluation, opening_balance, takeout_import, TRANSACTION_TRANSFER, TRANSACTION_SPLIT, TRANSACTION_STANDARD, fx_revaluation_reversal, quickbooks, wave, invoice_payment, invoice_payment_merge. Not customer content.';
