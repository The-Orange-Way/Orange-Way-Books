-- ============================================================
-- Phase 4.5 polish, Quick vs Deep refresh mode
--                  + first-time-setup welcome email queue
-- ============================================================
--
-- Two small additions on top of the 20260426000000_phase4_5_hard_rekey
-- migration. Both are additive, idempotent, and safe to run on orgs
-- that haven't rotated yet.
--
-- 1. key_rotation_jobs.refresh_mode, NEW column
--
--    Quick: version-bump-only fast path. New security codes generated
--           + wrapped per member; existing row ciphertext stays on disk
--           but dek_key_version is bumped. Removed members are cut off
--           from future data but cached historical ciphertext remains
--           readable under the old DEK during the 30-day rollback
--           window. Default for routine refreshes and post-revoke.
--
--    Deep:  every row is decrypted under the old DEK and re-encrypted
--           under the new DEK. Maximum protection, even previously-
--           cached ciphertext becomes meaningless. Use for suspected
--           compromise, audits, or first-time hardening.
--
--    Existing rows default to 'quick' (the behavior before this split).
--
-- 2. pending_admin_emails, NEW table
--
--    Outbox table for transactional admin emails composed by the
--    client (ZKA-correct: the server doesn't touch the ciphertext;
--    the client passes the decrypted body + recipient). An external
--    sender daemon (Resend / Supabase SMTP) drains this table later.
--
--    The queue-admin-email edge function writes rows here with
--    status='pending'. The sender flips them to 'sent' or 'failed'
--    and stamps sent_at.
--
-- Idempotent: every statement is guarded. Running twice is a no-op.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- 1. key_rotation_jobs.refresh_mode
-- ══════════════════════════════════════════════════════════════════════

ALTER TABLE public.key_rotation_jobs
  ADD COLUMN IF NOT EXISTS refresh_mode TEXT NOT NULL DEFAULT 'quick';

-- Constrain to quick | deep. Named so a re-run can drop + recreate
-- without leaving orphan constraints.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'key_rotation_jobs_refresh_mode_check'
       AND conrelid = 'public.key_rotation_jobs'::regclass
  ) THEN
    ALTER TABLE public.key_rotation_jobs
      ADD CONSTRAINT key_rotation_jobs_refresh_mode_check
      CHECK (refresh_mode IN ('quick', 'deep'));
  END IF;
END;
$$;

COMMENT ON COLUMN public.key_rotation_jobs.refresh_mode IS
  'quick = version-bump-only fast path (default). '
  'deep = decrypt + re-encrypt every row under the new DEK. '
  'Customer-facing strings use "Quick refresh" / "Deep refresh".';


-- ══════════════════════════════════════════════════════════════════════
-- 2. pending_admin_emails, outbox queue
-- ══════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.pending_admin_emails (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  to_email    TEXT NOT NULL,
  subject     TEXT NOT NULL,
  body_text   TEXT NOT NULL,
  body_html   TEXT,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'sent', 'failed')),
  sent_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pending_admin_emails_status_created
  ON public.pending_admin_emails(status, created_at)
  WHERE status = 'pending';

ALTER TABLE public.pending_admin_emails ENABLE ROW LEVEL SECURITY;

-- Service role only. No authenticated-user RLS policy, all access
-- goes through the queue-admin-email edge function (insert) and the
-- sender daemon (select + update), both of which use the service key.
-- Revoking any implicit SELECT for authenticated users:

DROP POLICY IF EXISTS "pending_admin_emails_select_service" ON public.pending_admin_emails;
DROP POLICY IF EXISTS "pending_admin_emails_insert_service" ON public.pending_admin_emails;
DROP POLICY IF EXISTS "pending_admin_emails_update_service" ON public.pending_admin_emails;
DROP POLICY IF EXISTS "pending_admin_emails_delete_service" ON public.pending_admin_emails;

-- No policies granted to authenticated role → with RLS enabled, their
-- queries return zero rows. Service role bypasses RLS automatically.

COMMENT ON TABLE public.pending_admin_emails IS
  'Phase 4.5 polish: outbox for transactional admin emails composed '
  'client-side (ZKA, server never sees ciphertext). Drained by an '
  'external sender daemon. Service-role access only.';

COMMIT;
