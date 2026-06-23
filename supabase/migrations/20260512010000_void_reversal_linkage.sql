-- Track 2 T3 v1, void via reversing JE
--
-- Adds the link a reversing journal_entries row uses to point back at the
-- original it nets to zero. The original transactions row's status field is
-- flipped to 'VOID' (encrypted) by the OWB client; this column gives reports
-- and the audit log a way to walk from a void row back to the source event.
--
-- T3.a Option B locked 2026-05-12: until legacy-server-minimal exposes the
-- transactionVoid GraphQL mutation, OWB voids by writing a reversing JE in
-- the current period rather than calling the legacy ledger backend direction-flip primitive
-- directly. The reversing JE ships its own legacy ledger backend postings (debit/credit
-- swapped from the original's templates), so legacy ledger backend holds both rows summing
-- to zero. When the direction-flip primitive lands in a later legacy ledger backend minimal-
-- server release, the OWB void path can branch to that shorter form.
--

ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS reversal_of_id UUID NULL
    REFERENCES public.journal_entries(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_journal_entries_reversal_of_id
  ON public.journal_entries (reversal_of_id);

COMMENT ON COLUMN public.journal_entries.reversal_of_id IS
  'When this JE was created to void a prior JE (source_type=VOID_REVERSAL), this points at the JE it reverses. NULL for original JEs.';
