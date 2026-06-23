-- Phase 1, Migration 8/9: Repair foreign keys from OTHER tables that pointed
-- at the dropped journal_entries / legacy_account_map.
--
-- When migration 1/9 dropped those tables CASCADE, FKs from sibling tables
-- were dropped silently, the columns survived but lost their constraints.
-- This migration re-adds the FKs against the new schema.
--
-- Tables affected (best effort, verified during enumeration):
--   - fx_revaluation_runs.je_id          → journal_entries(id) ON DELETE SET NULL
--   - fx_revaluation_runs.reverse_je_id  → journal_entries(id) ON DELETE SET NULL
--   - import_jobs (if any FK to journal_entries; the relationship is the other
--     direction, journal_entries.import_job_id → import_jobs(id), already
--     re-added in migration 3/9)
--   - transactions.*, the old transactions table referenced legacy_account_id
--     and legacy_transaction_id; those become orphan UUID columns. Phase 2's
--     client refactor will null them out + a future migration can drop them.
--   - attachments.journal_entry_id (if present from 20260522010000) → journal_entries(id)
--   - invoices / payment_requests reference journal_entries via posting flows.

DO $$
BEGIN
  -- fx_revaluation_runs.je_id
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='fx_revaluation_runs' AND column_name='je_id') THEN
    BEGIN
      ALTER TABLE public.fx_revaluation_runs
        ADD CONSTRAINT fx_revaluation_runs_je_id_fkey
        FOREIGN KEY (je_id) REFERENCES public.journal_entries(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;

  -- fx_revaluation_runs.reverse_je_id
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='fx_revaluation_runs' AND column_name='reverse_je_id') THEN
    BEGIN
      ALTER TABLE public.fx_revaluation_runs
        ADD CONSTRAINT fx_revaluation_runs_reverse_je_id_fkey
        FOREIGN KEY (reverse_je_id) REFERENCES public.journal_entries(id) ON DELETE SET NULL;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;

  -- attachments.journal_entry_id (added by 20260522010000)
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema='public' AND table_name='attachments' AND column_name='journal_entry_id') THEN
    BEGIN
      ALTER TABLE public.attachments
        ADD CONSTRAINT attachments_journal_entry_id_fkey
        FOREIGN KEY (journal_entry_id) REFERENCES public.journal_entries(id) ON DELETE CASCADE;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END $$;

-- The old transactions.legacy_transaction_id, transactions.legacy_account_id (and similar
-- "legacy_*_id" columns on other tables) are no longer constrained by FK since
-- legacy_account_map is gone. They become orphan plaintext UUID columns. Phase 2
-- nulls them out + a future cleanup migration can drop them entirely.

COMMENT ON CONSTRAINT fx_revaluation_runs_je_id_fkey ON public.fx_revaluation_runs IS
  'Re-added after Phase 1 redesign dropped public.journal_entries CASCADE.';
