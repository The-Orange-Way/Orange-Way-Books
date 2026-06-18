-- Add kdf_version so the client can tell which PBKDF2 parameter set was used
-- when the vault verifier was written.
--   v1 (implicit / NULL / 1) = 310,000 PBKDF2 iterations (legacy)
--   v2                       = 600,000 PBKDF2 iterations (OWASP 2023 minimum
--                              for PBKDF2-HMAC-SHA256)
-- Existing rows default to 1 so they unwrap with the original parameters.
-- New vaults written by the client set kdf_version = 2.

ALTER TABLE public.org_settings ADD COLUMN IF NOT EXISTS kdf_version INTEGER DEFAULT 1;
