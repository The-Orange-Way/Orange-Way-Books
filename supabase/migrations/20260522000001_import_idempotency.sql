-- ============================================================================
-- Import idempotency + safe re-import, ZKA-aware rewrite
-- ============================================================================
--
-- Goal: re-running an import (e.g. OR re-pushes Wave data after a mapping
-- fix) must not create duplicate journal entries.
--
-- ZKA constraint: journal_entries at ZKA L2 stores encrypted values in the
-- `ref_number`, `memo`, `currency`, `status`, `source_type` columns. AES-GCM
-- uses a fresh IV every call, so the same plaintext yields different
-- ciphertext each time. A UNIQUE INDEX on `ref_number` would let duplicates
-- through.
--
-- Solution: use the existing HMAC blind-index pattern
-- (precedent: 20260421120000_vault_v4_mek_wrapping.sql added hmac_name on
-- contacts and hmac_type / hmac_asset on transactions). The browser computes
-- a deterministic HMAC-SHA256 of the source's external identifier using the
-- per-org blind-index key (derived from MEK via HKDF, stable across password
-- changes). Same plaintext → same HMAC. Unique constraint works as intended.
-- Server only sees the HMAC, never the plaintext.
--
-- The ref_number column stays encrypted in place (the standard ZKA pattern); it
-- still holds the human-readable label like "WAVE-1402..." after decryption,
-- shown in the UI. The HMAC is purely an orchestration column for dedup.
--
-- Pattern, with the hmac_<field> column naming convention:
--   hmac_import_external_id  HMAC blind index of "<source>-<externalId>"
--                            e.g. HMAC("wave-1402433495770403519")
--                            or for opening balances HMAC("open-bal-2024-01-01")
--   import_job_id            FK to import_jobs row that created this JE
--                            (plaintext orchestration; ON DELETE SET NULL
--                            preserves the JE if the job is removed)
--
-- Re-import flow:
--   1. Old import_job exists with JE rows linked via import_job_id.
--   2. User clicks "Re-import": purge_import_job_artifacts(old_job_id) deletes
--      those JEs (lines cascade).
--   3. New import_job inserted; new JEs use the same hmac_import_external_id
--      values (recomputed from the same source IDs) without conflict.
--
-- Audit logging is left to the calling client so it can encrypt the summary
-- per ZKA L2 (server-side INSERT cannot encrypt).

-- ----------------------------------------------------------------------------
-- 1. New columns on journal_entries
-- ----------------------------------------------------------------------------

ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS hmac_import_external_id TEXT NULL,
  ADD COLUMN IF NOT EXISTS import_job_id UUID NULL
    REFERENCES public.import_jobs(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.journal_entries.hmac_import_external_id IS
  'HMAC-SHA256 blind index of "<source>-<externalId>". Used for ZKA-safe import dedup. '
  'Browser computes this via VaultContext.blindIndex() before insert. '
  'Same precedent as contacts.hmac_name (20260421120000). NULL for internal/manual JEs.';

COMMENT ON COLUMN public.journal_entries.import_job_id IS
  'Link to the import_jobs row that created this JE. '
  'ON DELETE SET NULL preserves the JE if the import job is removed (audit safety). '
  'Plaintext orchestration metadata; same precedent as import_jobs.source_type.';

-- ----------------------------------------------------------------------------
-- 2. Idempotency: unique on the HMAC blind index per org
-- ----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_hmac_import_ext
  ON public.journal_entries (org_id, hmac_import_external_id)
  WHERE hmac_import_external_id IS NOT NULL;

COMMENT ON INDEX public.uq_journal_entries_hmac_import_ext IS
  'P5 idempotency. Prevents duplicate imports + duplicate opening-balance JEs. '
  'Browser must compute hmac_import_external_id deterministically (same source '
  '+ externalId yields same hash) for the same row.';

-- Helper index: efficiently find JEs by import_job_id (for purge + listing)
CREATE INDEX IF NOT EXISTS idx_journal_entries_import_job
  ON public.journal_entries (import_job_id)
  WHERE import_job_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 3. Year-prefixed sequence for internal ref_number minting (JE-YYYY-NNNN)
-- ----------------------------------------------------------------------------
--
-- The minted ref_number is the HUMAN-READABLE label ("JE-2025-0042") that the
-- browser ENCRYPTS into journal_entries.ref_number before insert. The
-- sequence itself stores plaintext counters (org_id + year + last_seq are
-- non-sensitive orchestration). This mirrors the existing next_invoice_number
-- pattern shipped in the invoicing module.

CREATE TABLE IF NOT EXISTS public.je_ref_sequence (
  org_id   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  year     SMALLINT NOT NULL CHECK (year BETWEEN 1900 AND 2999),
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, year)
);

ALTER TABLE public.je_ref_sequence ENABLE ROW LEVEL SECURITY;

CREATE POLICY je_ref_sequence_select ON public.je_ref_sequence
  FOR SELECT TO authenticated
  USING (public.user_has_capability(auth.uid(), 'transactions.write', org_id));

COMMENT ON TABLE public.je_ref_sequence IS
  'Per-(org, year) atomic counter for internal JE ref_numbers (JE-YYYY-NNNN). '
  'The minted ref is the human-readable label that gets encrypted into '
  'journal_entries.ref_number before insert. Updated only via next_je_ref_number RPC.';

-- ----------------------------------------------------------------------------
-- 4. Atomic next-number minting RPC
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.next_je_ref_number(
  p_org_id UUID,
  p_year   SMALLINT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_seq INTEGER;
BEGIN
  IF NOT public.user_has_capability(auth.uid(), 'transactions.write', p_org_id) THEN
    RAISE EXCEPTION 'requires transactions.write capability for org %', p_org_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.je_ref_sequence (org_id, year, last_seq)
    VALUES (p_org_id, p_year, 1)
  ON CONFLICT (org_id, year) DO UPDATE
    SET last_seq = public.je_ref_sequence.last_seq + 1
  RETURNING last_seq INTO v_seq;

  RETURN 'JE-' | p_year::text | '-' | LPAD(v_seq::text, 4, '0');
END;
$$;

REVOKE ALL ON FUNCTION public.next_je_ref_number(UUID, SMALLINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_je_ref_number(UUID, SMALLINT) TO authenticated;

COMMENT ON FUNCTION public.next_je_ref_number IS
  'Atomically mints the next internal JE ref number (JE-YYYY-NNNN) for an org. '
  'The returned string is the plaintext label the browser must encrypt before '
  'inserting into journal_entries.ref_number. SECURITY DEFINER; gated on '
  'transactions.write capability.';

-- ----------------------------------------------------------------------------
-- 5. Re-import purge RPC
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.purge_import_job_artifacts(
  p_import_job_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_org_id    UUID;
  v_je_count  INTEGER := 0;
BEGIN
  SELECT org_id INTO v_org_id
  FROM public.import_jobs
  WHERE id = p_import_job_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'import_job % not found', p_import_job_id
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.user_has_capability(auth.uid(), 'transactions.write', v_org_id) THEN
    RAISE EXCEPTION 'requires transactions.write capability for org %', v_org_id
      USING ERRCODE = '42501';
  END IF;

  -- Delete JEs created by this import_job (journal_entry_lines cascade via FK)
  WITH deleted AS (
    DELETE FROM public.journal_entries
    WHERE import_job_id = p_import_job_id
      AND org_id = v_org_id
    RETURNING id
  )
  SELECT COUNT(*) INTO v_je_count FROM deleted;

  RETURN json_build_object(
    'import_job_id', p_import_job_id,
    'org_id', v_org_id,
    'journal_entries_deleted', v_je_count
  );
END;
$$;

REVOKE ALL ON FUNCTION public.purge_import_job_artifacts(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.purge_import_job_artifacts(UUID) TO authenticated;

COMMENT ON FUNCTION public.purge_import_job_artifacts IS
  'P5 safe re-import. Deletes all journal_entries (lines cascade via FK) created '
  'by an import_job. SECURITY DEFINER; gated on transactions.write capability. '
  'Caller writes the audit_logs entry (ZKA: summary needs browser-side encryption).';
