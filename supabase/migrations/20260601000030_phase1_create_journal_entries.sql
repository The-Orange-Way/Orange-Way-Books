-- Phase 1 — Migration 3/9: Create `journal_entries` with the locked end-state schema.
--
-- D9 (locked 2026-05-30): `status` and `source_type` are PLAINTEXT in this redesign.
-- The server needs to read them to enforce immutability (trigger pair gates
-- on plaintext status to decide whether to lock the row). The leak is structural-
-- metadata-only — same six possible values for every customer in every accounting
-- system. No customer content. Future Level 3 ZKP work would let us migrate back
-- to encrypted status with proof-of-state; design accommodates that.
--
-- Everything else customer-meaningful is encrypted: memo, ref_number, currency,
-- exchange_rate, period_locked, plus encrypted_metadata for any future fields.

CREATE TABLE public.journal_entries (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- Plaintext structural metadata
  date                        DATE NOT NULL DEFAULT CURRENT_DATE,
  status                      TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'POSTED', 'VOID', 'VOID_REVERSAL')),
  source_type                 TEXT NULL
    CHECK (source_type IS NULL OR source_type IN (
      'manual',          -- user typed it directly
      'or_import',       -- Orange Rails sync
      'invoice',         -- created by invoice posting flow
      'payment',         -- created by payment recording flow
      'void_reversal',   -- created by a void operation (this is the reversing entry)
      'fx_revaluation',  -- created by FX revaluation wizard
      'opening_balance', -- created by wallet opening-balance flow
      'takeout_import'   -- created by takeout data restore
    )),
  reversal_of_id              UUID NULL REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  hmac_import_external_id     TEXT NULL,                   -- ZKA-aware idempotency for imports (HMAC blind index)
  import_job_id               UUID NULL REFERENCES public.import_jobs(id) ON DELETE SET NULL,
  key_version                 INT  NOT NULL DEFAULT 2,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Encrypted (ZKA L2) — server cannot read any of these
  encrypted_memo              TEXT NULL,
  encrypted_ref_number        TEXT NULL,
  encrypted_currency          TEXT NOT NULL,
  encrypted_exchange_rate     TEXT NULL,
  encrypted_period_locked     TEXT NULL,
  encrypted_metadata          JSONB NULL
);

CREATE INDEX idx_journal_entries_org             ON public.journal_entries (org_id);
CREATE INDEX idx_journal_entries_org_date        ON public.journal_entries (org_id, date);
CREATE INDEX idx_journal_entries_reversal_of_id  ON public.journal_entries (reversal_of_id) WHERE reversal_of_id IS NOT NULL;
CREATE INDEX idx_journal_entries_import_job      ON public.journal_entries (import_job_id)  WHERE import_job_id  IS NOT NULL;
CREATE INDEX idx_journal_entries_status          ON public.journal_entries (org_id, status);

-- Idempotency: ZKA-aware HMAC blind index. Browser computes HMAC-SHA256("<source>-<externalId>")
-- using a per-org key derived from MEK via HKDF. Same plaintext → same HMAC.
-- Same precedent as contacts.hmac_name + transactions.hmac_type (20260421120000).
CREATE UNIQUE INDEX uq_journal_entries_hmac_import_ext
  ON public.journal_entries (org_id, hmac_import_external_id)
  WHERE hmac_import_external_id IS NOT NULL;

-- Reversal integrity: an entry can be reversed at most once. Partial unique
-- on reversal_of_id forbids two journal_entries rows pointing at the same
-- original. The reversing entry's status is POSTED; the original's status
-- flips to VOID. Status flip is handled by the immutability trigger's
-- workflow-meta whitelist (next migration).
CREATE UNIQUE INDEX uq_journal_entries_reversal_of_id
  ON public.journal_entries (reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;

ALTER TABLE public.journal_entries ENABLE ROW LEVEL SECURITY;

-- SELECT: any org member
CREATE POLICY journal_entries_select
  ON public.journal_entries
  FOR SELECT TO authenticated
  USING (public.current_user_org_rank(org_id) IS NOT NULL);

-- INSERT/UPDATE/DELETE gated on capability system (matches existing 20260423010000 pattern)
CREATE POLICY journal_entries_insert
  ON public.journal_entries
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_capability(auth.uid(), 'journal_entries.write', org_id));

CREATE POLICY journal_entries_update
  ON public.journal_entries
  FOR UPDATE TO authenticated
  USING      (public.user_has_capability(auth.uid(), 'journal_entries.write', org_id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'journal_entries.write', org_id));

CREATE POLICY journal_entries_delete
  ON public.journal_entries
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'journal_entries.delete', org_id));

-- Period-lock RESTRICTIVE policy (lifted from 20260512070000_period_lock_rls.sql).
-- Blocks writes into a closed period unless caller has an active unlock session.
CREATE POLICY journal_entries_period_lock_insert
  ON public.journal_entries
  AS RESTRICTIVE
  FOR INSERT TO authenticated
  WITH CHECK (NOT public.is_date_in_closed_period(org_id, auth.uid(), date));

CREATE POLICY journal_entries_period_lock_update
  ON public.journal_entries
  AS RESTRICTIVE
  FOR UPDATE TO authenticated
  USING      (NOT public.is_date_in_closed_period(org_id, auth.uid(), date))
  WITH CHECK (NOT public.is_date_in_closed_period(org_id, auth.uid(), date));

COMMENT ON TABLE public.journal_entries IS
  'Locked end-state shape. status + source_type are plaintext to enable DB-enforced immutability. All customer-meaningful columns (memo, ref_number, currency, exchange_rate, period_locked) are encrypted.';

COMMENT ON COLUMN public.journal_entries.status IS
  'D9 plaintext (one of: DRAFT, POSTED, VOID, VOID_REVERSAL). Server reads this to enforce immutability via the trigger pair. Six possible values for every customer in every accounting system — structural metadata, not content.';

COMMENT ON COLUMN public.journal_entries.source_type IS
  'D9 plaintext (one of: manual, or_import, invoice, payment, void_reversal, fx_revaluation, opening_balance, takeout_import). Tells reports and audit which workflow created this entry. Not customer content.';

COMMENT ON COLUMN public.journal_entries.reversal_of_id IS
  'When this JE was created to void a prior JE (source_type=void_reversal), points at the original. NULL for original JEs. Partial unique index forbids double-reversal.';

COMMENT ON COLUMN public.journal_entries.hmac_import_external_id IS
  'HMAC-SHA256 blind index of "<source>-<externalId>". Browser computes this via VaultContext.blindIndex() using a per-org HKDF-derived key. ZKA-safe import dedup: same plaintext → same HMAC, server never sees plaintext.';
