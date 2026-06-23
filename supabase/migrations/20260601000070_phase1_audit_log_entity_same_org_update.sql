-- Phase 1, Migration 7/9: Update `check_audit_log_entity_same_org()` to point
-- at the new `chart_of_accounts` table (replacing `legacy_account_map`).
--
-- The original lives in 20260417000400_data_integrity_triggers.sql lines 65-140.
-- The journal_entry branch + chart_of_account branch both need rewiring.

CREATE OR REPLACE FUNCTION public.check_audit_log_entity_same_org()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  matched_org uuid;
BEGIN
  -- DELETE/VOID audit entries skip cross-table existence checks (the target row
  -- may already be removed by the time the audit row is written).
  IF NEW.action IN ('DELETE', 'VOID') THEN
    RETURN NEW;
  END IF;

  IF NEW.entity_type = 'organization' THEN
    IF NEW.entity_id <> NEW.org_id THEN
      RAISE EXCEPTION 'audit_logs.entity_id must equal org_id for entity_type=organization'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.entity_type = 'member' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.org_members m
        WHERE m.org_id = NEW.org_id AND m.user_id = NEW.entity_id
    ) THEN
      RAISE EXCEPTION 'audit_logs.entity_id % is not a member of org %', NEW.entity_id, NEW.org_id
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.entity_type = 'wallet' THEN
    SELECT w.org_id INTO matched_org FROM public.accounts w WHERE w.id = NEW.entity_id;
  ELSIF NEW.entity_type = 'transaction' THEN
    SELECT t.org_id INTO matched_org FROM public.transactions t WHERE t.id = NEW.entity_id;
  ELSIF NEW.entity_type = 'journal_entry' THEN
    -- POST-PHASE-1: journal_entries was recreated with the same column shape
    -- (id, org_id) so this lookup is identical.
    SELECT j.org_id INTO matched_org FROM public.journal_entries j WHERE j.id = NEW.entity_id;
  ELSIF NEW.entity_type = 'contact' THEN
    SELECT c.org_id INTO matched_org FROM public.contacts c WHERE c.id = NEW.entity_id;
  ELSIF NEW.entity_type = 'payment_request' THEN
    SELECT p.org_id INTO matched_org FROM public.payment_requests p WHERE p.id = NEW.entity_id;
  ELSIF NEW.entity_type = 'chart_of_account' THEN
    -- POST-PHASE-1: was legacy_account_map, now chart_of_accounts.
    SELECT a.org_id INTO matched_org FROM public.chart_of_accounts a WHERE a.id = NEW.entity_id;
  ELSIF NEW.entity_type = 'connector' THEN
    SELECT c.org_id INTO matched_org FROM public.connectors c WHERE c.id = NEW.entity_id;
  ELSIF NEW.entity_type = 'org_settings' THEN
    SELECT s.org_id INTO matched_org FROM public.org_settings s WHERE s.org_id = NEW.entity_id;
  ELSE
    -- Unknown entity_type: the CHECK constraint on audit_logs.entity_type
    -- already gates the enum; if it widens, fall through and accept.
    RETURN NEW;
  END IF;

  -- Row might have been deleted between write and audit insert in a race.
  -- Accept the audit entry rather than losing the audit trail; the org_id
  -- on the audit row is still RLS-gated, so cross-tenant abuse is impossible.
  IF matched_org IS NULL THEN
    RETURN NEW;
  END IF;
  IF matched_org <> NEW.org_id THEN
    RAISE EXCEPTION 'audit_logs.entity_id % belongs to a different org', NEW.entity_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

-- The trigger itself is still attached (it was created in 20260417000400 and
-- never dropped). The function-replace above is sufficient, no DROP/CREATE needed.

COMMENT ON FUNCTION public.check_audit_log_entity_same_org() IS
  'Validates audit_logs.entity_id belongs to the same org as audit_logs.org_id. Phase 1 redesign: chart_of_account branch now queries public.chart_of_accounts (was public.legacy_account_map).';
