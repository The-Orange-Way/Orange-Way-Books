-- Phase 1 (external-ledger removal redesign), Migration 1/9: Drop the old accounting tables.
--
-- Migration plan tracked in commit history.
--
-- A full DB reset was authorized on both DEV and PROD before any production customers.
-- The existing accounting tables (`journal_entries`, `journal_entry_lines`, `legacy_account_map`,
-- `je_ref_sequence`) are dropped CASCADE so dependent triggers, RLS policies, indexes,
-- and foreign keys from other tables are torn down with them. The next 8 migrations
-- rebuild them in the locked end-state shape:
--   - `chart_of_accounts` (replaces `legacy_account_map`), fully encrypted structural metadata
--   - `journal_entries`, plaintext status + source_type, encrypted everything else
--   - `journal_entry_lines`, no $1 placeholder debit/credit columns; encrypted-only amounts
--   - Immutability trigger pair using JSONB diff (works on encrypted columns)
--   - Partial UNIQUE on reversal_of_id to forbid double-reversal
--   - RLS via capability system (user_has_capability)
--   - next_je_ref_number + purge_import_job_artifacts adjusted to new schema
--
-- This migration is idempotent: re-running it after the rebuild migrations
-- have applied would silently no-op (IF EXISTS guard), but we don't expect
-- to re-run. The full-reset workflow drops `public` and applies all migrations
-- from scratch.

-- Drop CASCADE. Note: this also drops:
--   - RLS policies attached to these tables (je_select, je_insert_cap,
--     je_update_cap, je_delete_cap, jel_*, legacy_account_map_*)
--   - Triggers on these tables (trg_legacy_account_parent_same_org)
--   - Indexes on these tables (idx_journal_entries_*, idx_jel_*, idx_legacy_account_map_*)
--   - FKs from OTHER tables pointing in (fx_revaluation_runs.je_id +
--     reverse_je_id ON DELETE SET NULL; transaction.legacy_*_id; etc.)
--     The remote-side columns survive as plain UUIDs without FK constraints.
DROP TABLE IF EXISTS public.journal_entry_lines CASCADE;
DROP TABLE IF EXISTS public.journal_entries     CASCADE;
DROP TABLE IF EXISTS public.legacy_account_map    CASCADE;
DROP TABLE IF EXISTS public.je_ref_sequence     CASCADE;

-- Trigger functions that referenced these tables are now technically invalid
-- but stay in the catalog. We DROP them explicitly so the migration order
-- is unambiguous; the new migrations CREATE OR REPLACE them with the
-- correct schema references.
DROP FUNCTION IF EXISTS public.check_legacy_account_parent_same_org() CASCADE;
DROP FUNCTION IF EXISTS public.next_je_ref_number(UUID, SMALLINT)    CASCADE;
DROP FUNCTION IF EXISTS public.purge_import_job_artifacts(UUID)      CASCADE;

-- check_audit_log_entity_same_org() also referenced journal_entries and
-- legacy_account_map. We rewrite it in migration 9/9 to use chart_of_accounts.
-- Until then, the trigger on audit_logs is left in place; calls to it will
-- find journal_entries missing and fall through to the "row might have been
-- deleted between write and audit insert" defensive branch (returns NEW).
-- That's a tolerable transient, the rebuild migrations land in the same
-- deploy and immediately restore the table.
