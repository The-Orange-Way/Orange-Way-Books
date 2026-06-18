-- Adds key_version to public.org_settings so encryptOrgSettings() output
-- matches the Insert/Update type shape.
--
-- Every other encrypted table (transactions, accounts, legacy_account_map,
-- journal_entries, journal_entry_lines, payment_requests, connectors,
-- contacts, organizations) already has a key_version column tagging the
-- field-encryption format version. org_settings was the lone exception.
--
-- Without this column:
--   * Admin.tsx upsert({ org_id, ...encryptOrgSettings(...) }) fails TS
--     compile because `key_version` is not a known column.
--   * decryptOrgSettings(row) reads row.key_version which is always
--     undefined, so it always takes the "legacy plaintext" branch and
--     would silently skip decrypting encrypted data.
--
-- Default 0 matches existing rows that predate L2 encryption. New rows
-- written by encryptOrgSettings() will set key_version = 2 (L2).

DO $$
BEGIN
  IF to_regclass('public.org_settings') IS NOT NULL THEN
    ALTER TABLE public.org_settings
      ADD COLUMN IF NOT EXISTS key_version INTEGER DEFAULT 0;
  END IF;
END $$;
