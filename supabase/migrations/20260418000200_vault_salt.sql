-- Per-org vault salt for new vaults (finding #14).
--
-- Previously src/lib/vault.ts used a deterministic salt derived purely
-- from the user_id (a fixed prefix + userId). Consequences:
--   * Same user + same password = same MEK forever across orgs.
--   * A password rotation does not rotate the derived key because the
--     salt never changes.
--   * An offline attacker who gets the verifier + user_id can grind
--     passwords indefinitely against a single known-plaintext; no
--     per-org entropy widens the search space.
--
-- Add:
--   * org_settings.vault_salt text, base64 of 32 random bytes, set at
--     vault setup time. NULL for orgs created before this migration
--     (their unlock path continues to use the v1 deterministic salt).
--   * org_settings.vault_key_version integer, 1 for legacy, 2 for the
--     new per-org scheme. Used at unlock time to decide which
--     derivation function runs.
--
-- No data is rewritten. Existing ciphertext stays readable under v1.
-- Future key-rotation work (see docs/OWB-USER-MANAGEMENT-ZKA.md) can
-- upgrade orgs in-place by re-wrapping ciphertext once.

alter table public.org_settings
  add column if not exists vault_salt text;

alter table public.org_settings
  add column if not exists vault_key_version integer default 1;

comment on column public.org_settings.vault_salt is
  'Base64 of 32 random bytes. Combined with the user id to form the PBKDF2 salt when vault_key_version >= 2. NULL for legacy v1 vaults (deterministic salt).';

comment on column public.org_settings.vault_key_version is
  'Which vault derivation scheme this org uses. 1 = deterministic salt (legacy). 2 = per-org random salt.';
