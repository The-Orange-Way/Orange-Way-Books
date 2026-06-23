-- ============================================================
-- Vault key version 4: MEK wrapping + recovery codes + blind indexes.
-- ============================================================
-- Context: in v1/v2/v3, MEK = KDF(password, salt). Changing the password
-- requires re-encrypting all data rows. In v4, the MEK is a random 32-byte
-- key stored wrapped under two independent KEKs:
--   enc_mek_ciphertext  , MEK wrapped with Argon2id(password, salt)
--   recovery_ciphertext , MEK wrapped with HKDF(12-word recovery code)
-- Only the wrapping changes on password reset, no data re-encryption needed.
--
-- Blind indexes: an HMAC-SHA256 fingerprint of selected plaintext fields
-- allows the server to filter encrypted rows without seeing plaintext.
-- The HMAC key (bytes 32-63 of the 64-byte Argon2id output) is separate
-- from all AES-GCM encryption keys.
--
-- Existing v1/v2/v3 orgs: unaffected. NULL in the new columns continues
-- to work, the unlock path branches on vault_key_version.
-- New orgs: created at vault_key_version = 4 with all columns populated.

-- ── org_settings: MEK wrapping + recovery ────────────────────────────────────

ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS enc_mek_ciphertext  TEXT,
  ADD COLUMN IF NOT EXISTS recovery_ciphertext TEXT;

COMMENT ON COLUMN public.org_settings.enc_mek_ciphertext IS
  'Random MEK (32 bytes) wrapped with Argon2id(password, salt) KEK. '
  'NULL for v1/v2/v3 vaults. Required for v4+.';

COMMENT ON COLUMN public.org_settings.recovery_ciphertext IS
  'Random MEK wrapped with HKDF(12-word recovery code) KEK. '
  'NULL for v1/v2/v3 vaults. Required for password recovery on v4+.';

COMMENT ON COLUMN public.org_settings.vault_key_version IS
  'Vault KDF version. '
  '1 = deterministic salt (legacy). '
  '2 = PBKDF2-SHA256 + per-org salt. '
  '3 = Argon2id + per-org salt. '
  '4 = Argon2id + random MEK wrapping + recovery codes.';

-- ── contacts: blind index on name ────────────────────────────────────────────

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS hmac_name TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_hmac_name
  ON public.contacts(org_id, hmac_name)
  WHERE hmac_name IS NOT NULL;

COMMENT ON COLUMN public.contacts.hmac_name IS
  'HMAC-SHA256 blind index of the plaintext contact name. '
  'Enables server-side search without plaintext exposure. '
  'Populated for v4+ orgs only.';

-- ── transactions: blind indexes on type and asset ────────────────────────────

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS hmac_type  TEXT,
  ADD COLUMN IF NOT EXISTS hmac_asset TEXT;

CREATE INDEX IF NOT EXISTS idx_transactions_hmac_type
  ON public.transactions(org_id, hmac_type)
  WHERE hmac_type IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_hmac_asset
  ON public.transactions(org_id, hmac_asset)
  WHERE hmac_asset IS NOT NULL;

COMMENT ON COLUMN public.transactions.hmac_type IS
  'HMAC-SHA256 blind index of transaction type (e.g. sale, expense). '
  'Populated for v4+ orgs only.';

COMMENT ON COLUMN public.transactions.hmac_asset IS
  'HMAC-SHA256 blind index of transaction asset (BTC, USD, etc.). '
  'Populated for v4+ orgs only.';
