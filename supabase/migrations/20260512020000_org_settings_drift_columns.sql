-- Add four columns to public.org_settings that the frontend writes but
-- no migration ever created. They were added via the cloud dashboard on
-- the old Cloud DB and never captured as migration files.
--
-- Evidence:
--   * src/components/onboarding/OnboardingWizard.tsx line 282 INSERTs
--     org_settings with all keys returned by encryptOrgSettings (defined
--     in src/lib/crypto-fields.ts) — which spreads:
--         primary_currency, secondary_currency, bitcoin_display,
--         fiscal_year_type, encrypted_fiscal_month, fiscal_start_month,
--         date_format, time_format, number_format
--   * The original CREATE TABLE (20260414182928) defined only 5 columns:
--     org_id, primary_currency, secondary_currency, bitcoin_display, date_format
--   * 20260420120000_vault_key_version_v3.sql and 20260421000000_vault_v3_
--     attachment_rekey.sql both reference fiscal_year_type and time_format
--     inside rekey procedures, but neither adds the column.
--
-- All four columns are NULLABLE. Three hold encrypted-text ciphertext
-- (the frontend encrypts before INSERT via crypto-fields.ts).
-- fiscal_start_month is an INTEGER stub the frontend always writes as
-- NULL — the real fiscal start month lives in encrypted_fiscal_month.

ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS fiscal_year_type    TEXT    NULL,
  ADD COLUMN IF NOT EXISTS fiscal_start_month  INTEGER NULL,
  ADD COLUMN IF NOT EXISTS time_format         TEXT    NULL,
  ADD COLUMN IF NOT EXISTS number_format       TEXT    NULL;

COMMENT ON COLUMN public.org_settings.fiscal_year_type   IS 'Encrypted ciphertext: fiscal year type. NULL until user picks one.';
COMMENT ON COLUMN public.org_settings.fiscal_start_month IS 'Plaintext stub — always NULL. The real fiscal start month lives in encrypted_fiscal_month.';
COMMENT ON COLUMN public.org_settings.time_format        IS 'Encrypted ciphertext: user preferred time format (12h / 24h).';
COMMENT ON COLUMN public.org_settings.number_format      IS 'Encrypted ciphertext: us or eu number formatting.';

NOTIFY pgrst, 'reload schema';
