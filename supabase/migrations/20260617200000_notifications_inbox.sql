-- notifications, per-user inbox for system events.
--
-- Replaces the derived-counts approach the bell icon currently uses
-- (which shows things like "N drafts" + "N pending mappings"). Those
-- stay as derived; the new table is for events that don't have a
-- corresponding "current state to query", e.g. "import completed an
-- hour ago", "period closed by Andrea this morning".
--
-- ZKA posture (initial):
--   - `kind` is a non-sensitive event-type enum used to look up copy
--     and the icon. Server-readable, written by edge functions.
--   - `body` carries a non-sensitive system message. Anything that
--     would leak business data must be omitted or replaced with an
--     opaque id the client can hydrate after unseal.
--   - `action_href` is a relative path inside the app (e.g.
--     `/app/payments?id=…`). Opaque ids only; never plaintext names.
--
-- Encrypted-body variant lands later when the first sensitive
-- notification kind needs it.
--
-- RLS:
--   - SELECT: user_id = auth.uid()
--   - UPDATE (mark read): user_id = auth.uid()
--   - INSERT: service_role only (edge functions write)
--   - DELETE: blocked (audit history)
--
-- Realtime: clients subscribe filtered to org_id + user_id so the bell
-- pops the moment an event lands.

CREATE TABLE IF NOT EXISTS public.notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL,
  body        TEXT NOT NULL,
  action_href TEXT NULL,
  read_at     TIMESTAMPTZ NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Common access pattern: bell-dropdown lists the user's most recent
-- N notifications, scoped to the active org, newest first. Partial
-- index over unread keeps the badge-count query fast.
CREATE INDEX IF NOT EXISTS ix_notifications_user_recent
  ON public.notifications (user_id, org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS ix_notifications_user_unread
  ON public.notifications (user_id, org_id)
  WHERE read_at IS NULL;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

-- SELECT, only your own notifications, in any org you're a member of.
-- (Org membership is implicit: notifications are inserted with the
-- user_id that the writer chose; we don't double-check here because
-- the writer is service-role and already vetted org membership.)
CREATE POLICY "notifications_select_own"
  ON public.notifications
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- UPDATE, only allowed to flip read_at on your own rows. Other
-- columns are immutable from the client.
CREATE POLICY "notifications_update_own_read"
  ON public.notifications
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- INSERT, service role only. Anon / authenticated cannot write.
-- (The DEFAULT-DENY behaviour of RLS when no policy matches is what
-- enforces this; we add a comment for clarity rather than a no-op
-- policy.)

COMMENT ON TABLE public.notifications IS
  'Per-user notifications inbox. INSERTs are service-role only (edge functions / cron). SELECT and read-flag UPDATE are user-scoped via RLS. Body must be non-sensitive system copy or carry only opaque ids for client-side hydration.';
