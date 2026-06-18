-- Level 2 ZKA: Add encrypted TEXT columns for numeric/boolean fields
-- Numeric columns can't store base64 ciphertext, so we add parallel TEXT columns.
-- Original numeric columns stay (for backward compat with key_version<=1 rows).
-- For key_version=2 rows, originals are set to 0/null; encrypted_ columns hold ciphertext.

-- transactions
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS encrypted_amount TEXT;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS encrypted_usd_value TEXT;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS encrypted_exchange_rate TEXT;

-- accounts
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS encrypted_balance TEXT;

-- journal_entries
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS encrypted_exchange_rate TEXT;
ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS encrypted_period_locked TEXT;

-- journal_entry_lines
ALTER TABLE public.journal_entry_lines ADD COLUMN IF NOT EXISTS encrypted_debit TEXT;
ALTER TABLE public.journal_entry_lines ADD COLUMN IF NOT EXISTS encrypted_credit TEXT;
ALTER TABLE public.journal_entry_lines ADD COLUMN IF NOT EXISTS encrypted_book_value TEXT;

-- legacy_account_map
ALTER TABLE public.legacy_account_map ADD COLUMN IF NOT EXISTS encrypted_is_archived TEXT;

-- org_settings
ALTER TABLE public.org_settings ADD COLUMN IF NOT EXISTS encrypted_fiscal_month TEXT;
