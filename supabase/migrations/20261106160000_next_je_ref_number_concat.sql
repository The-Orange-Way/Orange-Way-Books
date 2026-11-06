-- next_je_ref_number: build the label with || and stop cutting numbers at 10,000 (OWB-T0228).
--
-- The earlier definitions joined the parts with a single |, which is not text concatenation, so
-- the call raised an error instead of returning a label. They also padded with LPAD(v_seq, 4),
-- which cuts a longer number to four characters: the 10,000th entry of a year came back as
-- JE-YYYY-1000, the same label as the 1,000th. Numbers now pad to at least four digits and are
-- never cut. The signature, the capability check and the grants are unchanged.

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

  RETURN 'JE-' || p_year::text || '-'
    || CASE WHEN v_seq < 10000 THEN LPAD(v_seq::text, 4, '0') ELSE v_seq::text END;
END;
$$;

REVOKE ALL ON FUNCTION public.next_je_ref_number(UUID, SMALLINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.next_je_ref_number(UUID, SMALLINT) TO authenticated;

COMMENT ON FUNCTION public.next_je_ref_number IS
  'Atomically mints the next internal JE ref number (JE-YYYY-NNNN, more digits from 10,000) for an org. Returned string is the plaintext label the browser encrypts into encrypted_ref_number before insert. SECURITY DEFINER; gated on journal_entries.write capability.';
