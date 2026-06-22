-- Phase 3.5: rename legacy-era columns on accounts + organizations.
--
-- After the Phase 1 schema squash + external-ledger removal, two columns kept their
-- legacy-era names purely as schema-cache placeholders (every value is NULL
-- across DEV and PROD; verified pre-merge). Renaming brings the column
-- names in line with the current mental model, where these IDs point at
-- the same Postgres chart_of_accounts / journal_entries rows (or stay NULL
-- pending external-system integration).
--
--   accounts.legacy_account_id        -> accounts.external_account_id
--   organizations.legacy_journal_id  -> organizations.external_journal_id
--
-- Both columns are NULL everywhere, so RENAME is safe with zero downtime.

ALTER TABLE public.accounts       RENAME COLUMN legacy_account_id  TO external_account_id;
ALTER TABLE public.organizations RENAME COLUMN legacy_journal_id  TO external_journal_id;
