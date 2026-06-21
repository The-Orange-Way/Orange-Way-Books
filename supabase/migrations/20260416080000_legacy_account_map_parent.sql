-- Optional chart parent link (UUID of parent row's legacy_account_id). Plaintext structural FK only (ZKA-safe).
ALTER TABLE public.legacy_account_map
  ADD COLUMN IF NOT EXISTS parent_legacy_account_id TEXT NULL;

COMMENT ON COLUMN public.legacy_account_map.parent_legacy_account_id IS
  'Optional parent account in the same org (legacy_account_id of parent). Null for top-level accounts.';
