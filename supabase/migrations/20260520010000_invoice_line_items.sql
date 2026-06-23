-- Invoicing, invoice_line_items table
--
-- One row per invoice line. Mirrors payment_request_line_items.
-- Per-line GL routing via legacy_account_map_id so the issued invoice posts
-- revenue to the right income account (Sales Revenue, Service Revenue,
-- Interest Income, etc.).
--
-- ZKA: description + amount encrypted; legacy_account_map_id, sort_order
-- plaintext (non-sensitive routing metadata).

CREATE TABLE IF NOT EXISTS public.invoice_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  sort_order INT NOT NULL DEFAULT 0,

  -- ZKA-encrypted line content
  encrypted_description TEXT NULL,
  encrypted_amount TEXT NULL,
  encrypted_quantity TEXT NULL,    -- when present, displayed as qty × unit
  encrypted_unit_price TEXT NULL,

  -- Plaintext amount for sum/filter
  amount NUMERIC NOT NULL DEFAULT 0,

  -- Per-line GL routing (which income account this line books to)
  legacy_account_map_id UUID NULL REFERENCES public.legacy_account_map(id) ON DELETE SET NULL,

  key_version INT NOT NULL DEFAULT 2,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoice_line_items_invoice
  ON public.invoice_line_items (invoice_id, sort_order);

CREATE INDEX IF NOT EXISTS idx_invoice_line_items_account
  ON public.invoice_line_items (legacy_account_map_id)
  WHERE legacy_account_map_id IS NOT NULL;

ALTER TABLE public.invoice_line_items ENABLE ROW LEVEL SECURITY;

-- All access scoped via parent invoice's org membership
CREATE POLICY "invoice_line_items_select" ON public.invoice_line_items
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.invoices i
        JOIN public.org_members om ON om.org_id = i.org_id
       WHERE i.id = invoice_line_items.invoice_id
         AND om.user_id = auth.uid()
    )
  );

CREATE POLICY "invoice_line_items_insert" ON public.invoice_line_items
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.invoices i
        JOIN public.org_members om ON om.org_id = i.org_id
       WHERE i.id = invoice_line_items.invoice_id
         AND om.user_id = auth.uid()
    )
  );

CREATE POLICY "invoice_line_items_update" ON public.invoice_line_items
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.invoices i
        JOIN public.org_members om ON om.org_id = i.org_id
       WHERE i.id = invoice_line_items.invoice_id
         AND om.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.invoices i
        JOIN public.org_members om ON om.org_id = i.org_id
       WHERE i.id = invoice_line_items.invoice_id
         AND om.user_id = auth.uid()
    )
  );

CREATE POLICY "invoice_line_items_delete" ON public.invoice_line_items
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.invoices i
        JOIN public.org_members om ON om.org_id = i.org_id
       WHERE i.id = invoice_line_items.invoice_id
         AND om.user_id = auth.uid()
    )
  );

-- Extend attachments.entity_type to include invoice + invoice line items
ALTER TABLE public.attachments
  DROP CONSTRAINT IF EXISTS attachments_entity_type_check;

ALTER TABLE public.attachments
  ADD CONSTRAINT attachments_entity_type_check
  CHECK (entity_type IN (
    'transaction',
    'journal_entry',
    'payment_request',
    'payment_request_line_item',
    'invoice',
    'invoice_line_item'
  ));

COMMENT ON TABLE public.invoice_line_items IS
  'Line items for invoices. Mirrors payment_request_line_items. Per-line GL routing via legacy_account_map_id.';
