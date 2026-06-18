-- Track 2 T1 — split transaction write path support
--
-- Two additive columns:
--   transactions.journal_entry_id        - links a transaction to its parent journal entry.
--                                          Required for split + transfer modes where one
--                                          user-facing transaction maps to N+1 JE lines.
--                                          Nullable; standard-mode transactions stay NULL
--                                          (they post directly to legacy ledger backend without a wrapper JE).
--   journal_entry_lines.legacy_transaction_id  - threads each legacy ledger backend posting to its source
--                                              JE line. For split mode, N JE-line rows
--                                              each carry the UUID of the legacy ledger backend 2-entry
--                                              transaction that posted that leg.
--
-- Both nullable, no data backfill needed (no existing splits today).
-- RLS unchanged: existing journal_entries / transactions RLS covers both.
--

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS journal_entry_id UUID NULL
    REFERENCES public.journal_entries(id) ON DELETE SET NULL;

ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS legacy_transaction_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_journal_entry_id
  ON public.transactions (journal_entry_id);

CREATE INDEX IF NOT EXISTS idx_jel_legacy_transaction_id
  ON public.journal_entry_lines (legacy_transaction_id);

COMMENT ON COLUMN public.transactions.journal_entry_id IS
  'Links a transaction to its parent journal_entries row. Used by split + transfer modes. NULL for standard-mode transactions that post directly to legacy ledger backend without a JE wrapper.';

COMMENT ON COLUMN public.journal_entry_lines.legacy_transaction_id IS
  'legacy ledger backend transaction UUID for this line. Split-mode JE lines have one legacy ledger backend 2-entry transaction per leg; this column threads them back. NULL until the legacy ledger backend post succeeds.';
