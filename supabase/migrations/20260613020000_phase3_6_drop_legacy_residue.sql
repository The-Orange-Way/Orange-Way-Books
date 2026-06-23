-- Phase 3.6, drop / rename the remaining legacy-era column residue.
--
-- After (which renamed accounts.legacy_account_id → external_account_id
-- and organizations.legacy_journal_id → external_journal_id), four columns kept
-- their legacy-era names:
--
--   accounts.legacy_account_code        , LIVE encrypted ciphertext column; rename only
--   transactions.legacy_transaction_id , 100% NULL; only written as null; drop
--   invoice_line_items.legacy_account_map_id       , 100% NULL; no code refs; drop
--   payment_request_line_items.legacy_account_map_id, 100% NULL; no code refs; drop
--
-- DEV + PROD verified empty (zero rows) and 0 non-null values on these columns
-- before this migration. Drops are safe.

ALTER TABLE public.accounts
  RENAME COLUMN legacy_account_code TO external_account_code;

ALTER TABLE public.transactions
  DROP COLUMN IF EXISTS legacy_transaction_id;

ALTER TABLE public.invoice_line_items
  DROP COLUMN IF EXISTS legacy_account_map_id;

ALTER TABLE public.payment_request_line_items
  DROP COLUMN IF EXISTS legacy_account_map_id;
