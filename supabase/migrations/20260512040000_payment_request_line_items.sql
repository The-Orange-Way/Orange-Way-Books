-- Track 4 PR D, payment request line items
--
-- One payment request can break into N items. Each item carries:
--   - encrypted description ("Internet", "Electricity", ...)
--   - encrypted amount (item's portion of the parent total)
--   - chart-of-account FK (each line routes to the right Income Statement bucket)
--   - sort order (preserves the user's row order in the form)
--
-- Attachments per line: extends the attachments.entity_type CHECK to include
-- 'payment_request_line_item' so the existing encrypted-blob upload pipeline
-- works without a new storage path.
--
-- RLS: line items are visible/writable iff the user has access to the parent
-- payment_request (which already enforces org_id via existing payment_requests
-- policies, we just join through).
--

CREATE TABLE IF NOT EXISTS public.payment_request_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_request_id UUID NOT NULL REFERENCES public.payment_requests(id) ON DELETE CASCADE,
  sort_order INT NOT NULL DEFAULT 0,

  -- Encrypted business fields (ZKA L2). Plaintext placeholder columns satisfy
  -- the NOT NULL contract used by other tables in OWB while the real values
  -- live in encrypted_*.
  encrypted_description TEXT NULL,
  description TEXT NULL,
  encrypted_amount TEXT NULL,
  amount NUMERIC NOT NULL DEFAULT 0,

  -- Chart-of-accounts routing (D-1 lock). NULL for legacy / uncategorized.
  legacy_account_map_id UUID NULL REFERENCES public.legacy_account_map(id) ON DELETE SET NULL,

  key_version INT NOT NULL DEFAULT 2,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pr_line_items_request ON public.payment_request_line_items (payment_request_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_pr_line_items_account ON public.payment_request_line_items (legacy_account_map_id);

ALTER TABLE public.payment_request_line_items ENABLE ROW LEVEL SECURITY;

-- RLS, join through to parent payment_requests for the org-scope check.
CREATE POLICY "prli_select" ON public.payment_request_line_items
  FOR SELECT TO authenticated
  USING (
    payment_request_id IN (
      SELECT id FROM public.payment_requests
      WHERE org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
    )
  );

CREATE POLICY "prli_insert" ON public.payment_request_line_items
  FOR INSERT TO authenticated
  WITH CHECK (
    payment_request_id IN (
      SELECT id FROM public.payment_requests
      WHERE org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
    )
  );

CREATE POLICY "prli_update" ON public.payment_request_line_items
  FOR UPDATE TO authenticated
  USING (
    payment_request_id IN (
      SELECT id FROM public.payment_requests
      WHERE org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
    )
  );

CREATE POLICY "prli_delete" ON public.payment_request_line_items
  FOR DELETE TO authenticated
  USING (
    payment_request_id IN (
      SELECT id FROM public.payment_requests
      WHERE org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
    )
  );

-- ── Attachments, allow line-item attachments (D-3 lock) ─────────────────
--
-- Drop the old CHECK and recreate with the new value included. The CHECK is
-- anonymous in the original migration, so we look up its name and drop it.

DO $$
DECLARE
  c_name TEXT;
BEGIN
  SELECT conname INTO c_name
    FROM pg_constraint
   WHERE conrelid = 'public.attachments'::regclass
     AND contype = 'c'
     AND pg_get_constraintdef(oid) ILIKE '%entity_type%';
  IF c_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.attachments DROP CONSTRAINT %I', c_name);
  END IF;
END $$;

ALTER TABLE public.attachments
  ADD CONSTRAINT attachments_entity_type_check
  CHECK (entity_type IN ('transaction', 'payment_request', 'payment_request_line_item'));

COMMENT ON TABLE public.payment_request_line_items IS
  'Breakdown rows for payment_requests. One request can have N items. Each item has its own description, amount, and chart-of-accounts FK. Attachments hang off via attachments.entity_type=payment_request_line_item.';

-- ── T4 PR E, email/phone immutable snapshots ─────────────────────────────
--
-- Audit columns. Captured at request creation from the linked
-- contact (auto) OR the form override fields (E-1 lock). Written once on
-- insert and never updated thereafter, even if the vendor's contact email
-- changes later, this request preserves the original "where the notice
-- went" trail. Encrypted under MEK like the rest of the row.

ALTER TABLE public.payment_requests
  ADD COLUMN IF NOT EXISTS encrypted_payee_email_snapshot TEXT NULL,
  ADD COLUMN IF NOT EXISTS encrypted_payee_phone_snapshot TEXT NULL;

COMMENT ON COLUMN public.payment_requests.encrypted_payee_email_snapshot IS
  'Audit snapshot of the vendor email at creation time. Frozen, never updated. Captured from the linked contact (auto) or the form override (E-1 lock).';

COMMENT ON COLUMN public.payment_requests.encrypted_payee_phone_snapshot IS
  'Audit snapshot of the vendor phone at creation time. Frozen, never updated.';
