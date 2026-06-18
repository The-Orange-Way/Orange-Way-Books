-- Org ledger provisioning status
--
-- Background-provisioning state for the per-org legacy ledger backend chart of accounts.
-- The onboarding wizard now lets the user into the dashboard immediately
-- after the org + settings + vault verifier are persisted, then bootstraps
-- the 43-account chart + 10 templates sequentially in the background.
-- This column lets the UI know when it's safe to allow journal-entry /
-- transaction / payment writes, and lets us recover failed provisioning.
--
-- Why this matters: parallel (Promise.all) provisioning saturated legacy ledger backend's
-- internal sqlx pool (default 10 connections), causing some account
-- creations to silently fail and leaving orgs with gaps in their chart
-- of accounts. Sequential provisioning eliminates the pool pressure, and
-- this status column makes the in-progress state observable + resumable.
--
-- States:
--   pending      — wizard finished, background bootstrap not yet started
--   provisioning — background bootstrap is running
--   ready        — chart of accounts + templates fully provisioned
--   failed       — bootstrap errored; error stored in ledger_status_error
--

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS ledger_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (ledger_status IN ('pending', 'provisioning', 'ready', 'failed')),
  ADD COLUMN IF NOT EXISTS ledger_status_error TEXT NULL,
  ADD COLUMN IF NOT EXISTS ledger_provisioned_at TIMESTAMPTZ NULL;

-- Existing orgs (created before this migration) have already finished
-- the legacy parallel bootstrap. Mark them as 'ready' so the new UI
-- guards don't block them retroactively.
UPDATE public.organizations
   SET ledger_status = 'ready',
       ledger_provisioned_at = COALESCE(ledger_provisioned_at, created_at, now())
 WHERE ledger_status = 'pending'
   AND legacy_journal_id IS NOT NULL;

COMMENT ON COLUMN public.organizations.ledger_status IS
  'Background legacy ledger backend provisioning state. pending → provisioning → ready/failed. UI gates JE/transaction writes on ready.';
COMMENT ON COLUMN public.organizations.ledger_status_error IS
  'Last error message from a failed bootstrap. Null when status != failed.';
COMMENT ON COLUMN public.organizations.ledger_provisioned_at IS
  'Timestamp when ledger_status flipped to ready.';
