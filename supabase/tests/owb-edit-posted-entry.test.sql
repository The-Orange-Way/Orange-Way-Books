-- Tests for owb_edit_posted_entry and the history tables (OWB-T0238).
--
-- One self-contained script: everything runs in one transaction and is rolled back, so nothing
-- persists. Run it as the database owner after migration 20261105160000. It prints one row per
-- check from the temp table results; every row must have ok = true.
--
-- Each check runs as a real caller: role authenticated with request.jwt.claims set, so auth.uid()
-- and the capability checks behave as they do for the app. The "broken copy" checks rebuild one
-- guard without its key line, inside a subtransaction that is then rolled back. A broken copy is
-- caught only when the probe succeeds against it AND leaves the state the healthy guard prevents,
-- so an unrelated error cannot pass for a catch.
--
-- The signed-org check replaces public.pqc_verify_ml_dsa_65 inside this transaction, because a
-- valid ML-DSA signature cannot be produced in SQL. It tests that the edit passes the signature
-- through to the transaction trigger, not the verifier itself.

BEGIN;

CREATE TEMP TABLE results (n SERIAL, name TEXT, ok BOOLEAN, detail TEXT);
GRANT ALL ON results TO authenticated;
GRANT ALL ON SEQUENCE results_n_seq TO authenticated;

-- Runs sql and returns 'OK' or the error message. The work stays if it succeeds.
CREATE FUNCTION pg_temp.try(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END $$;

-- expect = 'OK', or a substring of the expected error.
CREATE FUNCTION pg_temp.chk(p_name TEXT, p_sql TEXT, p_expect TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE r TEXT := pg_temp.try(p_sql);
BEGIN
  INSERT INTO results (name, ok, detail)
  VALUES (p_name, CASE WHEN p_expect = 'OK' THEN r = 'OK' ELSE r <> 'OK' AND position(p_expect IN r) > 0 END, r);
END $$;

CREATE FUNCTION pg_temp.fact(p_name TEXT, p_ok BOOLEAN, p_detail TEXT DEFAULT NULL) RETURNS VOID LANGUAGE sql AS $$
  INSERT INTO results (name, ok, detail) VALUES (p_name, coalesce(p_ok, FALSE), p_detail);
$$;

CREATE FUNCTION pg_temp.act(p_user UUID) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('role', 'authenticated', true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
END $$;

-- Builds a broken copy of p_fn by replacing p_find with p_repl, runs p_probe against it as p_actor
-- (NULL runs it as the owner), then reads p_state as the owner, then undoes the copy. Passes only
-- when the probe succeeded and p_state is true: the copy let through what the real guard refuses.
CREATE FUNCTION pg_temp.broken(p_name TEXT, p_fn REGPROCEDURE, p_find TEXT, p_repl TEXT,
  p_actor UUID, p_probe TEXT, p_state TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE
  v_def TEXT := pg_get_functiondef(p_fn);
  r TEXT;
  v_state BOOLEAN;
BEGIN
  IF position(p_find IN v_def) = 0 THEN
    PERFORM pg_temp.fact(p_name, FALSE, 'broken copy not built: text not found');
    RETURN;
  END IF;
  BEGIN
    EXECUTE replace(v_def, p_find, p_repl);
    IF p_actor IS NOT NULL THEN PERFORM pg_temp.act(p_actor); END IF;
    r := pg_temp.try(p_probe);
    EXECUTE 'RESET ROLE';
    EXECUTE 'SELECT (' || p_state || ')' INTO v_state;
    RAISE EXCEPTION USING ERRCODE = 'ZZ999', MESSAGE = r || '|' || coalesce(v_state::text, 'null');
  EXCEPTION WHEN SQLSTATE 'ZZ999' THEN
    r := SQLERRM;
  END;
  PERFORM pg_temp.fact(p_name, r = 'OK|true', 'broken copy answered: ' || r);
END $$;

-- ── Fixtures, as the owner ────────────────────────────────────────────────────

CREATE TEMP TABLE ids AS SELECT
  '7e570000-0000-0000-0000-00000000000a'::uuid AS org_a,
  '7e570000-0000-0000-0000-00000000000b'::uuid AS org_b,
  '7e570000-0000-0000-0000-000000000001'::uuid AS u_owner,
  '7e570000-0000-0000-0000-000000000002'::uuid AS u_book,
  '7e570000-0000-0000-0000-000000000003'::uuid AS u_view,
  '7e570000-0000-0000-0000-000000000004'::uuid AS u_out,
  '7e570000-0000-0000-0000-0000000000a1'::uuid AS acct_a1,
  '7e570000-0000-0000-0000-0000000000a2'::uuid AS acct_a2,
  '7e570000-0000-0000-0000-0000000000b1'::uuid AS acct_b1,
  '7e570000-0000-0000-0000-0000000000b2'::uuid AS acct_b2;
GRANT SELECT ON ids TO authenticated;

INSERT INTO auth.users (id, email, aud, role)
SELECT u, 'owb-edit-test-' || right(u::text, 1) || '@example.invalid', 'authenticated', 'authenticated'
  FROM ids, unnest(ARRAY[u_owner, u_book, u_view, u_out]) u;

INSERT INTO public.organizations (id, name) SELECT org_a, 'owb-edit-test-a' FROM ids;
INSERT INTO public.organizations (id, name) SELECT org_b, 'owb-edit-test-b' FROM ids;

INSERT INTO public.org_members (org_id, user_id, role)
SELECT org_a, u_owner, 'OWNER' FROM ids UNION ALL
SELECT org_a, u_book, 'MEMBER' FROM ids UNION ALL
SELECT org_a, u_view, 'VIEWER' FROM ids UNION ALL
SELECT org_b, u_owner, 'OWNER' FROM ids;

INSERT INTO public.org_member_roles (org_id, user_id, role_definition_id)
SELECT x.org, x.u, rd.id
  FROM ids,
       LATERAL (VALUES (org_a, u_owner, 'Owner'), (org_a, u_book, 'Bookkeeper'),
                       (org_a, u_view, 'Viewer'), (org_b, u_owner, 'Owner')) x(org, u, role)
  JOIN public.role_definitions rd ON rd.name = x.role AND rd.is_system AND rd.org_id IS NULL;

INSERT INTO public.chart_of_accounts (id, org_id, encrypted_name, encrypted_account_type, encrypted_is_group, encrypted_is_system)
SELECT acct_a1, org_a, 'C_CASH', 'C_ASSET', 'C_F', 'C_F' FROM ids UNION ALL
SELECT acct_a2, org_a, 'C_SALES', 'C_INCOME', 'C_F', 'C_F' FROM ids UNION ALL
SELECT acct_b1, org_b, 'C_CASH', 'C_ASSET', 'C_F', 'C_F' FROM ids UNION ALL
SELECT acct_b2, org_b, 'C_SALES', 'C_INCOME', 'C_F', 'C_F' FROM ids;

-- A posted entry with two lines and one linked transaction, made by the bookkeeper unless
-- p_tx_by names someone else. p_tx_date moves the transaction to another day; p_with_tx = FALSE
-- leaves the entry with no transaction.
CREATE FUNCTION pg_temp.entry(p_org UUID, p_date DATE, p_a1 UUID, p_a2 UUID, p_status TEXT DEFAULT 'POSTED',
  p_tx_by UUID DEFAULT NULL, p_tx_date DATE DEFAULT NULL, p_with_tx BOOLEAN DEFAULT TRUE)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v_je UUID; v_book UUID;
BEGIN
  SELECT coalesce(p_tx_by, u_book) INTO v_book FROM ids;
  INSERT INTO public.journal_entries (org_id, date, status, encrypted_currency, encrypted_memo,
    encrypted_ref_number, key_version)
  VALUES (p_org, p_date, 'DRAFT', 'C_USD', 'C_MEMO_OLD', 'C_REF_7', 2) RETURNING id INTO v_je;
  INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, encrypted_debit, encrypted_credit, key_version)
  VALUES (v_je, p_a1, 'C_100', 'C_0', 2), (v_je, p_a2, 'C_0', 'C_100', 2);
  IF p_with_tx THEN
    INSERT INTO public.transactions (org_id, date, type, asset, amount, journal_entry_id, created_by,
      encrypted_amount, key_version)
    VALUES (p_org, coalesce(p_tx_date, p_date), 'C_TYPE', 'C_ASSET', 0, v_je, v_book, 'C_AMT_OLD', 2);
  END IF;
  IF p_status <> 'DRAFT' THEN
    UPDATE public.journal_entries SET status = p_status WHERE id = v_je;
  END IF;
  RETURN v_je;
END $$;

CREATE TEMP TABLE e AS SELECT
  pg_temp.entry(org_a, DATE '2026-10-10', acct_a1, acct_a2) AS e1,
  pg_temp.entry(org_a, DATE '2026-03-05', acct_a1, acct_a2) AS e_closed,
  pg_temp.entry(org_a, DATE '2026-03-06', acct_a1, acct_a2) AS e_closed2,
  pg_temp.entry(org_a, DATE '2026-10-12', acct_a1, acct_a2) AS e_open,
  pg_temp.entry(org_a, DATE '2026-10-13', acct_a1, acct_a2, 'DRAFT') AS e_draft,
  pg_temp.entry(org_a, DATE '2026-10-14', acct_a1, acct_a2, 'VOID') AS e_void,
  pg_temp.entry(org_b, DATE '2026-10-15', acct_b1, acct_b2) AS e_signed,
  pg_temp.entry(org_a, DATE '2026-10-16', acct_a1, acct_a2, p_tx_by => u_owner) AS e_owner_tx,
  pg_temp.entry(org_a, DATE '2026-10-17', acct_a1, acct_a2, p_tx_date => DATE '2026-03-10') AS e_tx_closed,
  pg_temp.entry(org_a, DATE '2026-03-07', acct_a1, acct_a2, p_with_tx => FALSE) AS e_closed_notx
FROM ids;
GRANT SELECT ON e TO authenticated;

-- A posted reversal of e_void.
INSERT INTO public.journal_entries (org_id, date, status, encrypted_currency, reversal_of_id, source_type, key_version)
SELECT org_a, DATE '2026-10-14', 'POSTED', 'C_USD', e_void, 'void_reversal', 2 FROM ids, e;

-- March is closed in org A. Org B has a signing key.
INSERT INTO public.org_period_closes (org_id, locked_through_date, closed_by)
SELECT org_a, DATE '2026-03-31', u_owner FROM ids;
INSERT INTO public.org_signing_keys (org_id, key_version, public_key_b64, created_by)
SELECT org_b, 1, 'TEST-PUBLIC-KEY', u_owner FROM ids;

-- Call text for one edit. Lines are two new lines on the given accounts.
CREATE FUNCTION pg_temp.edit_sql(p_je UUID, p_date DATE, p_a1 UUID, p_a2 UUID,
  p_header JSONB DEFAULT '{"encrypted_memo":"C_MEMO_NEW"}', p_txs JSONB DEFAULT NULL, p_kv INT DEFAULT 2)
RETURNS TEXT LANGUAGE sql AS $$
  SELECT format('SELECT public.owb_edit_posted_entry(%L, %L, %L, %L, %L, %L, %s)',
    p_je, p_date, p_header,
    jsonb_build_array(
      jsonb_build_object('account_id', p_a1, 'encrypted_debit', 'C_250', 'encrypted_credit', 'C_0'),
      jsonb_build_object('account_id', p_a2, 'encrypted_debit', 'C_0', 'encrypted_credit', 'C_250')),
    p_txs, 'C_REASON', p_kv);
$$;

-- ── Checks ────────────────────────────────────────────────────────────────────

-- 1. The bookkeeper edits a posted entry in an open month.
SELECT pg_temp.act(u_book) FROM ids;
SELECT pg_temp.chk('bookkeeper edits a posted entry in an open month',
  pg_temp.edit_sql(e1, DATE '2026-10-20', acct_a1, acct_a2, '{"encrypted_memo":"C_MEMO_NEW"}',
    jsonb_build_array(jsonb_build_object('id', t.id, 'encrypted_amount', 'C_AMT_NEW', 'date', '2026-10-20'))),
  'OK')
FROM ids, e, public.transactions t WHERE t.journal_entry_id = e.e1;
RESET ROLE;

SELECT pg_temp.fact('the entry keeps its id, number and status, and takes the new values',
  j.status = 'POSTED' AND j.encrypted_ref_number = 'C_REF_7' AND j.encrypted_memo = 'C_MEMO_NEW'
  AND j.date = DATE '2026-10-20', row_to_json(j)::text)
FROM e JOIN public.journal_entries j ON j.id = e.e1;
SELECT pg_temp.fact('the lines are replaced, not added to',
  count(*) = 2 AND bool_and(l.encrypted_debit IN ('C_250', 'C_0')), count(*)::text)
FROM e JOIN public.journal_entry_lines l ON l.journal_entry_id = e.e1;
SELECT pg_temp.fact('the linked transaction is updated',
  t.encrypted_amount = 'C_AMT_NEW' AND t.date = DATE '2026-10-20', t.encrypted_amount)
FROM e JOIN public.transactions t ON t.journal_entry_id = e.e1;
SELECT pg_temp.fact('history keeps the old entry with who, when and no override',
  v.version_no = 1 AND v.edited_by = ids.u_book AND NOT v.period_override AND v.encrypted_memo = 'C_MEMO_OLD'
  AND v.date = DATE '2026-10-10' AND v.encrypted_reason = 'C_REASON', row_to_json(v)::text)
FROM ids, e JOIN public.journal_entry_versions v ON v.journal_entry_id = e.e1;
SELECT pg_temp.fact('history keeps the old lines',
  count(*) = 2 AND bool_and(lv.encrypted_debit IN ('C_100', 'C_0')), count(*)::text)
FROM e JOIN public.journal_entry_line_versions lv ON lv.journal_entry_id = e.e1;
SELECT pg_temp.fact('history records the org data key version',
  bool_and(v.dek_key_version = coalesce((SELECT dek_key_version FROM public.org_settings WHERE org_id = ids.org_a), 1)),
  string_agg(v.dek_key_version::text, ','))
FROM ids, e JOIN public.journal_entry_versions v ON v.journal_entry_id = e.e1;
SELECT pg_temp.fact('the edit setting is cleared when the function returns',
  coalesce(current_setting('owb.edit_je', true), '') = '', current_setting('owb.edit_je', true));

-- 2. A second edit gets the next version number.
SELECT pg_temp.act(u_book) FROM ids;
SELECT pg_temp.chk('a second edit is accepted', pg_temp.edit_sql(e1, DATE '2026-10-21', acct_a1, acct_a2), 'OK') FROM ids, e;
RESET ROLE;
SELECT pg_temp.fact('a second edit is version 2', max(version_no) = 2, max(version_no)::text)
FROM e JOIN public.journal_entry_versions v ON v.journal_entry_id = e.e1;

-- 3. Who may edit.
SELECT pg_temp.act(u_view) FROM ids;
SELECT pg_temp.chk('a viewer is refused', pg_temp.edit_sql(e_open, DATE '2026-10-12', acct_a1, acct_a2), 'permission') FROM ids, e;
SELECT pg_temp.act(u_out) FROM ids;
SELECT pg_temp.chk('a non-member is refused', pg_temp.edit_sql(e_open, DATE '2026-10-12', acct_a1, acct_a2), 'permission') FROM ids, e;
RESET ROLE;

-- 4. Which entries may be edited.
SELECT pg_temp.act(u_book) FROM ids;
SELECT pg_temp.chk('a draft is refused', pg_temp.edit_sql(e_draft, DATE '2026-10-13', acct_a1, acct_a2), 'Only a posted entry') FROM ids, e;
SELECT pg_temp.chk('a void entry is refused', pg_temp.edit_sql(e_void, DATE '2026-10-14', acct_a1, acct_a2), 'Only a posted entry') FROM ids, e;
SELECT pg_temp.chk('a reversal is refused',
  pg_temp.edit_sql(j.id, DATE '2026-10-14', acct_a1, acct_a2), 'reversal') FROM ids, e
  JOIN public.journal_entries j ON j.reversal_of_id = e.e_void;
SELECT pg_temp.chk('an entry in a closed month is refused', pg_temp.edit_sql(e_closed, DATE '2026-03-05', acct_a1, acct_a2), 'closed') FROM ids, e;
SELECT pg_temp.chk('an entry in a closed month with no transaction is refused', pg_temp.edit_sql(e_closed_notx, DATE '2026-03-07', acct_a1, acct_a2), 'closed') FROM ids, e;
SELECT pg_temp.chk('an open entry whose transaction is in a closed month is refused', pg_temp.edit_sql(e_tx_closed, DATE '2026-10-17', acct_a1, acct_a2), 'closed') FROM ids, e;
SELECT pg_temp.chk('a transaction date moved into a closed month is refused',
  pg_temp.edit_sql(e_open, DATE '2026-10-12', acct_a1, acct_a2, p_txs => jsonb_build_array(jsonb_build_object('id', t.id, 'date', '2026-03-15'))), 'closed')
FROM ids, e JOIN public.transactions t ON t.journal_entry_id = e.e_open;
SELECT pg_temp.chk('the bookkeeper is refused on an entry whose transaction someone else made', pg_temp.edit_sql(e_owner_tx, DATE '2026-10-16', acct_a1, acct_a2), 'permission') FROM ids, e;
SELECT pg_temp.chk('no list of lines is refused',
  format('SELECT public.owb_edit_posted_entry(%L, %L, NULL, NULL, NULL, %L, 2)', e_open, DATE '2026-10-12', 'C_REASON'), 'list of lines') FROM e;
SELECT pg_temp.chk('one line is refused',
  format('SELECT public.owb_edit_posted_entry(%L, %L, NULL, %L, NULL, %L, 2)', e_open, DATE '2026-10-12',
    jsonb_build_array(jsonb_build_object('account_id', acct_a1, 'encrypted_debit', 'C_0', 'encrypted_credit', 'C_0')), 'C_REASON'), 'at least two') FROM ids, e;
SELECT pg_temp.chk('a transaction account or contact cannot be changed here',
  pg_temp.edit_sql(e_open, DATE '2026-10-12', acct_a1, acct_a2, p_txs => jsonb_build_array(jsonb_build_object('id', t.id, 'account_id', ids.acct_b1))), 'cannot be edited')
FROM ids, e JOIN public.transactions t ON t.journal_entry_id = e.e_open;
SELECT pg_temp.chk('moving an open entry into a closed month is refused', pg_temp.edit_sql(e_open, DATE '2026-03-20', acct_a1, acct_a2), 'closed') FROM ids, e;
SELECT pg_temp.chk('a header field outside the list is refused',
  pg_temp.edit_sql(e_open, DATE '2026-10-12', acct_a1, acct_a2, '{"encrypted_ref_number":"C_X"}'), 'cannot be edited') FROM ids, e;
SELECT pg_temp.chk('a line on another org''s account is refused', pg_temp.edit_sql(e_open, DATE '2026-10-12', acct_a1, acct_b1), 'another organization') FROM ids, e;
SELECT pg_temp.chk('a different key version is refused', pg_temp.edit_sql(e_open, DATE '2026-10-12', acct_a1, acct_a2, p_kv => 3), 'key version') FROM ids, e;
SELECT pg_temp.chk('a transaction not linked to the entry is refused',
  pg_temp.edit_sql(e_open, DATE '2026-10-12', acct_a1, acct_a2, p_txs => jsonb_build_array(jsonb_build_object('id', t.id))), 'not linked')
FROM ids, e JOIN public.transactions t ON t.journal_entry_id = e.e1;
RESET ROLE;
SELECT pg_temp.fact('refused edits wrote no history and left the lines alone',
  NOT EXISTS (SELECT 1 FROM public.journal_entry_versions
              WHERE journal_entry_id IN (e_open, e_closed, e_draft, e_void, e_owner_tx, e_tx_closed, e_closed_notx))
  AND (SELECT count(*) FROM public.journal_entry_lines WHERE journal_entry_id = e_open) = 2)
FROM e;

-- 5. Closed month with the owner's unlock session: allowed and recorded as an override.
INSERT INTO public.period_unlock_sessions (org_id, user_id, granted_by, unlock_through_date)
SELECT org_a, u_owner, u_owner, DATE '2026-03-31' FROM ids;
SELECT pg_temp.act(u_owner) FROM ids;
SELECT pg_temp.chk('the owner with an unlock session edits a closed-month entry',
  pg_temp.edit_sql(e_closed, DATE '2026-03-05', acct_a1, acct_a2), 'OK') FROM ids, e;
RESET ROLE;
SELECT pg_temp.chk('the owner with an unlock session edits an open entry whose transaction is in a closed month',
  pg_temp.edit_sql(e_tx_closed, DATE '2026-10-17', acct_a1, acct_a2), 'OK') FROM ids, e;
RESET ROLE;
SELECT pg_temp.fact('that edit is recorded as an override', v.period_override, v.period_override::text)
FROM e JOIN public.journal_entry_versions v ON v.journal_entry_id = e.e_closed;
SELECT pg_temp.fact('an edit touching a closed transaction date is recorded as an override', v.period_override, v.period_override::text)
FROM e JOIN public.journal_entry_versions v ON v.journal_entry_id = e.e_tx_closed;
SELECT pg_temp.act(u_owner) FROM ids;
SELECT pg_temp.chk('the owner may edit an entry whose transaction someone else made', pg_temp.edit_sql(e_owner_tx, DATE '2026-10-16', acct_a1, acct_a2), 'OK') FROM ids, e;
RESET ROLE;

-- 6. An org with a signing key: the transaction needs a signature.
SELECT pg_temp.act(u_owner) FROM ids;
SELECT pg_temp.chk('signed org: an edit without a signature is refused',
  pg_temp.edit_sql(e_signed, DATE '2026-10-15', acct_b1, acct_b2, p_txs => jsonb_build_array(jsonb_build_object('id', t.id, 'encrypted_amount', 'C_AMT_NEW'))),
  'Signing Key signature')
FROM ids, e JOIN public.transactions t ON t.journal_entry_id = e.e_signed;
RESET ROLE;
SELECT pg_temp.fact('signed org: the refused edit wrote no history',
  NOT EXISTS (SELECT 1 FROM public.journal_entry_versions WHERE journal_entry_id = e_signed)) FROM e;
CREATE OR REPLACE FUNCTION public.pqc_verify_ml_dsa_65(p_public_key_b64 TEXT, p_signature_b64 TEXT, p_payload BYTEA)
RETURNS BOOLEAN LANGUAGE sql AS $$ SELECT p_signature_b64 = 'TEST-SIG' $$;
SELECT pg_temp.act(u_owner) FROM ids;
SELECT pg_temp.chk('signed org: an edit with a signature is accepted',
  pg_temp.edit_sql(e_signed, DATE '2026-10-15', acct_b1, acct_b2, p_txs => jsonb_build_array(jsonb_build_object(
    'id', t.id, 'encrypted_amount', 'C_AMT_NEW', 'signature_b64', 'TEST-SIG', 'signature_key_version', 1))),
  'OK')
FROM ids, e JOIN public.transactions t ON t.journal_entry_id = e.e_signed;
RESET ROLE;

-- 7. The edit setting only opens the entry it names, and only for the allowed columns.
SELECT pg_temp.act(u_owner) FROM ids;
SELECT set_config('owb.edit_je', e_open::text, true) FROM e;
SELECT pg_temp.chk('the setting for another entry does not open this one',
  format('UPDATE public.journal_entries SET encrypted_memo = %L WHERE id = %L', 'C_HACK', e1), 'Cannot modify finalized') FROM e;
SELECT pg_temp.chk('the setting for another entry does not free its lines',
  format('DELETE FROM public.journal_entry_lines WHERE journal_entry_id = %L', e1), 'Cannot delete line') FROM e;
SELECT set_config('owb.edit_je', e1::text, true) FROM e;
SELECT pg_temp.chk('even with the setting, the ref number stays frozen',
  format('UPDATE public.journal_entries SET encrypted_ref_number = %L WHERE id = %L', 'C_X', e1), 'Cannot modify finalized') FROM e;
SELECT pg_temp.chk('even with the setting, a line cannot move to another entry',
  format('UPDATE public.journal_entry_lines SET journal_entry_id = %L WHERE journal_entry_id = %L', e_open, e1), 'Cannot update line') FROM e;
SELECT pg_temp.chk('even with the setting, a posted entry cannot be deleted',
  format('DELETE FROM public.journal_entries WHERE id = %L', e1), 'Cannot delete finalized') FROM e;
SELECT set_config('owb.edit_je', e_void::text, true) FROM e;
SELECT pg_temp.chk('the setting for a void entry does not free its lines',
  format('DELETE FROM public.journal_entry_lines WHERE journal_entry_id = %L', e_void), 'Cannot delete line') FROM e;
SELECT set_config('owb.edit_je', '', true);
SELECT pg_temp.chk('history: a signed-in user cannot change it directly',
  format('UPDATE public.journal_entry_versions SET encrypted_memo = %L WHERE journal_entry_id = %L', 'C_X', e1), 'permission denied') FROM e;
SELECT pg_temp.chk('history: a signed-in user cannot delete it directly',
  format('DELETE FROM public.journal_entry_line_versions WHERE journal_entry_id = %L', e1), 'permission denied') FROM e;
RESET ROLE;

-- 8. History cannot be changed or deleted, except re-encrypted.
SELECT pg_temp.chk('history: the old date cannot be changed',
  format('UPDATE public.journal_entry_versions SET date = %L WHERE journal_entry_id = %L', '2020-01-01', e1), 'only re-encrypted') FROM e;
SELECT pg_temp.chk('history: a row cannot be deleted',
  format('DELETE FROM public.journal_entry_line_versions WHERE journal_entry_id = %L', e1), 'cannot be deleted') FROM e;
SELECT pg_temp.chk('history: re-encryption is allowed',
  format('UPDATE public.journal_entry_versions SET encrypted_memo = %L, key_version = 3 WHERE journal_entry_id = %L', 'C_REKEYED', e1), 'OK') FROM e;
SELECT pg_temp.act(u_view) FROM ids;
SELECT pg_temp.fact('history: a member can read it',
  (SELECT count(*) FROM public.journal_entry_versions WHERE journal_entry_id = e1) = 2) FROM e;
SELECT pg_temp.act(u_out) FROM ids;
SELECT pg_temp.fact('history: a non-member sees none of it',
  (SELECT count(*) FROM public.journal_entry_versions WHERE journal_entry_id = e1) = 0) FROM e;
RESET ROLE;

-- 9. Who can call the function.
SELECT pg_temp.fact('anon cannot run the edit',
  NOT has_function_privilege('anon', 'public.owb_edit_posted_entry(uuid,date,jsonb,jsonb,jsonb,text,integer)', 'EXECUTE'));
SELECT pg_temp.fact('authenticated can run the edit',
  has_function_privilege('authenticated', 'public.owb_edit_posted_entry(uuid,date,jsonb,jsonb,jsonb,text,integer)', 'EXECUTE'));

-- ── Broken copies: each must be caught by the check named in it ───────────────

SELECT pg_temp.broken('broken copy without the closed-month check on the entry date is caught',
  'public.owb_edit_posted_entry(uuid,date,jsonb,jsonb,jsonb,text,integer)',
  E'IF public.is_date_in_closed_period(v_je.org_id, v_user, v_je.date) IS NOT FALSE\n     OR public.is_date_in_closed_period(v_je.org_id, v_user, p_date) IS NOT FALSE THEN',
  'IF FALSE THEN', u_book,
  pg_temp.edit_sql(e_closed_notx, DATE '2026-03-07', acct_a1, acct_a2),
  format('EXISTS (SELECT 1 FROM public.journal_entry_versions WHERE journal_entry_id = %L)', e_closed_notx)) FROM ids, e;
SELECT pg_temp.broken('broken copy without the linked-transaction permission check is caught',
  'public.owb_edit_posted_entry(uuid,date,jsonb,jsonb,jsonb,text,integer)',
  E'IF (public.user_has_capability(v_user, ''transactions.write'', v_je.org_id)\n        OR (public.user_has_capability(v_user, ''transactions.write_own'', v_je.org_id)\n            AND v_tx_row.created_by = v_user)) IS NOT TRUE THEN',
  'IF FALSE THEN', u_book,
  pg_temp.edit_sql(e_owner_tx, DATE '2026-10-16', acct_a1, acct_a2),
  format('EXISTS (SELECT 1 FROM public.journal_entry_versions WHERE journal_entry_id = %L AND edited_by = %L)', e_owner_tx, u_book)) FROM ids, e;
SELECT pg_temp.broken('broken copy of the header lock that ignores which entry is caught',
  'public.owb_protect_finalized_journal_entry()',
  '= OLD.id::text', '<> ''''', u_owner,
  format('SELECT set_config(''owb.edit_je'', %L, true); UPDATE public.journal_entries SET encrypted_memo = ''C_HACK'' WHERE id = %L', e_open, e1),
  format('(SELECT encrypted_memo FROM public.journal_entries WHERE id = %L) = ''C_HACK''', e1)) FROM ids, e;
SELECT pg_temp.broken('broken copy of the history guard that allows any change is caught',
  'public.owb_protect_entry_history()',
  'RAISE EXCEPTION ''Entry history cannot be changed', 'RETURN NEW; RAISE EXCEPTION ''Entry history cannot be changed', NULL,
  format('UPDATE public.journal_entry_versions SET date = %L WHERE journal_entry_id = %L', '2020-01-01', e1),
  format('EXISTS (SELECT 1 FROM public.journal_entry_versions WHERE journal_entry_id = %L AND date = %L)', e1, '2020-01-01')) FROM ids, e;

-- ── Result ────────────────────────────────────────────────────────────────────

SELECT n, ok, name, left(detail, 160) AS detail FROM results ORDER BY n;
SELECT count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed FROM results;

ROLLBACK;
