-- Phase 1 invariant tests (pgTAP).
--
-- Covers:
--   I1  journal_entries.status CHECK constraint
--   I2  journal_entries.source_type CHECK constraint
--   I3  Immutability of POSTED entries (cannot edit business fields)
--   I4  Immutability — cannot delete POSTED entries
--   I5  Immutability — cannot edit/delete lines on POSTED parent
--   I6  Status flip POSTED → VOID is allowed (workflow-meta whitelist)
--   I7  Status flip DRAFT → POSTED is allowed
--   I8  Reversal partial-unique: cannot reverse the same JE twice
--   I9  Chart-of-accounts parent same-org enforcement
--   I10 JE line account same-org enforcement
--
-- Run via: psql ... -f supabase/tests/phase1-invariants.test.sql
-- Or: supabase test db (when wired)

BEGIN;
SELECT plan(20);

-- ── Test fixtures ────────────────────────────────────────────────────────────

-- Seed test org + 3 chart-of-accounts rows (one Asset, one Income, one for cross-org test)
DO $$
DECLARE
  v_org   UUID := '00000000-0000-0000-0000-000000000001';
  v_org2  UUID := '00000000-0000-0000-0000-000000000002';
BEGIN
  DELETE FROM public.journal_entry_lines WHERE journal_entry_id IN
    (SELECT id FROM public.journal_entries WHERE org_id IN (v_org, v_org2));
  DELETE FROM public.journal_entries WHERE org_id IN (v_org, v_org2);
  DELETE FROM public.chart_of_accounts WHERE org_id IN (v_org, v_org2);
  DELETE FROM public.organizations WHERE id IN (v_org, v_org2);

  INSERT INTO public.organizations (id, name) VALUES (v_org,  'pgtap-org-1');
  INSERT INTO public.organizations (id, name) VALUES (v_org2, 'pgtap-org-2');

  INSERT INTO public.chart_of_accounts (id, org_id, encrypted_name, encrypted_account_type, encrypted_is_group, encrypted_is_system)
    VALUES ('00000000-0000-0000-0000-0000000000a1', v_org,  'CIPHER_CASH',  'CIPHER_ASSET',  'CIPHER_FALSE', 'CIPHER_TRUE');
  INSERT INTO public.chart_of_accounts (id, org_id, encrypted_name, encrypted_account_type, encrypted_is_group, encrypted_is_system)
    VALUES ('00000000-0000-0000-0000-0000000000a2', v_org,  'CIPHER_SALES', 'CIPHER_INCOME', 'CIPHER_FALSE', 'CIPHER_TRUE');
  INSERT INTO public.chart_of_accounts (id, org_id, encrypted_name, encrypted_account_type, encrypted_is_group, encrypted_is_system)
    VALUES ('00000000-0000-0000-0000-0000000000a3', v_org2, 'CIPHER_OTHER', 'CIPHER_ASSET',  'CIPHER_FALSE', 'CIPHER_TRUE');
END $$;

-- ── I1: status CHECK ─────────────────────────────────────────────────────────

SELECT throws_ok(
  $$ INSERT INTO public.journal_entries (org_id, date, status, encrypted_currency)
     VALUES ('00000000-0000-0000-0000-000000000001', CURRENT_DATE, 'INVALID', 'CIPHER_USD') $$,
  '23514', NULL,
  'I1: status CHECK rejects values outside {DRAFT,POSTED,VOID,VOID_REVERSAL}'
);

-- ── I2: source_type CHECK ────────────────────────────────────────────────────

SELECT throws_ok(
  $$ INSERT INTO public.journal_entries (org_id, date, status, source_type, encrypted_currency)
     VALUES ('00000000-0000-0000-0000-000000000001', CURRENT_DATE, 'DRAFT', 'invalid-source', 'CIPHER_USD') $$,
  '23514', NULL,
  'I2: source_type CHECK rejects unknown source values'
);

-- ── Valid insert + balanced lines (setup for I3-I7) ──────────────────────────

INSERT INTO public.journal_entries (id, org_id, date, status, source_type, encrypted_currency, encrypted_memo)
  VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-000000000001',
          CURRENT_DATE, 'DRAFT', 'manual', 'CIPHER_USD', 'CIPHER_ORIGINAL_MEMO');

INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, encrypted_debit, encrypted_credit)
  VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', 'CIPHER_DR_100', 'CIPHER_CR_0');
INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, encrypted_debit, encrypted_credit)
  VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a2', 'CIPHER_DR_0', 'CIPHER_CR_100');

SELECT pass('I_setup: DRAFT JE with 2 lines created OK');

-- ── I7: DRAFT → POSTED is allowed ────────────────────────────────────────────

UPDATE public.journal_entries SET status = 'POSTED' WHERE id = '00000000-0000-0000-0000-0000000000e1';
SELECT pass('I7: DRAFT → POSTED transition allowed');

-- ── I3: cannot edit business fields on POSTED entry ──────────────────────────

SELECT throws_ok(
  $$ UPDATE public.journal_entries SET encrypted_memo = 'CIPHER_TAMPERED'
       WHERE id = '00000000-0000-0000-0000-0000000000e1' $$,
  'integrity_constraint_violation', NULL,
  'I3: cannot change encrypted_memo on POSTED entry'
);

SELECT throws_ok(
  $$ UPDATE public.journal_entries SET date = CURRENT_DATE - 30
       WHERE id = '00000000-0000-0000-0000-0000000000e1' $$,
  'integrity_constraint_violation', NULL,
  'I3: cannot change date on POSTED entry'
);

SELECT throws_ok(
  $$ UPDATE public.journal_entries SET encrypted_currency = 'CIPHER_EUR'
       WHERE id = '00000000-0000-0000-0000-0000000000e1' $$,
  'integrity_constraint_violation', NULL,
  'I3: cannot change encrypted_currency on POSTED entry'
);

-- ── I4: cannot delete POSTED entry ───────────────────────────────────────────

SELECT throws_ok(
  $$ DELETE FROM public.journal_entries WHERE id = '00000000-0000-0000-0000-0000000000e1' $$,
  'integrity_constraint_violation', NULL,
  'I4: cannot DELETE a POSTED entry'
);

-- ── I5: cannot edit/delete lines on POSTED parent ────────────────────────────

SELECT throws_ok(
  $$ UPDATE public.journal_entry_lines SET encrypted_debit = 'CIPHER_TAMPERED'
       WHERE journal_entry_id = '00000000-0000-0000-0000-0000000000e1' $$,
  'integrity_constraint_violation', NULL,
  'I5: cannot UPDATE lines on POSTED entry'
);

SELECT throws_ok(
  $$ DELETE FROM public.journal_entry_lines WHERE journal_entry_id = '00000000-0000-0000-0000-0000000000e1' $$,
  'integrity_constraint_violation', NULL,
  'I5: cannot DELETE lines on POSTED entry'
);

-- ── I6: POSTED → VOID flip is allowed (workflow-meta whitelist) ──────────────

UPDATE public.journal_entries SET status = 'VOID' WHERE id = '00000000-0000-0000-0000-0000000000e1';
SELECT pass('I6: POSTED → VOID status flip allowed via workflow-meta whitelist');

-- After flip, still cannot edit other fields:
SELECT throws_ok(
  $$ UPDATE public.journal_entries SET encrypted_memo = 'CIPHER_TAMPERED'
       WHERE id = '00000000-0000-0000-0000-0000000000e1' $$,
  'integrity_constraint_violation', NULL,
  'I6b: still cannot change business fields on VOID entry'
);

-- ── I8: reversal partial-unique forbids double-reversal ──────────────────────

-- Insert an original POSTED entry that the reversal will point at.
INSERT INTO public.journal_entries (id, org_id, date, status, source_type, encrypted_currency)
  VALUES ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-000000000001',
          CURRENT_DATE, 'DRAFT', 'manual', 'CIPHER_USD');
INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, encrypted_debit, encrypted_credit)
  VALUES ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', 'CIPHER_DR_50', 'CIPHER_CR_0');
INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, encrypted_debit, encrypted_credit)
  VALUES ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a2', 'CIPHER_DR_0', 'CIPHER_CR_50');
UPDATE public.journal_entries SET status = 'POSTED' WHERE id = '00000000-0000-0000-0000-0000000000e2';

-- First reversal entry pointing at e2:
INSERT INTO public.journal_entries (id, org_id, date, status, source_type, encrypted_currency, reversal_of_id)
  VALUES ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-000000000001',
          CURRENT_DATE, 'POSTED', 'void_reversal', 'CIPHER_USD',
          '00000000-0000-0000-0000-0000000000e2');
SELECT pass('I8a: first reversal of an entry inserts OK');

-- Second reversal pointing at the SAME original — must be rejected by partial unique.
SELECT throws_ok(
  $$ INSERT INTO public.journal_entries (org_id, date, status, source_type, encrypted_currency, reversal_of_id)
     VALUES ('00000000-0000-0000-0000-000000000001', CURRENT_DATE, 'POSTED', 'void_reversal', 'CIPHER_USD',
             '00000000-0000-0000-0000-0000000000e2') $$,
  '23505', NULL,
  'I8b: second reversal of the same entry is rejected (partial unique on reversal_of_id)'
);

-- ── I9: chart_of_accounts parent must be same org ────────────────────────────

SELECT throws_ok(
  $$ INSERT INTO public.chart_of_accounts (org_id, encrypted_name, encrypted_account_type, encrypted_is_group, encrypted_is_system, parent_id)
     VALUES ('00000000-0000-0000-0000-000000000001', 'CIPHER_X', 'CIPHER_ASSET', 'CIPHER_FALSE', 'CIPHER_FALSE',
             '00000000-0000-0000-0000-0000000000a3') $$,
  '23514', NULL,
  'I9: chart_of_accounts.parent_id from another org is rejected'
);

-- ── I10: JE line account must be in the same org as the parent JE ────────────

SELECT throws_ok(
  $$ INSERT INTO public.journal_entry_lines (journal_entry_id, account_id, encrypted_debit, encrypted_credit)
     VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a3', 'CIPHER_DR', 'CIPHER_CR') $$,
  '23514', NULL,
  'I10: JE line account_id from a different org than the JE is rejected'
);

-- ── Cleanup helpers (release the locks the immutability trigger places) ──────
-- For test cleanup, briefly disable the immutability triggers so we can tear
-- down the test rows.

ALTER TABLE public.journal_entries     DISABLE TRIGGER trg_protect_finalized_je;
ALTER TABLE public.journal_entry_lines DISABLE TRIGGER trg_protect_finalized_jel;

DELETE FROM public.journal_entry_lines WHERE journal_entry_id IN
  ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000e3');
DELETE FROM public.journal_entries WHERE id IN
  ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000e3');
DELETE FROM public.chart_of_accounts WHERE org_id IN
  ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');
DELETE FROM public.organizations WHERE id IN
  ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002');

ALTER TABLE public.journal_entries     ENABLE TRIGGER trg_protect_finalized_je;
ALTER TABLE public.journal_entry_lines ENABLE TRIGGER trg_protect_finalized_jel;

SELECT finish();
ROLLBACK;
