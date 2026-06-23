-- ============================================================
-- transactions.contact_id, customer / vendor / employee FK
-- ============================================================
-- Adds the FK that lets the Edit Transaction modal track WHO the
-- transaction was with (customer, vendor, employee, other) as a
-- separate concept from WHAT chart-of-accounts bucket it belongs
-- to. Adds a typed link column for contact_id.
--
-- Until this column existed, the modal conflated the two: the
-- right-side TO/FROM dropdown and the ACCOUNT dropdown were both
-- bound to the chart-account state, so an OR-imported tx assigned
-- to "Uncategorized Revenue" appeared to also have "Uncategorized
-- Revenue" as its counterparty. Decoupling lands in the same PR
-- as this migration.
--
-- ZK posture: contact_id is plaintext UUID, consistent with
-- account_id and account_id. Server learns "tx X was with contact Y"
-- but Y carries no business semantics, name + email + address all
-- stay encrypted on contacts.
--
-- Existing rows stay NULL. The Phase 5 import bridge does NOT
-- populate contact_id today (no reliable counterparty source from
-- Blink yet); the user fills it in from the modal as needed.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_contact
  ON public.transactions(contact_id)
  WHERE contact_id IS NOT NULL;

COMMENT ON COLUMN public.transactions.contact_id IS
  'Customer / vendor / employee the transaction was with. NULL for '
  'rows with no contact assigned (legacy + most OR imports). '
  'Independent of account_id (which buckets the tx in the chart of '
  'accounts).';
