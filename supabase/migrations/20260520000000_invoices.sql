-- Invoicing module, invoices table
--
-- Symmetric AR primitive to payment_requests (which is AP). An invoice is a
-- bill the app issues TO a customer, vs. payment_requests which represent bills
-- the app receives FROM vendors.
--
-- ZKA Level 2:
--   • Plaintext columns (org_id, status, currency, dates, amount-for-filtering,
--     invoice_number, public_url_id): used for RLS pivots, indexing, sorting,
--     and the ZKA-share public lookup. These are intentionally not sensitive
--     in isolation, invoice_number is non-secret, amount-for-filtering is a
--     coarse value (OWB also stores encrypted_amount for the real value), etc.
--   • Encrypted columns (encrypted_*): the customer-identifying and
--     business-content fields. Server cannot read these.
--   • public_url_id: 16-char URL-safe token used by the customer-facing
--     hosted view to fetch the encrypted invoice blob. Not a secret on its
--     own (the decryption key lives in the URL fragment of the share link
--     and never reaches the server).
--
-- Lifecycle:
--   DRAFT      issuer is editing
--   SENT       emailed; awaiting customer view / payment
--   VIEWED     customer opened the hosted link at least once
--   PARTIAL    at least one payment recorded; balance > 0
--   PAID       balance reached zero
--   OVERDUE    past due_date, unpaid (status transition can be auto by cron)
--   VOIDED     cancelled with reason; preserves audit trail
--   WRITTEN_OFF bad debt; creates contra-revenue JE on transition
--
-- RLS: org members can manage invoices for their org. The public view path
-- bypasses RLS via a SECURITY DEFINER RPC (defined in a separate migration
-- when the public view ships in week 2).
--
-- Refs:
--   Internal design notes attached to the migration.
--   Mirrors:    supabase/migrations/20260416020000_payment_requests.sql

CREATE TABLE IF NOT EXISTS public.invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- Issuer (org-side)
  created_by UUID NULL REFERENCES auth.users(id),

  -- Customer link (soft: contact may be deleted but invoice survives)
  contact_id UUID NULL REFERENCES public.contacts(id) ON DELETE SET NULL,

  -- Plaintext identifier, required, non-secret, used for sorting + display
  invoice_number TEXT NOT NULL,

  -- Status machine
  status TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT', 'SENT', 'VIEWED', 'PARTIAL', 'PAID', 'OVERDUE', 'VOIDED', 'WRITTEN_OFF')),

  -- Plaintext amount for filter/sort/aging. Encrypted amount stores the
  -- canonical value when ZKA L2 is in effect.
  amount NUMERIC NOT NULL DEFAULT 0,
  encrypted_amount TEXT NULL,

  -- Plaintext currency code (USD, BTC, EUR …); not sensitive
  currency TEXT NOT NULL DEFAULT 'USD',

  -- Plaintext dates for aging + sorting; not sensitive
  issue_date DATE NULL,
  due_date DATE NULL,

  -- Lifecycle timestamps
  sent_at TIMESTAMPTZ NULL,
  viewed_at TIMESTAMPTZ NULL,           -- first customer view of hosted link
  paid_at TIMESTAMPTZ NULL,             -- balance reaches zero
  voided_at TIMESTAMPTZ NULL,
  written_off_at TIMESTAMPTZ NULL,

  -- ZKA-encrypted business content
  encrypted_customer_name TEXT NULL,
  encrypted_customer_email_snapshot TEXT NULL,  -- frozen at SEND
  encrypted_customer_phone_snapshot TEXT NULL,  -- frozen at SEND
  encrypted_customer_address TEXT NULL,
  encrypted_memo TEXT NULL,                 -- customer-facing notes
  encrypted_internal_notes TEXT NULL,       -- org-only notes
  encrypted_payment_instructions TEXT NULL, -- BTC address / Lightning / bank
  encrypted_void_reason TEXT NULL,
  encrypted_write_off_reason TEXT NULL,

  -- Public hosted view (Bitwarden Send pattern)
  -- The decryption key lives in the URL fragment of the share link and is
  -- never sent to the server. Server stores the encrypted payload + this
  -- non-secret url id used to look it up.
  public_url_id TEXT NULL UNIQUE,
  encrypted_share_blob TEXT NULL,
  public_share_created_at TIMESTAMPTZ NULL,
  public_share_expires_at TIMESTAMPTZ NULL,
  public_view_count INT NOT NULL DEFAULT 0,

  -- Crypto version
  key_version INT NOT NULL DEFAULT 2,

  -- Audit
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Per-org unique invoice number (so two orgs can both have INV-2026-001).
  CONSTRAINT invoices_org_number_unique UNIQUE (org_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS idx_invoices_org_status
  ON public.invoices (org_id, status, issue_date DESC);

CREATE INDEX IF NOT EXISTS idx_invoices_org_due_date
  ON public.invoices (org_id, due_date)
  WHERE status IN ('SENT', 'VIEWED', 'PARTIAL', 'OVERDUE');

CREATE INDEX IF NOT EXISTS idx_invoices_contact
  ON public.invoices (contact_id, status, issue_date DESC)
  WHERE contact_id IS NOT NULL;

-- public_url_id lookups for the hosted view (anon path)
CREATE INDEX IF NOT EXISTS idx_invoices_public_url
  ON public.invoices (public_url_id)
  WHERE public_url_id IS NOT NULL;

-- Auto-touch updated_at
CREATE OR REPLACE FUNCTION public._invoices_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_touch_updated_at ON public.invoices;
CREATE TRIGGER invoices_touch_updated_at
  BEFORE UPDATE ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public._invoices_touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────────────
ALTER TABLE public.invoices ENABLE ROW LEVEL SECURITY;

-- Org members can SELECT invoices for their org
CREATE POLICY "invoices_select" ON public.invoices
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
       WHERE om.org_id = invoices.org_id
         AND om.user_id = auth.uid()
    )
  );

-- Org members can INSERT for their org; created_by must match caller
CREATE POLICY "invoices_insert" ON public.invoices
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
       WHERE om.org_id = invoices.org_id
         AND om.user_id = auth.uid()
    )
  );

-- Org members can UPDATE invoices for their org
CREATE POLICY "invoices_update" ON public.invoices
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
       WHERE om.org_id = invoices.org_id
         AND om.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.org_members om
       WHERE om.org_id = invoices.org_id
         AND om.user_id = auth.uid()
    )
  );

-- Org members can DELETE only DRAFT/VOIDED invoices for their org.
-- SENT/VIEWED/PARTIAL/PAID/OVERDUE/WRITTEN_OFF are preserved for audit.
CREATE POLICY "invoices_delete" ON public.invoices
  FOR DELETE TO authenticated
  USING (
    status IN ('DRAFT', 'VOIDED')
    AND EXISTS (
      SELECT 1 FROM public.org_members om
       WHERE om.org_id = invoices.org_id
         AND om.user_id = auth.uid()
    )
  );

COMMENT ON TABLE public.invoices IS
  'AR primitive (customer billing). Mirrors payment_requests for AP. ZKA Level 2: business content encrypted client-side.';
COMMENT ON COLUMN public.invoices.public_url_id IS
  'Non-secret URL token for the public hosted view. Decryption key lives in the URL fragment.';
COMMENT ON COLUMN public.invoices.encrypted_share_blob IS
  'Encrypted invoice payload for the hosted view. Server cannot read it.';
