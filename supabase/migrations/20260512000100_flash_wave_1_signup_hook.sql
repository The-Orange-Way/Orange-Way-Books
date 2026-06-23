-- ============================================================
-- Flash Wave 1, auto-create billing_account + subscription
-- whenever a new organization is created.
-- ============================================================
--
-- OWB has no auth.users signup trigger. New users go through the
-- onboarding wizard, which inserts into public.organizations. The
-- existing trg_auto_insert_org_owner trigger fires AFTER INSERT on
-- organizations and grants the caller OWNER role.
--
-- We piggyback the same insertion point: on every new organization,
-- create a personal billing_account (type='org', owner = the auth.uid()
-- caller) and a subscription on it (plan='monthly_v1', price_cents=3000,
-- currency='USD', status='trialing', trial_ends_at = now() + 45 days).
-- We then set the new org's billing_account_id to point at it.
--
-- Wave 1 ships only the solo-org case. Firm-billing assignments will
-- reuse the same billing_accounts row by reassigning organizations
-- .billing_account_id later (no schema change needed).
--
-- SECURITY DEFINER so the trigger can insert into billing_accounts /
-- subscriptions without RLS getting in the way (writes to those tables
-- are service-role only by design).

BEGIN;

CREATE OR REPLACE FUNCTION public.auto_provision_billing_for_new_org()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  caller UUID := auth.uid();
  caller_email TEXT;
  derived_name TEXT;
  new_ba_id UUID;
BEGIN
  -- Bypass when there is no auth context (server-side seeding etc.).
  IF caller IS NULL THEN
    RETURN NEW;
  END IF;

  -- Idempotent: if the org was already pointed at a billing_account,
  -- leave it alone.
  IF NEW.billing_account_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- Derive a display name from the caller's email prefix; fall back to
  -- 'Personal' when the email is unavailable.
  SELECT email INTO caller_email FROM auth.users WHERE id = caller;
  derived_name := COALESCE(NULLIF(split_part(caller_email, '@', 1), ''), 'Personal');

  INSERT INTO public.billing_accounts (type, display_name, owner_user_id)
    VALUES ('org', derived_name, caller)
    RETURNING id INTO new_ba_id;

  INSERT INTO public.subscriptions (
    billing_account_id, plan, price_cents, currency,
    status, trial_ends_at
  ) VALUES (
    new_ba_id, 'monthly_v1', 3000, 'USD',
    'trialing', now() + interval '45 days'
  );

  -- Point the new org at its fresh billing_account.
  UPDATE public.organizations
     SET billing_account_id = new_ba_id
   WHERE id = NEW.id;

  -- Mutate NEW so the row visible to subsequent triggers is consistent.
  NEW.billing_account_id := new_ba_id;

  RETURN NEW;
END
$$;

-- Run BEFORE auto_insert_org_owner (alphabetical order of trigger names
-- breaks ties; "trg_auto_insert_org_owner" sorts after
-- "trg_auto_provision_billing"). Both are AFTER triggers so order only
-- matters for ordering of side-effects, not row visibility.
DROP TRIGGER IF EXISTS trg_auto_provision_billing ON public.organizations;
CREATE TRIGGER trg_auto_provision_billing
  AFTER INSERT ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_provision_billing_for_new_org();

COMMIT;
