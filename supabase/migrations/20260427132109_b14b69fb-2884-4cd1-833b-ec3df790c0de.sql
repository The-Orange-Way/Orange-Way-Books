ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_contact
  ON public.transactions(contact_id)
  WHERE contact_id IS NOT NULL;

COMMENT ON COLUMN public.transactions.contact_id IS
  'Customer / vendor / employee the transaction was with. NULL for rows with no contact assigned (legacy + most OR imports). Independent of account_id (which buckets the tx in the chart of accounts).';