-- Phase 1, Migration 6/9: Recreate helper functions against the new schema.
--
-- Restores: next_je_ref_number, purge_import_job_artifacts, je_ref_sequence.
-- These were dropped in migration 1/9 because they referenced the old schema;
-- their signatures and behavior are unchanged from 20260522000001, they just
-- need to be recreated AFTER the new journal_entries table exists.

-- Per-(org, year) atomic counter for internal JE ref numbers ("JE-YYYY-NNNN").
-- The minted plaintext label is ENCRYPTED client-side and stored in
-- journal_entries.encrypted_ref_number on insert.
CREATE TABLE public.je_ref_sequence (
  org_id   UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  year     SMALLINT NOT NULL CHECK (year BETWEEN 1900 AND 2999),
  last_seq INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, year)
);

ALTER TABLE public.je_ref_sequence ENABLE ROW LEVEL SECURITY;

CREATE POLICY je_ref_sequence_select
  ON public.je_ref_sequence
  FOR SELECT TO authenticated
  USING (public.user_has_capability(auth.uid(), 'journal_entries.write', org_id));

COMMENT ON TABLE public.je_ref_sequence IS
  'Per-(org, year) atomic counter for internal JE ref_numbers (JE-YYYY-NNNN). The minted ref is the human-readable label that gets encrypted into journal_entries.encrypted_ref_number before insert. Updated only via next_je_ref_number RPC.';

-- next_je_ref_number, atomic mint
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
  IF NOT public.user_has_capability(auth.uid(), 'journal_entries.write', p_org_id) THEN
    RAISE EXCEPTION 'requires journal_entries.write capability for org %', p_org_id
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
  'Atomically mints the next internal JE ref number (JE-YYYY-NNNN) for an org. Returned string is the plaintext label the browser encrypts into encrypted_ref_number before insert. SECURITY DEFINER; gated on journal_entries.write capability.';

-- purge_import_job_artifacts, safe re-import. Deletes all JEs created by an
-- import_job; lines cascade via journal_entry_lines.journal_entry_id FK.
-- Caller writes the audit_logs entry (ZKA: summary needs client-side encryption).
CREATE OR REPLACE FUNCTION public.purge_import_job_artifacts(
  p_import_job_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_org_id   UUID;
  v_je_count INTEGER := 0;
BEGIN
  SELECT org_id INTO v_org_id FROM public.import_jobs WHERE id = p_import_job_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'import_job % not found', p_import_job_id USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.user_has_capability(auth.uid(), 'journal_entries.write', v_org_id) THEN
    RAISE EXCEPTION 'requires journal_entries.write capability for org %', v_org_id
      USING ERRCODE = '42501';
  END IF;

  -- NB: this works around the immutability trigger only if the JEs to delete
  -- are in DRAFT status. Posted import-job artifacts cannot be silently
  -- purged, the user must reverse them via the standard reversal flow first.
  -- This matches the existing P5 semantics and is intentional.
  WITH deleted AS (
    DELETE FROM public.journal_entries
    WHERE import_job_id = p_import_job_id
      AND org_id = v_org_id
      AND status = 'DRAFT'
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
  'P5 safe re-import. Deletes DRAFT journal_entries (lines cascade) created by an import_job. Cannot purge posted artifacts, user must reverse those first via the standard flow. SECURITY DEFINER; gated on journal_entries.write capability.';
