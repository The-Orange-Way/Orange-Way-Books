-- Phase 1 — Migration 9/9: Test fixtures + helper for pgTAP suite.
--
-- This is NOT a test runner. Tests live in supabase/tests/. This migration
-- only adds a SECURITY DEFINER helper that lets the test harness seed
-- rows without going through RLS (which would otherwise require a real
-- authenticated user with capabilities).
--
-- The helper is scoped to a test-only org UUID (`'00000000-0000-0000-0000-000000000001'`)
-- and refuses to operate on any other org.

CREATE OR REPLACE FUNCTION public.owb_test_seed_je(
  p_status        TEXT,
  p_lines         JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_test_org UUID := '00000000-0000-0000-0000-000000000001';
  v_je_id    UUID;
  v_line     JSONB;
BEGIN
  -- Refuse to operate outside the test org.
  IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = v_test_org) THEN
    INSERT INTO public.organizations (id, name) VALUES (v_test_org, 'pgtap-org')
      ON CONFLICT (id) DO NOTHING;
  END IF;

  INSERT INTO public.journal_entries (org_id, date, status, source_type, encrypted_currency)
    VALUES (v_test_org, CURRENT_DATE, p_status, 'manual', 'TESTCIPHERTEXT_USD')
    RETURNING id INTO v_je_id;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    -- Each line in p_lines: { "account_id": "...", "encrypted_debit": "...", "encrypted_credit": "..." }
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_id, encrypted_debit, encrypted_credit
    ) VALUES (
      v_je_id,
      (v_line->>'account_id')::UUID,
      v_line->>'encrypted_debit',
      v_line->>'encrypted_credit'
    );
  END LOOP;

  RETURN v_je_id;
END;
$$;

REVOKE ALL ON FUNCTION public.owb_test_seed_je(TEXT, JSONB) FROM PUBLIC;
-- Intentionally NOT granted to authenticated. Only callable via the postgres
-- role (which is what pgTAP runs as). Production clients cannot reach this.

COMMENT ON FUNCTION public.owb_test_seed_je IS
  'Test-only helper for pgTAP suite. Bypasses RLS to seed journal_entries + lines under the reserved test-org UUID. Refuses to operate on any other org. Not granted to authenticated role.';
