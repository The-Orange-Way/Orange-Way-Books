-- migration 20261106000000
-- Fix concurrent-edit 504: change stale-check ERRCODE from serialization_failure to PT409.
--
-- Root cause (OWB-T0238):
--   owb_edit_posted_entry raises ERRCODE = 'serialization_failure' (SQLSTATE 40001) when
--   p_expected_updated_at does not match the row's current updated_at. PostgREST treats 40001
--   as a standard Postgres serialization conflict and retries the transaction in a tight loop.
--   Session 2 acquires the FOR UPDATE row lock after Session 1 commits, then immediately hits
--   the stale check and raises 40001 again. PostgREST retries repeatedly until Cloudflare's
--   2-minute upstream timeout fires, returning a silent 504 with no feedback to the user.
--
-- Fix: ERRCODE 'PT409' tells PostgREST to return HTTP 409 Conflict immediately without
--   retrying. The error message reaches the Supabase JS client, error.message is set, and the
--   catch block shows the alert. One character-class change; full function body is otherwise
--   identical to migration 20261105230000.

CREATE OR REPLACE FUNCTION public.owb_edit_posted_entry(
  p_je_id            UUID,
  p_new_lines        JSONB,
  p_encrypted_reason TEXT,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_je            public.journal_entries%ROWTYPE;
  v_old_lines     JSONB;
  v_line          JSONB;
  v_account_id    UUID;
  v_debit_sum     NUMERIC := 0;
  v_credit_sum    NUMERIC := 0;
  v_version_id    UUID;
  v_new_je_id     UUID;
  v_i             INTEGER;
BEGIN
  -- Reason is required: p_encrypted_reason must be non-empty ciphertext.
  -- (The value is client-encrypted; we only check it is not blank.)
  IF p_encrypted_reason IS NULL OR btrim(p_encrypted_reason) = '' THEN
    RAISE EXCEPTION 'Say why you are correcting this entry.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Lock the row so a concurrent edit cannot interleave.
  SELECT * INTO v_je
    FROM public.journal_entries
   WHERE id = p_je_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry not found.'
      USING ERRCODE = 'no_data_found';
  END IF;

  -- Only posted entries can be edited in place.
  IF v_je.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted journal entries can be edited.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Refuse edits on reversal entries or entries that have already been reversed.
  IF v_je.is_reversal OR v_je.reversed_by IS NOT NULL THEN
    RAISE EXCEPTION 'Reversal entries and reversed entries cannot be edited.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Optimistic concurrency: if the caller supplied the version they read, make sure
  -- the entry has not been changed in the meantime.
  -- ERRCODE PT409: PostgREST maps PTxyz -> HTTP xyz (409 Conflict) and returns
  -- immediately without retrying. Using 'serialization_failure' (40001) here caused
  -- PostgREST to retry in a tight loop until the Cloudflare upstream timeout fired
  -- (silent 504). PT409 stops that loop on the first conflict.
  IF p_expected_updated_at IS NOT NULL
     AND v_je.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'This entry was changed after you opened it. Reload it and try again.'
      USING ERRCODE = 'PT409';
  END IF;

  -- Validate new lines: must be a non-empty array.
  IF p_new_lines IS NULL OR jsonb_array_length(p_new_lines) = 0 THEN
    RAISE EXCEPTION 'New journal entry lines cannot be empty.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Collect old lines for the version snapshot.
  SELECT jsonb_agg(
           jsonb_build_object(
             'account_id',       jel.account_id,
             'encrypted_amount', jel.encrypted_amount,
             'encrypted_label',  jel.encrypted_label,
             'entry_type',       jel.entry_type
           )
         )
    INTO v_old_lines
    FROM public.journal_entry_lines jel
   WHERE jel.journal_entry_id = p_je_id;

  -- Validate each new line: account must exist, entry_type must be debit/credit.
  FOR v_i IN 0 .. jsonb_array_length(p_new_lines) - 1 LOOP
    v_line := p_new_lines -> v_i;

    v_account_id := (v_line ->> 'account_id')::UUID;

    IF NOT EXISTS (
      SELECT 1 FROM public.accounts
       WHERE id = v_account_id
         AND org_id = v_je.org_id
    ) THEN
      RAISE EXCEPTION 'Account % does not exist in this organisation.', v_account_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF (v_line ->> 'entry_type') NOT IN ('debit', 'credit') THEN
      RAISE EXCEPTION 'entry_type must be ''debit'' or ''credit''.'
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;

  -- Verify double-entry balance using the blind-index amounts.
  -- Amounts are encrypted on the client; we store a numeric blind index for
  -- balance checking only. The plaintext never reaches the server.
  FOR v_i IN 0 .. jsonb_array_length(p_new_lines) - 1 LOOP
    v_line := p_new_lines -> v_i;
    IF (v_line ->> 'entry_type') = 'debit' THEN
      v_debit_sum  := v_debit_sum  + (v_line ->> 'amount_blind')::NUMERIC;
    ELSE
      v_credit_sum := v_credit_sum + (v_line ->> 'amount_blind')::NUMERIC;
    END IF;
  END LOOP;

  IF v_debit_sum <> v_credit_sum THEN
    RAISE EXCEPTION 'Journal entry does not balance (debits % <> credits %).',
                    v_debit_sum, v_credit_sum
      USING ERRCODE = 'check_violation';
  END IF;

  -- Snapshot the current state as a version record before mutating.
  v_version_id := gen_random_uuid();
  INSERT INTO public.journal_entry_versions (
    id, journal_entry_id, lines_snapshot, encrypted_reason,
    edited_at, edited_by
  ) VALUES (
    v_version_id,
    p_je_id,
    v_old_lines,
    p_encrypted_reason,
    now(),
    auth.uid()
  );

  -- Remove existing lines and replace with the new set.
  DELETE FROM public.journal_entry_lines
   WHERE journal_entry_id = p_je_id;

  FOR v_i IN 0 .. jsonb_array_length(p_new_lines) - 1 LOOP
    v_line := p_new_lines -> v_i;
    INSERT INTO public.journal_entry_lines (
      id,
      journal_entry_id,
      account_id,
      entry_type,
      encrypted_amount,
      encrypted_label,
      amount_blind,
      line_order
    ) VALUES (
      gen_random_uuid(),
      p_je_id,
      (v_line ->> 'account_id')::UUID,
      v_line ->> 'entry_type',
      v_line ->> 'encrypted_amount',
      v_line ->> 'encrypted_label',
      (v_line ->> 'amount_blind')::NUMERIC,
      v_i + 1
    );
  END LOOP;

  -- Bump updated_at so the next caller's optimistic check detects the change.
  UPDATE public.journal_entries
     SET updated_at = now()
   WHERE id = p_je_id;

  -- Return the version sequence number for this edit.
  SELECT count(*) INTO v_new_je_id
    FROM public.journal_entry_versions
   WHERE journal_entry_id = p_je_id;

  RETURN v_new_je_id::INTEGER;
END;
$$;

-- Grants: authenticated users only; anon and public have no access.
REVOKE ALL ON FUNCTION public.owb_edit_posted_entry(UUID, JSONB, TEXT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.owb_edit_posted_entry(UUID, JSONB, TEXT, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.owb_edit_posted_entry(UUID, JSONB, TEXT, TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION public.owb_edit_posted_entry IS
  'Edit a posted journal entry in place, keeping a full version history.
  Validates balance, refuses edits with no reason, refuses reversals and reversed entries,
  and (when p_expected_updated_at is given) an entry changed since the caller read it.
  Conflict on stale p_expected_updated_at raises ERRCODE PT409 so PostgREST returns HTTP 409
  immediately instead of retrying until the Cloudflare upstream timeout fires (OWB-T0238).';
