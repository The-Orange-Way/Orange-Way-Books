-- Revoke the default PUBLIC EXECUTE grant from every SECURITY DEFINER
-- function in the public schema. Postgres grants EXECUTE to PUBLIC when a
-- function is created; older migrations did not include an explicit REVOKE,
-- leaving 29 functions callable by any database role. The
-- security-definer-drift-check caught this on its first scheduled run
-- (2026-09-15) and is blocking the dev-to-prod promotion.
--
-- Four functions intentionally serve unauthenticated callers
-- (get_public_invoice, is_email_in_beta_allowlist, rate_limit_try,
-- record_public_invoice_view): only the blanket PUBLIC grant is removed for
-- those; the explicit anon grant is kept.
--
-- All other functions retain postgres, authenticated, and service_role.
-- Trigger-callable functions keep those same roles; narrowing to the trigger
-- mechanism only is a separate, auditable step.

-- ----------------------------------------------------------------
-- Trigger and internal helpers
-- ----------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.auto_insert_org_owner() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.auto_provision_billing_for_new_org() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_audit_log_entity_same_org() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_chart_of_accounts_parent_same_org() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_jel_account_same_org() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_linked_transfer_same_org() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enforce_last_role_removal() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.link_pending_invites_on_keypair_insert() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.sync_org_member_role() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.verify_mutation_signature_on_write() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.withdrawal_consents_block_mutation() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.withdrawal_consents_block_truncate() FROM PUBLIC;

-- ----------------------------------------------------------------
-- Authenticated-only RPCs
-- ----------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.advance_rotation_job(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.approve_payment_request(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_vault_unlock_rate_limit() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.current_user_org_rank(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.emit_self_notification(uuid, text, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.expire_time_boxed_roles() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_date_in_closed_period(uuid, uuid, date) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.log_billing_access(uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.next_invoice_number(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.owb_je_is_locked(uuid) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.purge_expired_old_key_wraps() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.reject_payment_request(uuid, text, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.user_has_capability(uuid, text, uuid) FROM PUBLIC;

-- ----------------------------------------------------------------
-- Public-facing RPCs: revoke blanket PUBLIC, keep explicit anon grant
-- ----------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.get_public_invoice(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.is_email_in_beta_allowlist(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.rate_limit_try(text, text, integer, integer) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.record_public_invoice_view(text) FROM PUBLIC;
