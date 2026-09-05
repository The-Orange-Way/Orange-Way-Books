-- Pin the Orange Rails key material for an org.
--
-- These three columns are read by src/lib/or/or-key-material.ts. They live on
-- org_settings, next to vault_salt / enc_mek_ciphertext / vault_key_version,
-- because this material is ORG scoped. Books has no vault_metadata table and
-- no kdf_salt column; its user_vault_keys table is per user, which is the
-- wrong grain for material the client resolves per org.
--
-- Column contract, relied on by the client:
--
--   enc_or_mek_ciphertext  text     nullable, no default
--       The Orange Rails MEK sealed under the org MEK. The server never holds
--       the org MEK, so this is opaque to it. Not a secret the server can use.
--
--   or_subkey_salt         text     nullable, no default
--       Records which org_settings.vault_salt was in force when the material
--       was pinned. Not secret.
--
--   or_key_epoch           integer  nullable, no default
--       MUST be integer, not numeric. PostgREST renders numeric as a JSON
--       string and only the integer types as a JSON number. The client's
--       readEpoch tolerates both today, so the type is defence in depth, but
--       if that guard were simplified a numeric column would make every fully
--       pinned row read as half established.
--
-- All three are nullable with NO DEFAULT, deliberately. The client treats a
-- zero length string as ABSENT (its hasCiphertext / hasSalt tests are
-- length > 0). A DEFAULT of '' would therefore make every untouched row look
-- like a partial write: the plan would fall through to derive-and-pin, seal a
-- fresh key as authoritative against the current salt, and report success,
-- while every row the customer had already synced stops opening. NULL means
-- "not established", which is the state the client is built to read.

alter table public.org_settings
  add column if not exists enc_or_mek_ciphertext text,
  add column if not exists or_subkey_salt        text,
  add column if not exists or_key_epoch          integer;

comment on column public.org_settings.enc_or_mek_ciphertext is
  'Orange Rails MEK sealed under the org MEK. Server cannot open it. NULL means not established; empty string is never written.';

comment on column public.org_settings.or_subkey_salt is
  'The org_settings.vault_salt that was in force when the Orange Rails key material was pinned. Not secret. NULL means not established.';

comment on column public.org_settings.or_key_epoch is
  'Generation counter for the pinned Orange Rails key material. integer, not numeric: PostgREST renders numeric as a JSON string. NULL means not established.';

-- No RLS change and no new policy, on purpose. org_settings already has RLS
-- enabled with four org scoped policies (settings_select, and the
-- org.manage capability policies for insert / update / delete). Postgres RLS
-- policies are ROW predicates, not column predicates, so new columns are
-- covered by the existing ones automatically. Adding a policy here would
-- wrongly imply the existing ones do not cover new columns.
--
-- No GRANT either: org_settings already grants authenticated arwd and grants
-- anon nothing, which is what these columns need.
