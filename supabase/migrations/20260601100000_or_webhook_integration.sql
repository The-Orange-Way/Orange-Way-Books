-- OR ↔ OWB webhook handshake, schema additions.
--
-- Two changes:
--   1. organizations.or_subaccount_id, server-side mirror of the
--      browser's localStorage subaccount cache. Set by or-proxy after a
--      successful or-provision call; queried by or-webhook-receiver to
--      map subaccount_id → org_id when OR delivers sync.completed events.
--      Mirrors the sibling personal-finance app's user_profiles.or_subaccount_id pattern but at the
--      org grain since OWB is org-based (one subaccount per org).
--
--   2. sync_events, append-only log of sync.completed receipts.
--      The Connections page subscribes via Supabase realtime so the UI
--      refreshes the moment OR finishes a sync. or_event_id has a unique
--      constraint so OR retries collapse to a single row.
--
-- Both changes are forward-additive; the columns/tables don't exist on
-- DEV today, so a brand new migration is the right shape (no ALTER on
-- columns that don't exist anywhere).

-- 1. organizations.or_subaccount_id
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS or_subaccount_id TEXT NULL;

-- Unique so a stale subaccount_id can't be claimed by two orgs. Partial
-- so NULL rows don't trip the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS organizations_or_subaccount_id_uniq
  ON public.organizations (or_subaccount_id)
  WHERE or_subaccount_id IS NOT NULL;

COMMENT ON COLUMN public.organizations.or_subaccount_id IS
  'OR-side subaccount UUID for this org. Written by or-proxy after a successful or-provision. Read by or-webhook-receiver to resolve subaccount_id → org_id.';

-- 2. sync_events
CREATE TABLE IF NOT EXISTS public.sync_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  or_connection_id TEXT NULL,
  synced_count    INTEGER NULL,
  or_ts           TIMESTAMPTZ NULL,
  or_event_id     UUID NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: OR retries deliver the same event.id; the index collapses
-- duplicates and lets the receiver upsert with onConflict=or_event_id.
CREATE UNIQUE INDEX IF NOT EXISTS ux_sync_events_or_event_id
  ON public.sync_events (or_event_id);

-- Index for the Connections page's realtime subscription / recent-events
-- query (org_id + created_at DESC).
CREATE INDEX IF NOT EXISTS ix_sync_events_org_id_created_at
  ON public.sync_events (org_id, created_at DESC);

ALTER TABLE public.sync_events ENABLE ROW LEVEL SECURITY;

-- Members of an org can SELECT their org's sync_events. INSERT happens
-- only via the service-role from or-webhook-receiver, so no INSERT policy
-- is needed (RLS-deny-default + service-role-bypass handles it).
DROP POLICY IF EXISTS sync_events_select ON public.sync_events;
CREATE POLICY sync_events_select ON public.sync_events
  FOR SELECT TO authenticated
  USING (
    org_id IN (
      SELECT om.org_id FROM public.org_members om WHERE om.user_id = auth.uid()
    )
  );

COMMENT ON TABLE public.sync_events IS
  'OR sync.completed receipts. Inserted by or-webhook-receiver after HMAC verification. RLS lets each org see only its own events.';
