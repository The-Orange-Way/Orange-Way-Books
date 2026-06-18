-- Add encrypted_metadata JSONB to tables that have plaintext business-sensitive columns.
-- The JSON blob will store { field1: encryptedString, field2: encryptedString, ... }
-- Old plaintext columns remain for backward compat; they'll be dropped in a later migration.

ALTER TABLE public.payment_requests      ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;
ALTER TABLE public.connectors            ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;
ALTER TABLE public.journal_entries       ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;
ALTER TABLE public.transactions          ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;
ALTER TABLE public.accounts               ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;
ALTER TABLE public.journal_entry_lines   ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;
ALTER TABLE public.legacy_account_map      ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;
