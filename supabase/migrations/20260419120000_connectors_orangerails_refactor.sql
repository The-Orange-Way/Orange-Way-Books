-- Refactor `connectors` table for the OrangeRails hub model.
--
-- The old schema assumed Orange Way Books stored provider credentials directly
-- (blink API keys, exchange tokens, etc.) encrypted with the user's vault.
-- Under the new architecture, Orange Way Books never sees raw provider credentials.
-- OrangeRails holds the encrypted credentials; Orange Way Books holds only an
-- OrangeRails access token.
--
-- See: https://github.com/MorningRevolution/orangerails/blob/main/docs/OrangeRails-Architecture.md

-- Drop columns that stored credentials directly. Orange Way Books will never use them.
alter table public.connectors
  drop column if exists encrypted_label,
  drop column if exists config_encrypted;

-- Add columns to store the OrangeRails access_token and the OR-side user id.
alter table public.connectors
  add column if not exists or_access_token text,
  add column if not exists or_user_id text,
  add column if not exists or_connection_ids text[];

-- Widen the connector_type check constraint. In the new model, everything
-- goes through OrangeRails, so the only connector_type Orange Way Books knows about
-- is 'orangerails'. We keep the column in case we ever need to distinguish
-- direct integrations from OrangeRails-mediated ones.
alter table public.connectors
  drop constraint if exists connectors_connector_type_check;

alter table public.connectors
  add constraint connectors_connector_type_check
  check (connector_type in ('orangerails', 'blink', 'exchange', 'bank'));

-- Drop the old unique index (org_id, connector_type). A user may have
-- multiple OrangeRails connections over time (though typically one at a time).
drop index if exists idx_connectors_org_type;

-- Update status constraint to include 'revoked' for when the user revokes
-- the access token but wants to keep the history for audit.
alter table public.connectors
  drop constraint if exists connectors_status_check;

alter table public.connectors
  add constraint connectors_status_check
  check (status in ('connected', 'disconnected', 'error', 'revoked'));
