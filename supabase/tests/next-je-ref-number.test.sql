-- Tests for next_je_ref_number (OWB-T0228).
--
-- One self-contained script: everything runs in one transaction and is rolled back, so nothing
-- persists. Run it as the database owner after migration 20261106160000. It prints one row per
-- check from the temp table results; every row must have ok = true.
--
-- Calls run as a real caller: role authenticated with request.jwt.claims set, so auth.uid() and
-- the capability check behave as they do for the app. The broken-copy check puts back the old
-- four-character LPAD inside a subtransaction, and passes only if that copy repeats a label the
-- real function does not.

BEGIN;

CREATE TEMP TABLE results (n SERIAL, name TEXT, ok BOOLEAN, detail TEXT);
GRANT ALL ON results TO authenticated;
GRANT ALL ON SEQUENCE results_n_seq TO authenticated;

-- Runs sql and returns 'OK' or the error message.
CREATE FUNCTION pg_temp.try(p_sql TEXT) RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE p_sql;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
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

-- Mints one label as p_user, as the owner afterwards. Returns the label or the error text.
CREATE FUNCTION pg_temp.mint(p_user UUID, p_org UUID, p_year SMALLINT) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE r TEXT;
BEGIN
  PERFORM pg_temp.act(p_user);
  BEGIN
    r := public.next_je_ref_number(p_org, p_year);
  EXCEPTION WHEN OTHERS THEN
    r := 'ERROR: ' || SQLERRM;
  END;
  EXECUTE 'RESET ROLE';
  RETURN r;
END $$;

-- ── Fixtures, as the owner ────────────────────────────────────────────────────

CREATE TEMP TABLE ids AS SELECT
  '7e571000-0000-0000-0000-00000000000a'::uuid AS org_a,
  '7e571000-0000-0000-0000-000000000001'::uuid AS u_owner,
  '7e571000-0000-0000-0000-000000000003'::uuid AS u_view,
  '7e571000-0000-0000-0000-000000000004'::uuid AS u_out;
GRANT SELECT ON ids TO authenticated;

INSERT INTO auth.users (id, email, aud, role)
SELECT u, 'owb-ref-test-' || right(u::text, 1) || '@example.invalid', 'authenticated', 'authenticated'
  FROM ids, unnest(ARRAY[u_owner, u_view, u_out]) u;

INSERT INTO public.organizations (id, name) SELECT org_a, 'owb-ref-test-a' FROM ids;

INSERT INTO public.org_members (org_id, user_id, role)
SELECT org_a, u_owner, 'OWNER' FROM ids UNION ALL
SELECT org_a, u_view, 'VIEWER' FROM ids;

DELETE FROM public.org_member_roles WHERE org_id IN (SELECT org_a FROM ids);

INSERT INTO public.org_member_roles (org_id, user_id, role_definition_id)
SELECT x.org, x.u, rd.id
  FROM ids,
       LATERAL (VALUES (org_a, u_owner, 'Owner'), (org_a, u_view, 'Viewer')) x(org, u, role)
  JOIN public.role_definitions rd ON rd.name = x.role AND rd.is_system AND rd.org_id IS NULL;

-- ── Checks ────────────────────────────────────────────────────────────────────

SELECT pg_temp.fact('first label of a year is JE-YYYY-0001', r = 'JE-2026-0001', r)
  FROM ids, LATERAL (SELECT pg_temp.mint(u_owner, org_a, 2026::smallint) r) m;
SELECT pg_temp.fact('second label counts up', r = 'JE-2026-0002', r)
  FROM ids, LATERAL (SELECT pg_temp.mint(u_owner, org_a, 2026::smallint) r) m;
SELECT pg_temp.fact('another year starts again at 0001', r = 'JE-2027-0001', r)
  FROM ids, LATERAL (SELECT pg_temp.mint(u_owner, org_a, 2027::smallint) r) m;

UPDATE public.je_ref_sequence SET last_seq = 999 WHERE org_id = (SELECT org_a FROM ids) AND year = 2026;
SELECT pg_temp.fact('label 1000 is JE-2026-1000', r = 'JE-2026-1000', r)
  FROM ids, LATERAL (SELECT pg_temp.mint(u_owner, org_a, 2026::smallint) r) m;
UPDATE public.je_ref_sequence SET last_seq = 9998 WHERE org_id = (SELECT org_a FROM ids) AND year = 2026;
SELECT pg_temp.fact('label 9999 is JE-2026-9999', r = 'JE-2026-9999', r)
  FROM ids, LATERAL (SELECT pg_temp.mint(u_owner, org_a, 2026::smallint) r) m;
SELECT pg_temp.fact('label 10000 is JE-2026-10000, not a repeat of 1000', r = 'JE-2026-10000', r)
  FROM ids, LATERAL (SELECT pg_temp.mint(u_owner, org_a, 2026::smallint) r) m;

SELECT pg_temp.fact('a viewer is refused', r LIKE 'ERROR: requires journal_entries.write%', r)
  FROM ids, LATERAL (SELECT pg_temp.mint(u_view, org_a, 2026::smallint) r) m;
SELECT pg_temp.fact('a non-member is refused', r LIKE 'ERROR: requires journal_entries.write%', r)
  FROM ids, LATERAL (SELECT pg_temp.mint(u_out, org_a, 2026::smallint) r) m;
SELECT pg_temp.fact('a refused call does not move the counter', last_seq = 10000, last_seq::text)
  FROM public.je_ref_sequence WHERE org_id = (SELECT org_a FROM ids) AND year = 2026;

-- Broken copy: the old four-character LPAD. Passes only if that copy repeats the 1000 label.
DO $$
DECLARE
  v_def TEXT := pg_get_functiondef('public.next_je_ref_number(uuid,smallint)'::regprocedure);
  v_find TEXT := 'CASE WHEN v_seq < 10000 THEN LPAD(v_seq::text, 4, ''0'') ELSE v_seq::text END';
  r TEXT;
BEGIN
  IF position(v_find IN v_def) = 0 THEN
    PERFORM pg_temp.fact('broken copy with the old LPAD is caught', FALSE, 'broken copy not built: text not found');
    RETURN;
  END IF;
  BEGIN
    EXECUTE replace(v_def, v_find, 'LPAD(v_seq::text, 4, ''0'')');
    UPDATE public.je_ref_sequence SET last_seq = 9999 WHERE org_id = (SELECT org_a FROM ids) AND year = 2026;
    r := pg_temp.mint((SELECT u_owner FROM ids), (SELECT org_a FROM ids), 2026::smallint);
    RAISE EXCEPTION USING ERRCODE = 'ZZ999', MESSAGE = r;
  EXCEPTION WHEN SQLSTATE 'ZZ999' THEN
    r := SQLERRM;
  END;
  PERFORM pg_temp.fact('broken copy with the old LPAD is caught', r = 'JE-2026-1000', 'broken copy answered: ' || r);
END $$;

SELECT pg_temp.fact('the real function is back after the broken copy',
  position('CASE WHEN v_seq < 10000' IN pg_get_functiondef('public.next_je_ref_number(uuid,smallint)'::regprocedure)) > 0);

-- ── Result ────────────────────────────────────────────────────────────────────

SELECT n, ok, name, left(detail, 160) AS detail FROM results ORDER BY n;
SELECT count(*) FILTER (WHERE ok) AS passed, count(*) FILTER (WHERE NOT ok) AS failed FROM results;

ROLLBACK;
