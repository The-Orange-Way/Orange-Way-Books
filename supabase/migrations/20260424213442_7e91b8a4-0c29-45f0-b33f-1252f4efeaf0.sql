BEGIN;

ALTER TABLE public.key_rotation_jobs
  ADD COLUMN IF NOT EXISTS refresh_mode TEXT NOT NULL DEFAULT 'quick';

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

DROP POLICY IF EXISTS "pending_admin_emails_select_service" ON public.pending_admin_emails;
DROP POLICY IF EXISTS "pending_admin_emails_insert_service" ON public.pending_admin_emails;
DROP POLICY IF EXISTS "pending_admin_emails_update_service" ON public.pending_admin_emails;
DROP POLICY IF EXISTS "pending_admin_emails_delete_service" ON public.pending_admin_emails;

COMMENT ON TABLE public.pending_admin_emails IS
  'Phase 4.5 polish: outbox for transactional admin emails composed '
  'client-side (ZKA — server never sees ciphertext). Drained by an '
  'external sender daemon. Service-role access only.';

COMMIT;