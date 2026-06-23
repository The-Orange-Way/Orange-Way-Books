-- ============================================================
-- H2 + M1 + M12, RLS hardening
-- ============================================================
-- Findings from 2026-05-19 full audit.
--
-- H2, Drop two legacy text-role policies on org_members
-- The modern policies `org_members_update` / `org_members_delete`
-- (using `current_user_org_rank()`) already supersede the older
-- `org_members_update_admin` / `org_members_delete_admin_or_self`
-- which reference the unmaintained `org_members.role = 'admin'`
-- text column. Postgres OR-combines permissive policies so the
-- weaker (legacy) wins when both match. New invite flows write
-- only to org_member_roles + capabilities, `org_members.role` is
-- effectively dead and shouldn't gate access.
--
-- M1, Drop redundant "Users can read audit logs in their org"
-- (cmd=ALL) on audit_logs. The SELECT-only `audit_logs_select`
-- policy already exists. With ALL gone, RLS denies UPDATE/DELETE,
-- so only the service role can mutate, which is what an audit
-- log requires for tamper-resistance.
--
-- M12, Tighten `org_insert` WITH CHECK on organizations.
-- The previous `WITH CHECK (true)` let any authenticated user
-- INSERT a row with arbitrary legacy_journal_id / billing_account_id,
-- enabling potential billing piggyback (point a new org at someone
-- else's billing_account). New check: legacy_journal_id and
-- billing_account_id must be NULL on insert (triggers fill them).

BEGIN;

-- ── H2 ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "org_members_update_admin"          ON public.org_members;
DROP POLICY IF EXISTS "org_members_delete_admin_or_self"  ON public.org_members;

-- ── M1 ───────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "Users can read audit logs in their org" ON public.audit_logs;

-- ── M12 ──────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "org_insert" ON public.organizations;
CREATE POLICY "org_insert"
  ON public.organizations
  FOR INSERT TO authenticated
  WITH CHECK (
    legacy_journal_id IS NULL
    AND billing_account_id IS NULL
  );

COMMIT;
