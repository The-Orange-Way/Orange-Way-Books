-- Editing a posted entry needs a reason, checked by the server (OWB-T0238, follow-up to
-- 20261105210000).
--
-- Every edit of a posted entry is written to its history with the reason. The screens already
-- refuse an edit with no reason; this makes the server refuse it too, before anything is read or
-- written, so an edit made under the owner's closed-month unlock always carries one. The reason is
-- encrypted in the browser, so the server checks only that one was sent. The signature does not
-- change, so grants are kept; they and the comment are set again to be explicit.

BEGIN;


-- p_header: {encrypted_memo, encrypted_currency, encrypted_exchange_rate}; keys left out keep
--   their value.
-- p_lines: the full new set of lines (at least two), each with account_id, encrypted_debit,
--   encrypted_credit and optionally the other encrypted line columns, pinned_rate_id, rate_asof,
--   rate_pending.
-- p_txs: one object per linked transaction to change, {id, date?, encrypted_amount?,
--   encrypted_exchange_rate?, encrypted_usd_value?, encrypted_metadata?, signature_b64?,
--   signature_key_version?}. Keys left out keep their value. A transaction's account and contact are not changed here. An org with a signing key needs the
--   signature on each (trg_verify_mutation_signature_transactions).
-- p_key_version: the field key version the caller encrypted with. It must match the entry's.
-- p_expected_updated_at: the entry's updated_at as the caller read it. When given, the edit is
--   refused if the entry changed since, checked under the row lock, so an edit is never saved
--   over a newer one. NULL skips the check.
-- Line amounts are encrypted, so the server cannot check debits equal credits; the client does.
CREATE OR REPLACE FUNCTION public.owb_edit_posted_entry(
  p_je_id            UUID,
  p_date             DATE,
  p_header           JSONB,
  p_lines            JSONB,
  p_txs              JSONB,
  p_encrypted_reason TEXT,
  p_key_version      INT,
  p_expected_updated_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_user       UUID := auth.uid();
  v_je         public.journal_entries%ROWTYPE;
  v_lock_date  DATE;
  v_min_date   DATE;
  v_dek        INT;
  v_version_no INT;
  v_version_id UUID;
  v_old_lines  INT;
  v_n          INT;
  v_tx         JSONB;
  v_tx_row     public.transactions%ROWTYPE;
  v_line       JSONB;
  v_bad_key    TEXT;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'Not signed in.' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_encrypted_reason IS NULL OR btrim(p_encrypted_reason) = '' THEN
    RAISE EXCEPTION 'Say why this posted entry is being changed.' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_je FROM public.journal_entries WHERE id = p_je_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Journal entry not found.' USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = v_je.org_id AND user_id = v_user)
     OR public.user_has_capability(v_user, 'journal_entries.write', v_je.org_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'You do not have permission to edit journal entries in this organization.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_expected_updated_at IS NOT NULL AND v_je.updated_at IS DISTINCT FROM p_expected_updated_at THEN
    RAISE EXCEPTION 'This entry was changed after you opened it. Reload it and try again.'
      USING ERRCODE = 'serialization_failure';
  END IF;

  IF v_je.status <> 'POSTED' THEN
    RAISE EXCEPTION 'Only a posted entry can be edited here (this one is %).', v_je.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_je.reversal_of_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.journal_entries WHERE reversal_of_id = p_je_id) THEN
    RAISE EXCEPTION 'A reversal, or an entry that has been reversed, cannot be edited.'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_key_version IS DISTINCT FROM v_je.key_version THEN
    RAISE EXCEPTION 'This entry is under key version %, not %. Reload and try again after the security refresh finishes.',
      v_je.key_version, p_key_version
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_date IS NULL OR p_lines IS NULL OR jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'An edited entry needs a date and a list of lines.' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_array_length(p_lines) < 2 THEN
    RAISE EXCEPTION 'An edited entry needs at least two lines.' USING ERRCODE = 'check_violation';
  END IF;
  IF p_header IS NOT NULL AND jsonb_typeof(p_header) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'p_header must be an object.' USING ERRCODE = 'check_violation';
  END IF;
  SELECT k INTO v_bad_key FROM jsonb_object_keys(coalesce(p_header, '{}'::jsonb)) k
   WHERE k NOT IN ('encrypted_memo', 'encrypted_currency', 'encrypted_exchange_rate') LIMIT 1;
  IF v_bad_key IS NOT NULL THEN
    RAISE EXCEPTION 'The header field % cannot be edited.', v_bad_key USING ERRCODE = 'check_violation';
  END IF;
  IF p_txs IS NOT NULL AND jsonb_typeof(p_txs) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_txs must be a list.' USING ERRCODE = 'check_violation';
  END IF;

  -- Closed month: refused unless the caller's unlock session covers the date.
  IF public.is_date_in_closed_period(v_je.org_id, v_user, v_je.date) IS NOT FALSE
     OR public.is_date_in_closed_period(v_je.org_id, v_user, p_date) IS NOT FALSE THEN
    RAISE EXCEPTION 'This month is closed. Reverse the entry instead, or ask an owner to unlock the month.'
      USING ERRCODE = 'check_violation';
  END IF;
  v_min_date := least(v_je.date, p_date);

  -- Every linked transaction, changed or not: same org, the caller may write it, and its month
  -- is open (or unlocked for the caller).
  FOR v_tx_row IN SELECT * FROM public.transactions WHERE journal_entry_id = p_je_id FOR UPDATE LOOP
    IF v_tx_row.org_id IS DISTINCT FROM v_je.org_id THEN
      RAISE EXCEPTION 'A transaction linked to this entry belongs to another organization.'
        USING ERRCODE = 'check_violation';
    END IF;
    IF (public.user_has_capability(v_user, 'transactions.write', v_je.org_id)
        OR (public.user_has_capability(v_user, 'transactions.write_own', v_je.org_id)
            AND v_tx_row.created_by = v_user)) IS NOT TRUE THEN
      RAISE EXCEPTION 'You do not have permission to edit a transaction linked to this entry.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF public.is_date_in_closed_period(v_je.org_id, v_user, v_tx_row.date) IS NOT FALSE THEN
      RAISE EXCEPTION 'This month is closed. Reverse the entry instead, or ask an owner to unlock the month.'
        USING ERRCODE = 'check_violation';
    END IF;
    v_min_date := least(v_min_date, v_tx_row.date);
  END LOOP;

  -- The requested transaction changes.
  FOR v_tx IN SELECT * FROM jsonb_array_elements(coalesce(p_txs, '[]'::jsonb)) LOOP
    IF jsonb_typeof(v_tx) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'Each p_txs item must be an object.' USING ERRCODE = 'check_violation';
    END IF;
    SELECT k INTO v_bad_key FROM jsonb_object_keys(v_tx) k
     WHERE k NOT IN ('id', 'date', 'encrypted_amount', 'encrypted_exchange_rate',
       'encrypted_usd_value', 'encrypted_metadata', 'signature_b64', 'signature_key_version') LIMIT 1;
    IF v_bad_key IS NOT NULL THEN
      RAISE EXCEPTION 'The transaction field % cannot be edited.', v_bad_key USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.transactions
                    WHERE id = (v_tx->>'id')::uuid AND journal_entry_id = p_je_id
                      AND org_id = v_je.org_id) THEN
      RAISE EXCEPTION 'Transaction % is not linked to this entry.', v_tx->>'id' USING ERRCODE = 'check_violation';
    END IF;
    IF v_tx ? 'date' THEN
      IF (v_tx->>'date') IS NULL
         OR public.is_date_in_closed_period(v_je.org_id, v_user, (v_tx->>'date')::date) IS NOT FALSE THEN
        RAISE EXCEPTION 'This month is closed. Reverse the entry instead, or ask an owner to unlock the month.'
          USING ERRCODE = 'check_violation';
      END IF;
      v_min_date := least(v_min_date, (v_tx->>'date')::date);
    END IF;
  END LOOP;

  -- Recorded as an override when any date touched is on or before the close.
  SELECT locked_through_date INTO v_lock_date FROM public.org_period_closes
   WHERE org_id = v_je.org_id ORDER BY closed_at DESC LIMIT 1;
  SELECT coalesce(dek_key_version, 1) INTO v_dek FROM public.org_settings WHERE org_id = v_je.org_id;
  v_dek := coalesce(v_dek, 1);

  -- History first.
  SELECT coalesce(max(version_no), 0) + 1 INTO v_version_no
    FROM public.journal_entry_versions WHERE journal_entry_id = p_je_id;
  INSERT INTO public.journal_entry_versions (
    journal_entry_id, org_id, version_no, edited_by, period_override, encrypted_reason,
    date, encrypted_currency, encrypted_exchange_rate, encrypted_memo, encrypted_ref_number,
    encrypted_metadata, encrypted_period_locked, entry_updated_at, key_version, dek_key_version)
  VALUES (
    p_je_id, v_je.org_id, v_version_no, v_user,
    v_lock_date IS NOT NULL AND v_min_date <= v_lock_date, p_encrypted_reason,
    v_je.date, v_je.encrypted_currency, v_je.encrypted_exchange_rate, v_je.encrypted_memo,
    v_je.encrypted_ref_number, v_je.encrypted_metadata, v_je.encrypted_period_locked,
    v_je.updated_at, v_je.key_version, v_dek)
  RETURNING id INTO v_version_id;

  INSERT INTO public.journal_entry_line_versions (
    version_id, journal_entry_id, org_id, line_id, line_created_at, account_id, account_code,
    account_name, description, encrypted_debit, encrypted_credit, encrypted_amount_native,
    encrypted_amount_primary, encrypted_book_value, encrypted_manual_rate_reason,
    encrypted_manual_rate_source, encrypted_metadata, encrypted_posted_rate,
    encrypted_primary_currency_at_posting, encrypted_wallet_currency, pinned_rate_id, rate_asof,
    rate_pending, dual_amounts_backfilled, key_version, dek_key_version)
  SELECT v_version_id, l.journal_entry_id, v_je.org_id, l.id, l.created_at, l.account_id,
    l.account_code, l.account_name, l.description, l.encrypted_debit, l.encrypted_credit,
    l.encrypted_amount_native, l.encrypted_amount_primary, l.encrypted_book_value,
    l.encrypted_manual_rate_reason, l.encrypted_manual_rate_source, l.encrypted_metadata,
    l.encrypted_posted_rate, l.encrypted_primary_currency_at_posting, l.encrypted_wallet_currency,
    l.pinned_rate_id, l.rate_asof, l.rate_pending, l.dual_amounts_backfilled, l.key_version, v_dek
    FROM public.journal_entry_lines l WHERE l.journal_entry_id = p_je_id;
  GET DIAGNOSTICS v_old_lines = ROW_COUNT;

  PERFORM set_config('owb.edit_je', p_je_id::text, true);

  DELETE FROM public.journal_entry_lines WHERE journal_entry_id = p_je_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> v_old_lines THEN
    RAISE EXCEPTION 'Edit stopped: % of % old lines were removed.', v_n, v_old_lines;
  END IF;

  FOR v_line IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF jsonb_typeof(v_line) IS DISTINCT FROM 'object' OR NOT EXISTS (
         SELECT 1 FROM public.chart_of_accounts
          WHERE id = (v_line->>'account_id')::uuid AND org_id = v_je.org_id) THEN
      RAISE EXCEPTION 'A line uses an account from another organization.' USING ERRCODE = 'check_violation';
    END IF;
    IF v_line->>'encrypted_debit' IS NULL OR v_line->>'encrypted_credit' IS NULL THEN
      RAISE EXCEPTION 'Each line needs a debit and a credit value.' USING ERRCODE = 'check_violation';
    END IF;
    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_id, account_code, account_name, description, encrypted_debit,
      encrypted_credit, encrypted_amount_native, encrypted_amount_primary, encrypted_book_value,
      encrypted_manual_rate_reason, encrypted_manual_rate_source, encrypted_metadata,
      encrypted_posted_rate, encrypted_primary_currency_at_posting, encrypted_wallet_currency,
      pinned_rate_id, rate_asof, rate_pending, key_version)
    VALUES (
      p_je_id, (v_line->>'account_id')::uuid, v_line->>'account_code', v_line->>'account_name',
      v_line->>'description', v_line->>'encrypted_debit', v_line->>'encrypted_credit',
      v_line->>'encrypted_amount_native', v_line->>'encrypted_amount_primary',
      v_line->>'encrypted_book_value', v_line->>'encrypted_manual_rate_reason',
      v_line->>'encrypted_manual_rate_source', v_line->'encrypted_metadata',
      v_line->>'encrypted_posted_rate', v_line->>'encrypted_primary_currency_at_posting',
      v_line->>'encrypted_wallet_currency', (v_line->>'pinned_rate_id')::uuid,
      (v_line->>'rate_asof')::timestamptz, coalesce((v_line->>'rate_pending')::boolean, FALSE),
      p_key_version);
  END LOOP;
  SELECT count(*) INTO v_n FROM public.journal_entry_lines WHERE journal_entry_id = p_je_id;
  IF v_n <> jsonb_array_length(p_lines) THEN
    RAISE EXCEPTION 'Edit stopped: the entry has % lines, expected %.', v_n, jsonb_array_length(p_lines);
  END IF;

  UPDATE public.journal_entries SET
    date = p_date,
    encrypted_memo = CASE WHEN p_header ? 'encrypted_memo' THEN p_header->>'encrypted_memo' ELSE encrypted_memo END,
    encrypted_currency = CASE WHEN p_header ? 'encrypted_currency' THEN p_header->>'encrypted_currency' ELSE encrypted_currency END,
    encrypted_exchange_rate = CASE WHEN p_header ? 'encrypted_exchange_rate' THEN p_header->>'encrypted_exchange_rate' ELSE encrypted_exchange_rate END,
    updated_at = now()
  WHERE id = p_je_id AND status = 'POSTED';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN RAISE EXCEPTION 'Edit stopped: the entry header was not updated.'; END IF;

  FOR v_tx IN SELECT * FROM jsonb_array_elements(coalesce(p_txs, '[]'::jsonb)) LOOP
    UPDATE public.transactions SET
      date = CASE WHEN v_tx ? 'date' THEN (v_tx->>'date')::date ELSE date END,
      encrypted_amount = CASE WHEN v_tx ? 'encrypted_amount' THEN v_tx->>'encrypted_amount' ELSE encrypted_amount END,
      encrypted_exchange_rate = CASE WHEN v_tx ? 'encrypted_exchange_rate' THEN v_tx->>'encrypted_exchange_rate' ELSE encrypted_exchange_rate END,
      encrypted_usd_value = CASE WHEN v_tx ? 'encrypted_usd_value' THEN v_tx->>'encrypted_usd_value' ELSE encrypted_usd_value END,
      encrypted_metadata = CASE WHEN v_tx ? 'encrypted_metadata' THEN v_tx->'encrypted_metadata' ELSE encrypted_metadata END,
      signature_b64 = CASE WHEN v_tx ? 'signature_b64' THEN v_tx->>'signature_b64' ELSE signature_b64 END,
      signature_key_version = CASE WHEN v_tx ? 'signature_key_version' THEN (v_tx->>'signature_key_version')::int ELSE signature_key_version END
    WHERE id = (v_tx->>'id')::uuid AND journal_entry_id = p_je_id AND org_id = v_je.org_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> 1 THEN RAISE EXCEPTION 'Edit stopped: transaction % was not updated.', v_tx->>'id'; END IF;
  END LOOP;

  PERFORM set_config('owb.edit_je', '', true);
  RETURN v_version_no;
END;
$$;

REVOKE ALL ON FUNCTION public.owb_edit_posted_entry(UUID, DATE, JSONB, JSONB, JSONB, TEXT, INT, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.owb_edit_posted_entry(UUID, DATE, JSONB, JSONB, JSONB, TEXT, INT, TIMESTAMPTZ) FROM anon;
GRANT EXECUTE ON FUNCTION public.owb_edit_posted_entry(UUID, DATE, JSONB, JSONB, JSONB, TEXT, INT, TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION public.owb_edit_posted_entry(UUID, DATE, JSONB, JSONB, JSONB, TEXT, INT, TIMESTAMPTZ) IS
  'OWB-T0238: edit a POSTED entry in place in an open month (or under an unlock session, recorded as period_override). Copies the old header and lines into journal_entry_versions / journal_entry_line_versions first. Refuses an edit with no reason, reversals and reversed entries, and (when p_expected_updated_at is given) an entry changed since the caller read it; reconciled entries are refused by the Edit screen.';

COMMIT;
