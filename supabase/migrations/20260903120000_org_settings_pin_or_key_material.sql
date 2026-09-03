-- OWB-T0151: pin the Orange Rails key material on public.org_settings.
--
-- src/lib/or/or-key-material.ts (slice 1, OWB-T0085) reads three columns that do
-- not exist in Books yet. The module has no callers today, so nothing is broken;
-- slice 4 (OWB-T0088) is the first caller and needs these to exist.
--
-- THE TABLE IS org_settings, NOT vault_metadata. Verified against the live OWB
-- dev schema rather than mirrored from Orange-Way-Me:
--   * Books has no vault_metadata table and no kdf_salt column in public.
--   * public.user_vault_keys is PER USER, which is the wrong grain. The Orange
--     Rails key material is ORG scoped and the module takes an orgSalt.
--   * public.org_settings is keyed on org_id and already carries the org-scoped
--     vault state: vault_salt, enc_mek_ciphertext, vault_key_version.
--
-- or_subkey_salt exists precisely to record which vault_salt was in force when
-- the material was pinned, so it belongs next to vault_salt.
--
-- TWO CONSTRAINTS THAT ARE NOT STYLE.
--
-- 1. or_key_epoch is `integer`, NOT numeric and NOT bigint-as-numeric. PostgREST
--    returns a Postgres numeric as a JSON string and only the integer types as a
--    JSON number. The client's readEpoch tolerates both shapes today, so this is
--    defence in depth rather than the only guard. But if that guard were ever
--    simplified, every row with fully pinned material would read as half
--    established, fall into the refuse branch, and disable Orange Rails for
--    exactly the customers who DO have the material, while naming the wrong cause.
--
-- 2. All three are nullable with NO DEFAULT. Specifically not NOT NULL DEFAULT ''.
--    The client treats a zero-length string as ABSENT: hasCiphertext and hasSalt
--    test length > 0. So '' plus '' plus a null generation gives anyPresent =
--    false and the plan falls straight through to derive-and-pin. A DEFAULT ''
--    would turn that into a day-one data-loss path: a customer with sealed Orange
--    Rails rows would derive a fresh key against the current salt, pin it as
--    authoritative, and report success, while every row they had already synced
--    stops opening forever with nothing on screen to say so. Null means "not
--    established", which is what the client is built to read.
--
-- ZKA. None of these is a secret the server can use. enc_or_mek_ciphertext is
-- sealed under the org MEK, which the server never holds; or_subkey_salt and
-- or_key_epoch are not secret.
--
-- NO NEW RLS POLICY, DELIBERATELY. All four existing org_settings policies are
-- row filters scoped by org_id (settings_select via org_members, and the
-- insert/update/delete capability policies via user_has_capability(..., org_id)).
-- RLS filters rows, not columns, so new columns inherit the existing scoping.
-- Adding a policy here would wrongly imply the existing ones do not cover them.
--
-- REVERSIBLE. The undo is:
--   alter table public.org_settings
--     drop column if exists enc_or_mek_ciphertext,
--     drop column if exists or_subkey_salt,
--     drop column if exists or_key_epoch;
--
-- IDEMPOTENT. add column if not exists, so a re-run is a no-op.

begin;

alter table public.org_settings
  add column if not exists enc_or_mek_ciphertext text,
  add column if not exists or_subkey_salt text,
  add column if not exists or_key_epoch integer;

comment on column public.org_settings.enc_or_mek_ciphertext is
  'Orange Rails MEK bytes sealed under the org MEK (base64 iv||ct||tag). Null until first established by the client. Never derivable by the server.';

comment on column public.org_settings.or_subkey_salt is
  'The vault_salt in force when enc_or_mek_ciphertext was established. Pinned so the Orange Rails subkeys stop moving when vault_salt rotates. Not secret.';

comment on column public.org_settings.or_key_epoch is
  'Generation of the pinned pair (enc_or_mek_ciphertext, or_subkey_salt). Always 1 today. A client that meets a generation it does not know refuses rather than guessing. Not secret.';

commit;
