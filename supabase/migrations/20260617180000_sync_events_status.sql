-- sync_events.status — track failed + deleted alongside completed.
--
-- The or-webhook-receiver previously only handled `sync.completed` and
-- 202-ACKed every other event type without persisting. Adding `status`
-- lets us record the full lifecycle: connection.failed surfaces a UI
-- signal so users see when OR's side gave up retrying; connection.deleted
-- lets the Connections page hide the row without polling.
--
-- Values: 'completed' (default) | 'failed' | 'deleted'.
--
-- Forward-additive: existing rows keep the default ('completed') which
-- preserves prior semantics — every row already in the table came from
-- a sync.completed delivery.
--
-- Refs:
--   Feature-parity work for the connector pipeline.

ALTER TABLE public.sync_events
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';

ALTER TABLE public.sync_events
  DROP CONSTRAINT IF EXISTS sync_events_status_check;

ALTER TABLE public.sync_events
  ADD CONSTRAINT sync_events_status_check
  CHECK (status IN ('completed', 'failed', 'deleted'));

-- Partial index for the Connections page's "show me anything that needs
-- attention" badge query. Most rows are 'completed' so a full index would
-- be wasteful — this stays small.
CREATE INDEX IF NOT EXISTS ix_sync_events_status_attention
  ON public.sync_events (org_id, created_at DESC)
  WHERE status IN ('failed', 'deleted');

COMMENT ON COLUMN public.sync_events.status IS
  'Lifecycle of the OR-side event: completed (default), failed (OR gave up retrying the source), or deleted (the OR connection was deleted upstream).';
