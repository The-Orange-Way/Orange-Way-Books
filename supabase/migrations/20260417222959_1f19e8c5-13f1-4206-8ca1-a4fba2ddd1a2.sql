-- 1. org_settings: per-org vault salt + key version
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS vault_salt text,
  ADD COLUMN IF NOT EXISTS vault_key_version integer DEFAULT 1;

COMMENT ON COLUMN public.org_settings.vault_salt IS
  'Base64 of 32 random bytes. Combined with user id to form PBKDF2 salt when vault_key_version >= 2.';
COMMENT ON COLUMN public.org_settings.vault_key_version IS
  'Vault derivation scheme. 1 = legacy deterministic salt, 2 = per-org random salt.';

-- 2. legacy_account_map: optional parent account (uuid to match legacy_account_id type)
ALTER TABLE public.legacy_account_map
  ADD COLUMN IF NOT EXISTS parent_legacy_account_id uuid;

COMMENT ON COLUMN public.legacy_account_map.parent_legacy_account_id IS
  'Optional parent account in same org (legacy_account_id of parent). Null for top-level accounts.';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'legacy_account_map_legacy_account_id_unique'
      AND conrelid = 'public.legacy_account_map'::regclass
  ) THEN
    ALTER TABLE public.legacy_account_map
      ADD CONSTRAINT legacy_account_map_legacy_account_id_unique UNIQUE (legacy_account_id);
  END IF;
END $$;

ALTER TABLE public.legacy_account_map
  DROP CONSTRAINT IF EXISTS legacy_account_map_parent_fk;

ALTER TABLE public.legacy_account_map
  ADD CONSTRAINT legacy_account_map_parent_fk
  FOREIGN KEY (parent_legacy_account_id)
  REFERENCES public.legacy_account_map (legacy_account_id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

-- 3. organizations: archive flag
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS is_archived boolean DEFAULT false;

COMMENT ON COLUMN public.organizations.is_archived IS
  'Soft-archive flag. Archived orgs are hidden from the tile picker by default.';

-- 4. contacts: missing fields expected by code
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS type text;