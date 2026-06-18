-- ============================================================
-- M3 + M14 — Missing RLS indexes + drop dead tables
-- ============================================================
-- Findings from 2026-05-19 full audit.
--
-- M3 — Hot RLS columns lacked standalone (org_id) indexes. Existing
-- composite partial indexes don't cover plain `WHERE org_id = ?` scans
-- that RLS policies fire for every read. At current row counts this is
-- invisible; at scale dashboards crawl. Adding the indexes is cheap
-- and CONCURRENTLY-safe.
--
-- M14 — Three tables exist empty with zero code refs. Migration
-- 20260416005000_c2-account-consolidation.sql intended to drop them
-- but the DROP didn't take on every environment. Cleaning up.

BEGIN;

-- M3 — Indexes on hot RLS columns. IF NOT EXISTS makes this idempotent.
CREATE INDEX IF NOT EXISTS idx_accounts_org ON public.accounts(org_id);
CREATE INDEX IF NOT EXISTS idx_transactions_org ON public.transactions(org_id);
CREATE INDEX IF NOT EXISTS idx_journal_entries_org ON public.journal_entries(org_id);
CREATE INDEX IF NOT EXISTS idx_org_settings_org ON public.org_settings(org_id);
CREATE INDEX IF NOT EXISTS idx_legacy_account_map_org ON public.legacy_account_map(org_id);

-- M14 — Drop dead tables. CASCADE catches any leftover FKs / views.
-- All three are empty in dev cloud (verified 2026-05-19) and have
-- zero code references in src/ (grep'd).
DROP TABLE IF EXISTS public.chart_of_accounts CASCADE;
DROP TABLE IF EXISTS public.account_metadata CASCADE;
DROP TABLE IF EXISTS public.transaction_metadata CASCADE;

COMMIT;
