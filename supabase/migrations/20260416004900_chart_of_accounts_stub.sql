-- Stub migration: re-create the (empty) chart_of_accounts table.
--
-- WHY THIS EXISTS
--
-- The chart_of_accounts table was originally created via a UI table
-- editor before the migrations folder was the source of truth. No migration
-- file in this folder ever ran CREATE TABLE chart_of_accounts, so a fresh
-- Supabase project does not have it.
--
-- The very next migration (20260416005000_c2-account-consolidation.sql) then
-- copies rows out of chart_of_accounts into legacy_account_map and drops the
-- table. That migration ran fine on the original database (where the table
-- existed). On a fresh Supabase project it fails on the first SELECT FROM
-- chart_of_accounts.
--
-- This file creates an empty chart_of_accounts table with the column shape
-- expected by the consolidation migration's SELECT statement. On fresh
-- projects, the consolidation then copies zero rows (no-op) and drops the
-- empty stub at the end. On the original database this migration
-- has no effect because supabase_migrations.schema_migrations was backfilled
-- with the original (pre-migrations) state, but if anyone ever does re-apply
-- the full chain elsewhere, the CREATE TABLE IF NOT EXISTS is a safe guard.

CREATE TABLE IF NOT EXISTS public.chart_of_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL,
  code          TEXT,
  name          TEXT,
  account_type  TEXT,
  account_group TEXT,
  is_archived   BOOLEAN DEFAULT false
);
