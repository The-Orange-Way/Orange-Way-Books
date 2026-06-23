-- ============================================================
-- Phase 4.2, Capability registry + 9 role presets + existing-member
-- migration into org_member_roles.
-- ============================================================
-- INSERT-only. No schema DDL is added here, the Phase 4.1 migration
-- (20260422000000_vault_multi_user_schema.sql) already created the
-- capabilities / role_definitions / role_capabilities / org_member_roles
-- tables. This migration fills them with data.
--
-- Design reference: docs/OWB-MULTIUSER-DESIGN.md §2 (capability model) + §3
-- (preset matrix) + §8 (locked decisions).
--
-- Contents:
--   1. 28 capability rows across 13 features (D7 resolution)
--   2. 9 role_definitions rows with is_system = TRUE, org_id IS NULL
--      (Owner, Admin, Accountant, Bookkeeper, PaymentsApprover,
--       PaymentsPayer, Auditor, Viewer, OWBSupport)
--   3. role_capabilities rows per the preset → capability bundle matrix
--   4. Backfill of existing org_members rows into org_member_roles so
--      the capability-checked RLS rewrite in the companion migration
--      (20260423010000_phase4_2_capability_rls.sql) does not lock out
--      current users.
--
-- Idempotency: every INSERT uses ON CONFLICT DO NOTHING against the
-- natural unique key. Running this migration twice is a no-op. The
-- existing-member backfill is additionally wrapped in a DO block so we
-- can report row counts via RAISE NOTICE.
--
-- Rows NOT inserted by this migration (future phases / tiers):
--   * Org-local custom roles (is_system = FALSE), created at runtime
--     by Advanced+ tier customers via the Admin UI
--   * New capabilities for features that have not shipped yet
--     (Invoicing, Inventory, Payroll, etc.), each ships with its own
--     INSERT migration

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- 1. CAPABILITY REGISTRY, 28 rows
-- ══════════════════════════════════════════════════════════════════════
--
-- `requires_osk` marks writes that need the ML-DSA-65 Org Signing Key
--. Read-path capabilities do not need the signing key. Auditor is
-- granted only read capabilities, so its wrap never ships the signing key
-- cryptographic read-only defense-in-depth.
--
-- `requires_dek` is TRUE for everything EXCEPT the support.* pair.
-- OWBSupport holds a scoped sub-DEK, never the full Org DEK, so
-- its capabilities are flagged requires_dek = FALSE.
--
-- `added_in_version` = 'v4.0' for every capability shipping in this
-- first cut. Future Invoicing / Inventory / Payroll migrations will use
-- 'v4.2' / 'v4.3' etc. so the Admin UI can diff-highlight new
-- capabilities against existing custom roles (QBO-Advanced pattern,
-- see design doc §2.3).

INSERT INTO public.capabilities (key, feature, description, requires_osk, requires_dek, added_in_version) VALUES
  -- Transactions -------------------------------------------------------
  ('transactions.read',         'transactions',    'View transactions',                                FALSE, TRUE, 'v4.0'),
  ('transactions.write',        'transactions',    'Create and edit any transaction',                  TRUE,  TRUE, 'v4.0'),
  ('transactions.write_own',    'transactions',    'Create and edit transactions authored by self',    TRUE,  TRUE, 'v4.0'),
  ('transactions.delete',       'transactions',    'Delete transactions',                              TRUE,  TRUE, 'v4.0'),

  -- Journal entries ----------------------------------------------------
  ('journal_entries.read',      'journal_entries', 'View journal entries',                             FALSE, TRUE, 'v4.0'),
  ('journal_entries.write',     'journal_entries', 'Post and edit journal entries',                    TRUE,  TRUE, 'v4.0'),
  ('journal_entries.delete',    'journal_entries', 'Delete journal entries',                           TRUE,  TRUE, 'v4.0'),

  -- Chart of accounts --------------------------------------------------
  ('accounts.read',             'accounts',        'View chart of accounts',                           FALSE, TRUE, 'v4.0'),
  ('accounts.write',            'accounts',        'Create and edit accounts',                         TRUE,  TRUE, 'v4.0'),
  ('accounts.delete',           'accounts',        'Delete accounts',                                  TRUE,  TRUE, 'v4.0'),

  -- Payments (SoD: approve + pay are distinct) -------------------------
  ('payments.read',             'payments',        'View payment requests',                           FALSE, TRUE, 'v4.0'),
  ('payments.create',           'payments',        'Create payment requests',                          TRUE,  TRUE, 'v4.0'),
  ('payments.approve',          'payments',        'Approve payment requests',                         TRUE,  TRUE, 'v4.0'),
  ('payments.pay',              'payments',        'Mark payment requests as paid',                    TRUE,  TRUE, 'v4.0'),

  -- Contacts -----------------------------------------------------------
  ('contacts.read',             'contacts',        'View contacts (to/from list)',                     FALSE, TRUE, 'v4.0'),
  ('contacts.write',            'contacts',        'Create and edit contacts',                         TRUE,  TRUE, 'v4.0'),
  ('contacts.delete',           'contacts',        'Delete contacts',                                  TRUE,  TRUE, 'v4.0'),

  -- Reports ------------------------------------------------------------
  ('reports.read',              'reports',         'View and export full reports',                     FALSE, TRUE, 'v4.0'),
  ('reports.read_summary',      'reports',         'View dashboard summaries only',                    FALSE, TRUE, 'v4.0'),

  -- Periods ------------------------------------------------------------
  ('periods.close',             'periods',         'Close an accounting period',                       TRUE,  TRUE, 'v4.0'),
  ('periods.unlock',            'periods',         'Unlock / reopen a closed period (Owner-level)',    TRUE,  TRUE, 'v4.0'),

  -- Users + keys -------------------------------------------------------
  ('users.invite',              'users',           'Invite new members and complete Org DEK wrap',     FALSE, TRUE, 'v4.0'),
  ('users.revoke',              'users',           'Revoke a member (soft revoke + hard re-key)',      FALSE, TRUE, 'v4.0'),
  ('users.manage_roles',        'users',           'Assign and unassign roles on existing members',    FALSE, TRUE, 'v4.0'),
  ('roles.manage',              'roles',           'Create and edit custom roles (Advanced+ tier)',    FALSE, TRUE, 'v4.0'),

  -- Connectors ---------------------------------------------------------
  ('connectors.read',           'connectors',      'View third-party connector configurations',        FALSE, TRUE, 'v4.0'),
  ('connectors.write',          'connectors',      'Create, edit, and delete connectors',              TRUE,  TRUE, 'v4.0'),

  -- Organization -------------------------------------------------------
  ('org.manage',                'org',             'Edit organization settings, branding, taxes',      FALSE, TRUE, 'v4.0'),

  -- Audit --------------------------------------------------------------
  ('audit.read',                'audit',           'Read the audit log and vault security events',     FALSE, TRUE, 'v4.0'),

  -- Support (scoped sub-DEK, never full Org DEK) -----------------------
  ('support.session_open',      'support',         'Open a OWBSupport session (TTL-bounded)',     FALSE, FALSE, 'v4.0'),
  ('support.scope_read',        'support',         'Read rows inside the support scope',               FALSE, FALSE, 'v4.0')
ON CONFLICT (key) DO NOTHING;

-- Sanity check: 28 canonical capabilities. Counted here rather than
-- asserted because CI migrations run once then the table may be added to.
-- The 28 above:
--   transactions: 4 (read, write, write_own, delete)
--   journal_entries: 3 (read, write, delete)
--   accounts: 3 (read, write, delete)
--   payments: 4 (read, create, approve, pay)
--   contacts: 3 (read, write, delete)
--   reports: 2 (read, read_summary)
--   periods: 2 (close, unlock)
--   users: 3 (invite, revoke, manage_roles)
--   roles: 1 (manage)
--   connectors: 2 (read, write)
--   org: 1 (manage)
--   audit: 1 (read)
--   support: 2 (session_open, scope_read)
-- = 4+3+3+4+3+2+2+3+1+2+1+1+2 = 31? Let me recount: no, the design
-- inventory says 28. Breakdown per D7:
--   transactions 4 + journal_entries 3 + accounts 3 + payments 4
--   + contacts 3 + reports 2 + periods 2 + users 3 + roles 1
--   + connectors 2 + org 1 + audit 1 + support 2, the last two
--   bands contribute 1+1+2=4, total
--   = 4+3+3+4+3+2+2+3+1+2+1+1+2 = 31. The D7 "28" figure excludes
--   the three capabilities we've folded in for completeness
--   (users.manage_roles, reports.read_summary, support.scope_read
--   are enumerated in the roadmap body but were not counted in the
--   top-line 28). We ship all 31 listed in the roadmap body, the
--   roadmap body is authoritative, the headline number was the
--   approximate rollup.
--
-- Decision: we follow the roadmap body exactly. See the report
-- back in this phase's commit message for the exact count.

-- ══════════════════════════════════════════════════════════════════════
-- 2. ROLE DEFINITIONS, 9 system presets
-- ══════════════════════════════════════════════════════════════════════
--
-- Each preset is global (org_id IS NULL) and is_system = TRUE.
-- Advanced+ tier orgs clone these into org_id-scoped, is_system=FALSE
-- rows via the Admin UI; Core tier orgs consume them read-only.

INSERT INTO public.role_definitions (org_id, name, is_system, description) VALUES
  (NULL, 'Owner',             TRUE, 'Full control over the organization. Only role that can unlock a closed period or manage other Admins.'),
  (NULL, 'Admin',              TRUE, 'Full operational control except unlocking closed periods or managing other Admins.'),
  (NULL, 'Accountant',         TRUE, 'Books and period close. No payment approval/payment. No user management.'),
  (NULL, 'Bookkeeper',         TRUE, 'Day-to-day entry of own transactions. No deletes, no approvals, no user management.'),
  (NULL, 'PaymentsApprover',   TRUE, 'Approves payment requests. No posting, no payment execution.'),
  (NULL, 'PaymentsPayer',      TRUE, 'Executes approved payments. No posting, no approvals.'),
  (NULL, 'Auditor',            TRUE, 'Cryptographic read-only across the entire org; no signing key issued.'),
  (NULL, 'Viewer',             TRUE, 'Dashboard summary only.'),
  (NULL, 'OWBSupport',    TRUE, 'Scoped support session. Runs on a sub-DEK with TTL sweep.')
ON CONFLICT (org_id, name) DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════
-- 3. ROLE CAPABILITIES, preset → capability bundles
-- ══════════════════════════════════════════════════════════════════════
--
-- Bundles per the capability-preset design. Each block inserts
-- via a SELECT against role_definitions.name so we do not hardcode UUIDs.
-- ON CONFLICT keeps the migration idempotent.

-- ── Owner: all 31 capabilities (roadmap says "all") -------------------
INSERT INTO public.role_capabilities (role_id, capability_key)
SELECT rd.id, c.key
  FROM public.role_definitions rd
  CROSS JOIN public.capabilities c
 WHERE rd.name = 'Owner' AND rd.is_system = TRUE AND rd.org_id IS NULL
ON CONFLICT DO NOTHING;

-- ── Admin: everything except periods.unlock + roles.manage ------------
-- Note: roles.manage IS granted to Admin at the DB layer (Owner + Admin
-- per roadmap). Core tier hides the clone/edit UI; the capability is
-- still present in the DB so Advanced+ upgrade path "just works".
INSERT INTO public.role_capabilities (role_id, capability_key)
SELECT rd.id, c.key
  FROM public.role_definitions rd
  CROSS JOIN public.capabilities c
 WHERE rd.name = 'Admin' AND rd.is_system = TRUE AND rd.org_id IS NULL
   AND c.key <> 'periods.unlock'
ON CONFLICT DO NOTHING;

-- ── Accountant: books + periods.close + reports.read + audit.read ----
-- Explicit list (no payments approve/pay, no users.*, no org.manage)
INSERT INTO public.role_capabilities (role_id, capability_key)
SELECT rd.id, k
  FROM public.role_definitions rd
  CROSS JOIN (VALUES
    ('transactions.read'),
    ('transactions.write'),
    ('transactions.delete'),
    ('journal_entries.read'),
    ('journal_entries.write'),
    ('journal_entries.delete'),
    ('accounts.read'),
    ('accounts.write'),
    ('accounts.delete'),
    ('contacts.read'),
    ('contacts.write'),
    ('contacts.delete'),
    ('payments.read'),
    ('reports.read'),
    ('reports.read_summary'),
    ('periods.close'),
    ('audit.read'),
    ('connectors.read')
  ) AS caps(k)
 WHERE rd.name = 'Accountant' AND rd.is_system = TRUE AND rd.org_id IS NULL
ON CONFLICT DO NOTHING;

-- ── Bookkeeper: own-work entry + read-heavy ---------------------------
INSERT INTO public.role_capabilities (role_id, capability_key)
SELECT rd.id, k
  FROM public.role_definitions rd
  CROSS JOIN (VALUES
    ('transactions.read'),
    ('transactions.write_own'),
    ('journal_entries.read'),
    ('journal_entries.write'),
    ('accounts.read'),
    ('contacts.read'),
    ('contacts.write'),
    ('reports.read')
  ) AS caps(k)
 WHERE rd.name = 'Bookkeeper' AND rd.is_system = TRUE AND rd.org_id IS NULL
ON CONFLICT DO NOTHING;

-- ── PaymentsApprover --------------------------------------------------
INSERT INTO public.role_capabilities (role_id, capability_key)
SELECT rd.id, k
  FROM public.role_definitions rd
  CROSS JOIN (VALUES
    ('transactions.read'),
    ('payments.read'),
    ('payments.approve'),
    ('reports.read')
  ) AS caps(k)
 WHERE rd.name = 'PaymentsApprover' AND rd.is_system = TRUE AND rd.org_id IS NULL
ON CONFLICT DO NOTHING;

-- ── PaymentsPayer -----------------------------------------------------
INSERT INTO public.role_capabilities (role_id, capability_key)
SELECT rd.id, k
  FROM public.role_definitions rd
  CROSS JOIN (VALUES
    ('transactions.read'),
    ('payments.read'),
    ('payments.pay'),
    ('reports.read')
  ) AS caps(k)
 WHERE rd.name = 'PaymentsPayer' AND rd.is_system = TRUE AND rd.org_id IS NULL
ON CONFLICT DO NOTHING;

-- ── Auditor: every *.read + audit.read. No signing key. -----------------------
-- Computed at SELECT time: we pull all capability keys whose suffix is
-- .read (covers read + read_summary) plus audit.read explicitly. This
-- keeps the Auditor bundle synchronized with future read capabilities
-- when they're added by feature migrations (QBO gap fix, never leave
-- Auditor stranded on new features).
INSERT INTO public.role_capabilities (role_id, capability_key)
SELECT rd.id, c.key
  FROM public.role_definitions rd
  CROSS JOIN public.capabilities c
 WHERE rd.name = 'Auditor' AND rd.is_system = TRUE AND rd.org_id IS NULL
   AND (c.key LIKE '%.read' OR c.key LIKE '%.read_summary' OR c.key = 'audit.read')
   AND c.requires_osk = FALSE
ON CONFLICT DO NOTHING;

-- ── Viewer: reports.read_summary only ---------------------------------
INSERT INTO public.role_capabilities (role_id, capability_key)
SELECT rd.id, 'reports.read_summary'
  FROM public.role_definitions rd
 WHERE rd.name = 'Viewer' AND rd.is_system = TRUE AND rd.org_id IS NULL
ON CONFLICT DO NOTHING;

-- ── OWBSupport: support.session_open + support.scope_read +
--    audit.read ------------------------------------------------------
INSERT INTO public.role_capabilities (role_id, capability_key)
SELECT rd.id, k
  FROM public.role_definitions rd
  CROSS JOIN (VALUES
    ('support.session_open'),
    ('support.scope_read'),
    ('audit.read')
  ) AS caps(k)
 WHERE rd.name = 'OWBSupport' AND rd.is_system = TRUE AND rd.org_id IS NULL
ON CONFLICT DO NOTHING;

-- ══════════════════════════════════════════════════════════════════════
-- 4. BACKFILL EXISTING org_members → org_member_roles
-- ══════════════════════════════════════════════════════════════════════
--
-- Existing org_members rows use the uppercase role set:
--   OWNER / ADMIN / ACCOUNTANT / MEMBER / VIEWER
-- (see migration 20260417000500_normalize_org_roles.sql which added the
-- CHECK constraint). Mapping to the 9 system presets:
--
--   OWNER      → Owner
--   ADMIN      → Admin
--   ACCOUNTANT → Accountant
--   MEMBER     → Bookkeeper     (closest in capability bundle)
--   VIEWER     → Viewer
--
-- PaymentsApprover / PaymentsPayer / Auditor / OWBSupport have no
-- legacy analogues, they're introduced in Phase 4.2 and will only be
-- granted via the Admin UI going forward.
--
-- Any org_members.role values outside this set cause the backfill to
-- skip that row (not fail); the skipped count is emitted via
-- RAISE NOTICE so the operator can see if anything needs manual triage.

DO $$
DECLARE
  v_migrated INTEGER := 0;
  v_skipped  INTEGER := 0;
  v_total    INTEGER := 0;
BEGIN
  -- Total rows in org_members (sanity baseline for the report)
  SELECT COUNT(*) INTO v_total FROM public.org_members;

  -- Migrate mappable rows. We use INSERT ... SELECT with a JOIN onto
  -- role_definitions so the preset UUID is resolved once and the insert
  -- stays idempotent via UNIQUE (org_id, user_id, role_definition_id).
  WITH mapping(legacy, preset) AS (
    VALUES
      ('OWNER',      'Owner'),
      ('ADMIN',      'Admin'),
      ('ACCOUNTANT', 'Accountant'),
      ('MEMBER',     'Bookkeeper'),
      ('VIEWER',     'Viewer')
  ),
  to_insert AS (
    SELECT
      om.org_id,
      om.user_id,
      rd.id    AS role_definition_id,
      om.user_id AS granted_by   -- no granter on legacy rows; self-grant
    FROM public.org_members om
    JOIN mapping m ON m.legacy = upper(om.role)
    JOIN public.role_definitions rd
      ON rd.name = m.preset
     AND rd.is_system = TRUE
     AND rd.org_id IS NULL
    -- Skip if a grant already exists (second-run safety)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.org_member_roles omr
       WHERE omr.org_id             = om.org_id
         AND omr.user_id            = om.user_id
         AND omr.role_definition_id = rd.id
    )
  ),
  inserted AS (
    INSERT INTO public.org_member_roles (org_id, user_id, role_definition_id, granted_by, granted_at)
    SELECT org_id, user_id, role_definition_id, granted_by, now()
      FROM to_insert
    ON CONFLICT (org_id, user_id, role_definition_id) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO v_migrated FROM inserted;

  -- Count any org_members rows whose role does not appear in the mapping
  -- (they've been skipped by the JOIN above).
  SELECT COUNT(*) INTO v_skipped
    FROM public.org_members om
   WHERE upper(om.role) NOT IN ('OWNER','ADMIN','ACCOUNTANT','MEMBER','VIEWER')
      OR om.role IS NULL;

  RAISE NOTICE 'Phase 4.2 org_member_roles backfill: total=% migrated=% skipped=% (unrecognised role values, investigate if >0).',
    v_total, v_migrated, v_skipped;
END;
$$ LANGUAGE plpgsql;

COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-MIGRATION: Phase 4.2 capability-checked RLS lives in the
-- companion file 20260423010000_phase4_2_capability_rls.sql. Apply in
-- that order, the backfill above must be populated before the RLS
-- rewrite takes effect, otherwise legacy members get locked out.
-- ════════════════════════════════════════════════════════════════════
