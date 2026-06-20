-- Drop legacy vault key-version upgrade RPCs.
--
-- The client-side orchestrator (vault-migration.ts) was removed when the
-- key derivation strategy registry collapsed to a single entry. The RPCs
-- themselves remained executable by any authenticated user and could
-- still write rows with `vault_key_version = 3` or `= 4` into
-- `public.org_settings`, leaving the org unreadable by the current
-- unlock path which only knows version 1.
--
-- Drop the upgrade RPCs and the attachment-rekey variants so no caller
-- can put a row into a state the new code refuses to unlock.

DROP FUNCTION IF EXISTS public.rpc_upgrade_vault_to_v3(jsonb);
DROP FUNCTION IF EXISTS public.rpc_upgrade_vault_to_v3_with_attachments(jsonb);
DROP FUNCTION IF EXISTS public.rpc_upgrade_vault_to_v4(jsonb);
DROP FUNCTION IF EXISTS public.rpc_upgrade_vault_to_v4_with_attachments(jsonb);
