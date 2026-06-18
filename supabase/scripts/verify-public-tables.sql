-- Orange Way Books — verify all expected `public` app tables exist on Supabase.
-- Run in Supabase → SQL Editor (any role that can read information_schema).
--
-- Two named tiers:
--   app_tables  — the core OWB application schema (org, wallets, ledger, etc.)
--   infra_tables — supporting infrastructure (billing, key rotation, signing-key wraps,
--                  sync events from OR, support session storage, etc.). These
--                  are also intentional public tables; they just don't carry
--                  customer ledger data directly.
--
-- A table missing from BOTH tiers shows up in the "extras" output at the
-- bottom. That should be empty in a healthy schema.

WITH app_tables(name) AS (
  VALUES
    ('organizations'),
    ('org_members'),
    ('org_settings'),
    ('org_member_roles'),
    ('account_metadata'),
    ('chart_of_accounts'),
    ('wallets'),
    ('transaction_metadata'),
    ('contacts'),
    ('journal_entries'),
    ('journal_entry_lines'),
    ('transactions'),
    ('payment_requests'),
    ('payment_request_line_items'),
    ('invoices'),
    ('invoice_line_items'),
    ('connectors'),
    ('exchange_rates'),
    ('attachments'),
    ('audit_logs'),
    ('org_keys')
),
infra_tables(name) AS (
  VALUES
    ('active_key_versions'),
    ('billing_accounts'),
    ('billing_subscriptions'),
    ('flash_payment_events'),
    ('flash_payment_links'),
    ('flash_payments'),
    ('fx_revaluation_runs'),
    ('import_jobs'),
    ('je_ref_sequence'),
    ('key_rotation_jobs'),
    ('org_master_wraps'),
    ('org_member_signing_key_wraps'),
    ('org_period_closes'),
    ('org_primary_currency_history'),
    ('org_signing_keys'),
    ('pending_invitations'),
    ('period_unlock_sessions'),
    ('rate_limit_events'),
    ('role_assignments'),
    ('subscription_events'),
    ('support_sessions'),
    ('sync_events'),
    ('user_master_recovery'),
    ('user_profiles'),
    ('vault_security_events')
),
actual AS (
  SELECT table_name AS name
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_type = 'BASE TABLE'
)
SELECT
  e.name AS table_name,
  e.tier,
  CASE WHEN a.name IS NULL THEN 'MISSING' ELSE 'OK' END AS status
FROM (
  SELECT name, 'app' AS tier FROM app_tables
  UNION ALL
  SELECT name, 'infra' AS tier FROM infra_tables
) e
LEFT JOIN actual a ON a.name = e.name
ORDER BY status DESC, tier, e.name;

-- Public tables not in either tier — should be empty on a clean schema.
WITH expected(name) AS (
  VALUES
    ('organizations'), ('org_members'), ('org_settings'), ('org_member_roles'),
    ('account_metadata'), ('chart_of_accounts'),
    ('wallets'), ('transaction_metadata'), ('contacts'),
    ('journal_entries'), ('journal_entry_lines'), ('transactions'),
    ('payment_requests'), ('payment_request_line_items'),
    ('invoices'), ('invoice_line_items'),
    ('connectors'), ('exchange_rates'),
    ('attachments'), ('audit_logs'), ('org_keys'),
    ('active_key_versions'), ('billing_accounts'), ('billing_subscriptions'),
    ('flash_payment_events'), ('flash_payment_links'), ('flash_payments'),
    ('fx_revaluation_runs'), ('import_jobs'), ('je_ref_sequence'),
    ('key_rotation_jobs'), ('org_master_wraps'), ('org_member_signing_key_wraps'),
    ('org_period_closes'), ('org_primary_currency_history'),
    ('org_signing_keys'), ('pending_invitations'), ('period_unlock_sessions'),
    ('rate_limit_events'), ('role_assignments'), ('subscription_events'),
    ('support_sessions'), ('sync_events'),
    ('user_master_recovery'), ('user_profiles'), ('vault_security_events')
)
SELECT t.table_name AS extra_public_table
FROM information_schema.tables t
WHERE t.table_schema = 'public'
  AND t.table_type = 'BASE TABLE'
  AND NOT EXISTS (SELECT 1 FROM expected e WHERE e.name = t.table_name)
ORDER BY 1;
