-- Invoicing — invoice_payments junction
--
-- Links an invoice to the wallet transaction(s) that pay it. Supports:
--   • Partial payments (one invoice, multiple transactions)
--   • Lump-sum payments (one transaction, multiple invoices via split)
--   • The Wave-style "Merge" pattern (placeholder + bank import → one row)
--
-- Each row records "Transaction T applied X amount toward Invoice I at time
-- A by user U." The invoice's balance = SUM(invoice.amount) − SUM(applied
-- payments). When SUM applied = invoice.amount → status flips to PAID via
-- a status-recalc helper. Until then it sits at PARTIAL.
--
-- Idempotency: a UNIQUE (invoice_id, transaction_id) constraint prevents
-- double-application of the same transaction toward the same invoice. If a
-- user wants to apply the same transaction to the same invoice in two
-- portions, that's still one invoice_payments row with the combined
-- amount, not two — the natural model.

CREATE TABLE IF NOT EXISTS public.invoice_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,

  -- Plaintext amount for filter/sort. The canonical encrypted value is in
  -- encrypted_amount_applied so the server doesn't see the exact split.
  amount_applied NUMERIC NOT NULL DEFAULT 0,
  encrypted_amount_applied TEXT NULL,

  -- The deposit can settle multiple invoices for different currencies if
  -- conversion happened off-platform; we record the conversion rate used.
  -- Plaintext for filter/sort.
  applied_rate NUMERIC NULL,
  applied_rate_currency TEXT NULL,

  -- Who applied this payment + when
  applied_by UUID NULL REFERENCES auth.users(id),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Audit notes (optional, encrypted)
  encrypted_notes TEXT NULL,

  key_version INT NOT NULL DEFAULT 2,

  -- Idempotency: one row per (invoice, transaction) pair
  CONSTRAINT invoice_payments_invoice_txn_unique
    UNIQUE (invoice_id, transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_invoice
  ON public.invoice_payments (invoice_id, applied_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_payments_transaction
  ON public.invoice_payments (transaction_id, applied_at DESC);

ALTER TABLE public.invoice_payments ENABLE ROW LEVEL SECURITY;

-- All access scoped via the parent invoice's org membership
CREATE POLICY "invoice_payments_select" ON public.invoice_payments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.invoices i
        JOIN public.org_members om ON om.org_id = i.org_id
       WHERE i.id = invoice_payments.invoice_id
         AND om.user_id = auth.uid()
    )
  );

CREATE POLICY "invoice_payments_insert" ON public.invoice_payments
  FOR INSERT TO authenticated
  WITH CHECK (
    applied_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.invoices i
        JOIN public.org_members om ON om.org_id = i.org_id
       WHERE i.id = invoice_payments.invoice_id
         AND om.user_id = auth.uid()
    )
  );

CREATE POLICY "invoice_payments_update" ON public.invoice_payments
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.invoices i
        JOIN public.org_members om ON om.org_id = i.org_id
       WHERE i.id = invoice_payments.invoice_id
         AND om.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.invoices i
        JOIN public.org_members om ON om.org_id = i.org_id
       WHERE i.id = invoice_payments.invoice_id
         AND om.user_id = auth.uid()
    )
  );

CREATE POLICY "invoice_payments_delete" ON public.invoice_payments
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.invoices i
        JOIN public.org_members om ON om.org_id = i.org_id
       WHERE i.id = invoice_payments.invoice_id
         AND om.user_id = auth.uid()
    )
  );

COMMENT ON TABLE public.invoice_payments IS
  'Junction linking invoices to the wallet transactions that pay them. Idempotency: one row per (invoice, transaction).';
