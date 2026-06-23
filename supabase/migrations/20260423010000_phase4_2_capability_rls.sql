-- ============================================================
-- Phase 4.2, Capability-checked RLS on mutating business tables
--                + D9 last-role-removal enforcement trigger.
-- ============================================================
-- Rewrites INSERT / UPDATE / DELETE policies on the business-entity
-- tables to route through public.user_has_capability(). SELECT policies
-- stay as-is for now (membership-based read gates are still correct
-- they only change when we introduce *.read capability gates in a
-- future phase, which would be a behavior change beyond 4.2).
--
-- Locked scope:
--   * mutating policies rewritten → capability checks
--   * D9 enforcement: last active role revoked → drop org_keys wrap +
--     log a vault_security_event
--   * SELECT policies untouched unless they gate membership wrong
--
-- Tables whose mutating policies are rewritten here:
--   1. transactions           (transactions.write / .write_own / .delete)
--   2. transaction_metadata   (transactions.write / .delete)
--   3. journal_entries        (journal_entries.write / .delete)
--   4. journal_entry_lines    (journal_entries.write / .delete, via join)
--   5. account_metadata       (accounts.write / .delete)
--   6. legacy_account_map       (accounts.write / .delete)
--   7. contacts               (contacts.write / .delete)
--   8. payment_requests       (payments.create / .approve / .pay)
--   9. accounts                (transactions.write, accounts carry entries)
--  10. connectors             (connectors.write)
--  11. organizations          (org.manage for UPDATE; DELETE requires
--                              org.manage in this cut)
--  12. org_settings           (org.manage)
--  13. attachments            (transactions.write, attachments attach
--                              to transactions)
--
-- Not touched (out of scope / pure infra):
--   * user_vault_keys / org_keys, already wrapped by Phase 4.1 owner
--     policies
--   * vault_security_events / audit_logs, read-paths only matter here
--   * capabilities / role_definitions / role_capabilities, writes
--     happen via migration, not runtime
--   * rate_limit_events, exchange_rates, org_primary_currency_history,
--     fx_revaluation_runs, metadata / rate stores, no per-feature
--     owner
--
-- Safety: every DROP POLICY is IF EXISTS. The new policies have
-- distinct names so we don't collide with the pre-Phase-4.2 role-rank
-- helper policies (current_user_org_rank(...) <= N), those remain
-- dropped below for clarity. The capability path supersedes them.
--
-- Membership guardrail: every mutating policy retains an implicit
-- membership check because user_has_capability() only returns TRUE for
-- active (non-revoked, non-expired) grants inside the org_id param
-- users without any grant in the target org return FALSE regardless of
-- the capability key. This means we don't have to double-gate with
-- `org_id IN (SELECT org_id FROM org_members ...)` in every policy.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- 1. transactions, transactions.write + write_own + delete
-- ══════════════════════════════════════════════════════════════════════
-- write_own covers the Bookkeeper pattern: can INSERT only if
-- created_by = auth.uid(). created_by is not part of the transactions
-- schema today; fall back to requiring plain transactions.write when
-- write_own is the user's only grant. The Admin UI can hint the
-- capability gap to the Owner.
--
-- Once a future migration adds transactions.created_by, the INSERT
-- policy can be tightened to:
--   user_has_capability(auth.uid(), 'transactions.write', org_id)
--   OR (user_has_capability(auth.uid(), 'transactions.write_own', org_id)
--       AND created_by = auth.uid())
-- For now we accept write_own as equivalent to write at the RLS layer
-- and let the UI enforce the "own rows only" constraint.

DROP POLICY IF EXISTS "tx_insert"  ON public.transactions;
DROP POLICY IF EXISTS "tx_update"  ON public.transactions;
DROP POLICY IF EXISTS "tx_delete"  ON public.transactions;

CREATE POLICY "tx_insert_cap"
  ON public.transactions
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_has_capability(auth.uid(), 'transactions.write', org_id)
    OR public.user_has_capability(auth.uid(), 'transactions.write_own', org_id)
  );

CREATE POLICY "tx_update_cap"
  ON public.transactions
  FOR UPDATE TO authenticated
  USING (
    public.user_has_capability(auth.uid(), 'transactions.write', org_id)
    OR public.user_has_capability(auth.uid(), 'transactions.write_own', org_id)
  )
  WITH CHECK (
    public.user_has_capability(auth.uid(), 'transactions.write', org_id)
    OR public.user_has_capability(auth.uid(), 'transactions.write_own', org_id)
  );

CREATE POLICY "tx_delete_cap"
  ON public.transactions
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'transactions.delete', org_id));

-- ══════════════════════════════════════════════════════════════════════
-- 2. transaction_metadata, transactions.write + delete
-- ══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "tx_metadata_via_membership" ON public.transaction_metadata;
DROP POLICY IF EXISTS "tx_meta_insert"             ON public.transaction_metadata;

CREATE POLICY "tx_meta_insert_cap"
  ON public.transaction_metadata
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_has_capability(auth.uid(), 'transactions.write', org_id)
    OR public.user_has_capability(auth.uid(), 'transactions.write_own', org_id)
  );

CREATE POLICY "tx_meta_update_cap"
  ON public.transaction_metadata
  FOR UPDATE TO authenticated
  USING (
    public.user_has_capability(auth.uid(), 'transactions.write', org_id)
    OR public.user_has_capability(auth.uid(), 'transactions.write_own', org_id)
  )
  WITH CHECK (
    public.user_has_capability(auth.uid(), 'transactions.write', org_id)
    OR public.user_has_capability(auth.uid(), 'transactions.write_own', org_id)
  );

CREATE POLICY "tx_meta_delete_cap"
  ON public.transaction_metadata
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'transactions.delete', org_id));

-- ══════════════════════════════════════════════════════════════════════
-- 3. journal_entries, journal_entries.write + delete
-- ══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "je_insert" ON public.journal_entries;
DROP POLICY IF EXISTS "je_update" ON public.journal_entries;
DROP POLICY IF EXISTS "je_delete" ON public.journal_entries;

CREATE POLICY "je_insert_cap"
  ON public.journal_entries
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_capability(auth.uid(), 'journal_entries.write', org_id));

CREATE POLICY "je_update_cap"
  ON public.journal_entries
  FOR UPDATE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'journal_entries.write', org_id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'journal_entries.write', org_id));

CREATE POLICY "je_delete_cap"
  ON public.journal_entries
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'journal_entries.delete', org_id));

-- ══════════════════════════════════════════════════════════════════════
-- 4. journal_entry_lines, join to journal_entries.org_id
-- ══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "jel_insert" ON public.journal_entry_lines;
DROP POLICY IF EXISTS "jel_update" ON public.journal_entry_lines;
DROP POLICY IF EXISTS "jel_delete" ON public.journal_entry_lines;

CREATE POLICY "jel_insert_cap"
  ON public.journal_entry_lines
  FOR INSERT TO authenticated
  WITH CHECK (
    journal_entry_id IN (
      SELECT id FROM public.journal_entries
       WHERE public.user_has_capability(auth.uid(), 'journal_entries.write', org_id)
    )
  );

CREATE POLICY "jel_update_cap"
  ON public.journal_entry_lines
  FOR UPDATE TO authenticated
  USING (
    journal_entry_id IN (
      SELECT id FROM public.journal_entries
       WHERE public.user_has_capability(auth.uid(), 'journal_entries.write', org_id)
    )
  )
  WITH CHECK (
    journal_entry_id IN (
      SELECT id FROM public.journal_entries
       WHERE public.user_has_capability(auth.uid(), 'journal_entries.write', org_id)
    )
  );

CREATE POLICY "jel_delete_cap"
  ON public.journal_entry_lines
  FOR DELETE TO authenticated
  USING (
    journal_entry_id IN (
      SELECT id FROM public.journal_entries
       WHERE public.user_has_capability(auth.uid(), 'journal_entries.delete', org_id)
    )
  );

-- ══════════════════════════════════════════════════════════════════════
-- 5. account_metadata, accounts.write + delete
-- ══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "account_metadata_via_membership" ON public.account_metadata;
DROP POLICY IF EXISTS "acct_meta_insert"                ON public.account_metadata;

CREATE POLICY "acct_meta_insert_cap"
  ON public.account_metadata
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_capability(auth.uid(), 'accounts.write', org_id));

CREATE POLICY "acct_meta_update_cap"
  ON public.account_metadata
  FOR UPDATE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'accounts.write', org_id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'accounts.write', org_id));

CREATE POLICY "acct_meta_delete_cap"
  ON public.account_metadata
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'accounts.delete', org_id));

-- ══════════════════════════════════════════════════════════════════════
-- 6. legacy_account_map, accounts.write + delete
-- ══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "legacy_account_map_insert" ON public.legacy_account_map;
DROP POLICY IF EXISTS "legacy_account_map_update" ON public.legacy_account_map;
DROP POLICY IF EXISTS "legacy_account_map_delete" ON public.legacy_account_map;

CREATE POLICY "legacy_account_map_insert_cap"
  ON public.legacy_account_map
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_capability(auth.uid(), 'accounts.write', org_id));

CREATE POLICY "legacy_account_map_update_cap"
  ON public.legacy_account_map
  FOR UPDATE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'accounts.write', org_id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'accounts.write', org_id));

CREATE POLICY "legacy_account_map_delete_cap"
  ON public.legacy_account_map
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'accounts.delete', org_id));

-- ══════════════════════════════════════════════════════════════════════
-- 7. contacts, contacts.write + delete
-- ══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "contacts_insert" ON public.contacts;
DROP POLICY IF EXISTS "contacts_update" ON public.contacts;
DROP POLICY IF EXISTS "contacts_delete" ON public.contacts;

CREATE POLICY "contacts_insert_cap"
  ON public.contacts
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_capability(auth.uid(), 'contacts.write', org_id));

CREATE POLICY "contacts_update_cap"
  ON public.contacts
  FOR UPDATE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'contacts.write', org_id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'contacts.write', org_id));

CREATE POLICY "contacts_delete_cap"
  ON public.contacts
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'contacts.delete', org_id));

-- ══════════════════════════════════════════════════════════════════════
-- 8. payment_requests, payments.create + approve + pay
-- ══════════════════════════════════════════════════════════════════════
-- INSERT requires payments.create. UPDATE is kept permissive for any
-- payments.approve OR payments.pay OR payments.create grant, the
-- status-transition workflow (PENDING → APPROVED → PAID) is enforced
-- at the application layer (Phase 4.4 adds mutation-signature verification
-- on status changes). DELETE requires payments.create plus the
-- implicit membership via user_has_capability.

DROP POLICY IF EXISTS "payment_requests_insert" ON public.payment_requests;
DROP POLICY IF EXISTS "payment_requests_update" ON public.payment_requests;
DROP POLICY IF EXISTS "payment_requests_delete" ON public.payment_requests;
DROP POLICY IF EXISTS "Users can manage payment requests for their org" ON public.payment_requests;

CREATE POLICY "payment_requests_insert_cap"
  ON public.payment_requests
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_capability(auth.uid(), 'payments.create', org_id));

CREATE POLICY "payment_requests_update_cap"
  ON public.payment_requests
  FOR UPDATE TO authenticated
  USING (
    public.user_has_capability(auth.uid(), 'payments.approve', org_id)
    OR public.user_has_capability(auth.uid(), 'payments.pay', org_id)
    OR public.user_has_capability(auth.uid(), 'payments.create', org_id)
  )
  WITH CHECK (
    public.user_has_capability(auth.uid(), 'payments.approve', org_id)
    OR public.user_has_capability(auth.uid(), 'payments.pay', org_id)
    OR public.user_has_capability(auth.uid(), 'payments.create', org_id)
  );

CREATE POLICY "payment_requests_delete_cap"
  ON public.payment_requests
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'payments.create', org_id));

-- ══════════════════════════════════════════════════════════════════════
-- 9. accounts, transactions.write (accounts carry entries)
-- ══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "accounts_via_membership" ON public.accounts;
DROP POLICY IF EXISTS "accounts_insert"         ON public.accounts;
DROP POLICY IF EXISTS "accounts_update"         ON public.accounts;
DROP POLICY IF EXISTS "accounts_delete"         ON public.accounts;

CREATE POLICY "accounts_insert_cap"
  ON public.accounts
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_capability(auth.uid(), 'transactions.write', org_id));

CREATE POLICY "accounts_update_cap"
  ON public.accounts
  FOR UPDATE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'transactions.write', org_id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'transactions.write', org_id));

CREATE POLICY "accounts_delete_cap"
  ON public.accounts
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'transactions.delete', org_id));

-- ══════════════════════════════════════════════════════════════════════
-- 10. connectors, connectors.write
-- ══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "connectors_insert"                  ON public.connectors;
DROP POLICY IF EXISTS "connectors_update"                  ON public.connectors;
DROP POLICY IF EXISTS "connectors_delete"                  ON public.connectors;
DROP POLICY IF EXISTS "Users can insert own org connectors" ON public.connectors;
DROP POLICY IF EXISTS "Users can update own org connectors" ON public.connectors;
DROP POLICY IF EXISTS "Users can delete own org connectors" ON public.connectors;

CREATE POLICY "connectors_insert_cap"
  ON public.connectors
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_capability(auth.uid(), 'connectors.write', org_id));

CREATE POLICY "connectors_update_cap"
  ON public.connectors
  FOR UPDATE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'connectors.write', org_id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'connectors.write', org_id));

CREATE POLICY "connectors_delete_cap"
  ON public.connectors
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'connectors.write', org_id));

-- ══════════════════════════════════════════════════════════════════════
-- 11. organizations, org.manage
-- ══════════════════════════════════════════════════════════════════════
-- Previous policy gated UPDATE/DELETE by rank 1 or by admin membership.
-- Capability equivalent: org.manage for both.

DROP POLICY IF EXISTS "org_update"                 ON public.organizations;
DROP POLICY IF EXISTS "organizations_delete_admin" ON public.organizations;

CREATE POLICY "org_update_cap"
  ON public.organizations
  FOR UPDATE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'org.manage', id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'org.manage', id));

CREATE POLICY "org_delete_cap"
  ON public.organizations
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'org.manage', id));

-- ══════════════════════════════════════════════════════════════════════
-- 12. org_settings, org.manage
-- ══════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "settings_via_membership"   ON public.org_settings;
DROP POLICY IF EXISTS "settings_insert"           ON public.org_settings;
DROP POLICY IF EXISTS "settings_update"           ON public.org_settings;
DROP POLICY IF EXISTS "org_settings_insert"       ON public.org_settings;
DROP POLICY IF EXISTS "org_settings_update"       ON public.org_settings;
DROP POLICY IF EXISTS "org_settings_delete_admin" ON public.org_settings;

CREATE POLICY "org_settings_insert_cap"
  ON public.org_settings
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_capability(auth.uid(), 'org.manage', org_id));

CREATE POLICY "org_settings_update_cap"
  ON public.org_settings
  FOR UPDATE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'org.manage', org_id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'org.manage', org_id));

CREATE POLICY "org_settings_delete_cap"
  ON public.org_settings
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'org.manage', org_id));

-- ══════════════════════════════════════════════════════════════════════
-- 13. attachments, transactions.write
-- ══════════════════════════════════════════════════════════════════════
-- attachments has a membership-based FOR ALL policy. Split it into
-- SELECT (membership, anyone who can read the row can see the link)
-- and write policies keyed on transactions.write. attachments.org_id
-- is the discriminator.

DROP POLICY IF EXISTS "Users can manage attachments in their org" ON public.attachments;

CREATE POLICY "attachments_select_cap"
  ON public.attachments
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

CREATE POLICY "attachments_insert_cap"
  ON public.attachments
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_has_capability(auth.uid(), 'transactions.write', org_id)
    OR public.user_has_capability(auth.uid(), 'transactions.write_own', org_id)
  );

CREATE POLICY "attachments_update_cap"
  ON public.attachments
  FOR UPDATE TO authenticated
  USING (
    public.user_has_capability(auth.uid(), 'transactions.write', org_id)
    OR public.user_has_capability(auth.uid(), 'transactions.write_own', org_id)
  )
  WITH CHECK (
    public.user_has_capability(auth.uid(), 'transactions.write', org_id)
    OR public.user_has_capability(auth.uid(), 'transactions.write_own', org_id)
  );

CREATE POLICY "attachments_delete_cap"
  ON public.attachments
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'transactions.delete', org_id));

-- ══════════════════════════════════════════════════════════════════════
-- 14. role_definitions / role_capabilities, roles.manage
-- ══════════════════════════════════════════════════════════════════════
-- Lets Advanced+ tier customers clone presets and edit capability
-- bundles via the Admin UI. System presets (is_system = TRUE,
-- org_id IS NULL) stay read-only, the policy explicitly blocks
-- INSERTs/UPDATEs/DELETEs on rows where is_system = TRUE.

CREATE POLICY "role_definitions_insert_cap"
  ON public.role_definitions
  FOR INSERT TO authenticated
  WITH CHECK (
    is_system = FALSE
    AND org_id IS NOT NULL
    AND public.user_has_capability(auth.uid(), 'roles.manage', org_id)
  );

CREATE POLICY "role_definitions_update_cap"
  ON public.role_definitions
  FOR UPDATE TO authenticated
  USING (
    is_system = FALSE
    AND org_id IS NOT NULL
    AND public.user_has_capability(auth.uid(), 'roles.manage', org_id)
  )
  WITH CHECK (
    is_system = FALSE
    AND org_id IS NOT NULL
    AND public.user_has_capability(auth.uid(), 'roles.manage', org_id)
  );

CREATE POLICY "role_definitions_delete_cap"
  ON public.role_definitions
  FOR DELETE TO authenticated
  USING (
    is_system = FALSE
    AND org_id IS NOT NULL
    AND public.user_has_capability(auth.uid(), 'roles.manage', org_id)
  );

CREATE POLICY "role_capabilities_insert_cap"
  ON public.role_capabilities
  FOR INSERT TO authenticated
  WITH CHECK (
    role_id IN (
      SELECT id FROM public.role_definitions
       WHERE is_system = FALSE
         AND org_id IS NOT NULL
         AND public.user_has_capability(auth.uid(), 'roles.manage', org_id)
    )
  );

CREATE POLICY "role_capabilities_delete_cap"
  ON public.role_capabilities
  FOR DELETE TO authenticated
  USING (
    role_id IN (
      SELECT id FROM public.role_definitions
       WHERE is_system = FALSE
         AND org_id IS NOT NULL
         AND public.user_has_capability(auth.uid(), 'roles.manage', org_id)
    )
  );

-- ══════════════════════════════════════════════════════════════════════
-- 15. org_member_roles, users.manage_roles
-- ══════════════════════════════════════════════════════════════════════
-- Separate from roles.manage so Enterprise can grant "manage_roles" to
-- senior Accountants without unlocking the custom-role editor.

CREATE POLICY "org_member_roles_insert_cap"
  ON public.org_member_roles
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_capability(auth.uid(), 'users.manage_roles', org_id));

CREATE POLICY "org_member_roles_update_cap"
  ON public.org_member_roles
  FOR UPDATE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'users.manage_roles', org_id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'users.manage_roles', org_id));

CREATE POLICY "org_member_roles_delete_cap"
  ON public.org_member_roles
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'users.manage_roles', org_id));

-- Extra SELECT policy so anyone with users.manage_roles can see all the
-- role grants in their org (for the Admin UI's user-role assignment
-- list). The 4.1 policy still covers each user seeing their own grants.
CREATE POLICY "org_member_roles_select_manage"
  ON public.org_member_roles
  FOR SELECT TO authenticated
  USING (public.user_has_capability(auth.uid(), 'users.manage_roles', org_id));

-- ══════════════════════════════════════════════════════════════════════
-- 16. D9 ENFORCEMENT, last-active-role removal trigger
-- ══════════════════════════════════════════════════════════════════════
--
-- When the last active org_member_roles row for a (user, org) pair
-- transitions to revoked (either via UPDATE SET revoked_at = now() or
-- DELETE), fire a side-effect:
--   1. DELETE the user's org_keys wrap for that org
--   2. Insert a vault_security_events row (event = 'org_access_revoked')
--
-- Trigger is implemented as AFTER UPDATE + AFTER DELETE on
-- org_member_roles. SECURITY DEFINER so it can touch org_keys +
-- vault_security_events regardless of who the acting user is. The
-- "is this their last active grant?" check runs inside the function.

CREATE OR REPLACE FUNCTION public.enforce_last_role_removal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_active_count INTEGER;
  v_user_id      UUID;
  v_org_id       UUID;
BEGIN
  -- Identify the affected user + org from the row being changed.
  -- For DELETE we read OLD; for UPDATE we read OLD (revoked row was OLD
  -- active, NEW revoked) and also check NEW to confirm this is a
  -- revocation event (OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL).
  IF TG_OP = 'DELETE' THEN
    v_user_id := OLD.user_id;
    v_org_id  := OLD.org_id;
  ELSIF TG_OP = 'UPDATE' THEN
    -- Only fire on the active → revoked transition. Flipping revoked_at
    -- back to NULL (re-admit path) does not trigger this logic.
    IF OLD.revoked_at IS NOT NULL OR NEW.revoked_at IS NULL THEN
      RETURN NULL;
    END IF;
    v_user_id := NEW.user_id;
    v_org_id  := NEW.org_id;
  ELSE
    RETURN NULL;
  END IF;

  -- Count remaining active grants for this (user, org). We've already
  -- DELETEd or flipped the current row at this point (AFTER trigger).
  SELECT COUNT(*) INTO v_active_count
    FROM public.org_member_roles
   WHERE user_id = v_user_id
     AND org_id  = v_org_id
     AND revoked_at IS NULL
     AND (expires_at IS NULL OR expires_at > now());

  IF v_active_count = 0 THEN
    -- Drop the org_keys wrap for this user+org. The user retains their
    -- auth account, but cannot unlock this org's DEK anymore.
    DELETE FROM public.org_keys
     WHERE user_id = v_user_id
       AND org_id  = v_org_id;

    -- Write a security event. Scoped to the *removed user* (user_id
    -- column on vault_security_events) so it appears in their own
    -- security audit trail when they next log in; the metadata JSON
    -- carries the org_id + removal trigger.
    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (
      v_user_id,
      'org_access_revoked',
      jsonb_build_object(
        'org_id',   v_org_id,
        'trigger',  TG_OP,
        'reason',   'last_active_role_removed'
      )
    );
  END IF;

  RETURN NULL;
END;
$$;

COMMENT ON FUNCTION public.enforce_last_role_removal() IS
  'On last-active-role removal for a (user, org), drop the '
  'org_keys wrap and audit the event. Fires AFTER UPDATE (revocation) '
  'and AFTER DELETE on org_member_roles. SECURITY DEFINER to cross '
  'policy boundaries.';

DROP TRIGGER IF EXISTS trg_enforce_last_role_removal_update ON public.org_member_roles;
CREATE TRIGGER trg_enforce_last_role_removal_update
  AFTER UPDATE OF revoked_at ON public.org_member_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_last_role_removal();

DROP TRIGGER IF EXISTS trg_enforce_last_role_removal_delete ON public.org_member_roles;
CREATE TRIGGER trg_enforce_last_role_removal_delete
  AFTER DELETE ON public.org_member_roles
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_last_role_removal();

COMMIT;
