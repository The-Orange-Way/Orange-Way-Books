-- ============================================================
-- Flash Wave 1, Layer 2 build: idempotency + lifecycle events.
-- ============================================================

BEGIN;

-- Idempotency-Key support on flash_payments. Allows create-flash-payment
-- to return an existing pending link on retry instead of minting a new one.
ALTER TABLE public.flash_payments
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE INDEX IF NOT EXISTS idx_flash_payments_idempotency_key
  ON public.flash_payments(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Audit log of subscription state-machine transitions. The daily
-- lifecycle cron appends a row at every status change so we can
-- replay a subscription's history without parsing webhook events.
CREATE TABLE IF NOT EXISTS public.subscription_lifecycle_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status TEXT NOT NULL,
  reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_subscription_lifecycle_events_sub
  ON public.subscription_lifecycle_events(subscription_id, occurred_at DESC);

ALTER TABLE public.subscription_lifecycle_events ENABLE ROW LEVEL SECURITY;
-- No policies: service_role only.

COMMIT;
