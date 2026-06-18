-- C2: Consolidate chart_of_accounts + account_metadata into legacy_account_map
-- Then drop the two eliminated tables.

BEGIN;

-- 1) Copy rows from chart_of_accounts that don't already exist in legacy_account_map
--    (match on org_id + name/account_name to avoid duplicates)
INSERT INTO legacy_account_map (org_id, legacy_account_id, account_code, account_name, account_type, account_group, is_archived)
SELECT
  c.org_id,
  gen_random_uuid(),
  c.code,
  c.name,
  c.account_type,
  c.account_group,
  c.is_archived
FROM chart_of_accounts c
WHERE NOT EXISTS (
  SELECT 1 FROM legacy_account_map m
  WHERE m.org_id = c.org_id
    AND m.account_name = c.name
);

-- 2) Copy rows from account_metadata that don't already exist in legacy_account_map
--    (match on org_id + legacy_account_id to avoid duplicates)
INSERT INTO legacy_account_map (org_id, legacy_account_id, account_code, account_name, account_type, encrypted_name, encrypted_description, key_version)
SELECT
  a.org_id,
  a.legacy_account_id,
  a.legacy_account_code,
  a.legacy_account_code,       -- use code as opaque placeholder for account_name (NOT NULL)
  'UNKNOWN',                  -- placeholder for account_type (NOT NULL)
  a.encrypted_name,
  a.encrypted_description,
  a.key_version
FROM account_metadata a
WHERE NOT EXISTS (
  SELECT 1 FROM legacy_account_map m
  WHERE m.org_id = a.org_id
    AND m.legacy_account_id = a.legacy_account_id
);

-- 3) For rows that already existed in legacy_account_map, backfill encrypted fields from account_metadata
UPDATE legacy_account_map m
SET
  encrypted_name = a.encrypted_name,
  encrypted_description = a.encrypted_description,
  key_version = a.key_version
FROM account_metadata a
WHERE m.org_id = a.org_id
  AND m.legacy_account_id = a.legacy_account_id
  AND m.encrypted_name IS NULL;

-- 4) Drop the eliminated tables
DROP TABLE IF EXISTS chart_of_accounts CASCADE;
DROP TABLE IF EXISTS account_metadata CASCADE;

COMMIT;
