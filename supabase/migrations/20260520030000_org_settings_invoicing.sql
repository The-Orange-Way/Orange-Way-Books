-- Invoicing, org_settings extensions for invoicing
--
-- Adds:
--   invoice_next_number    , auto-increment counter for invoice numbering.
--                             Plaintext; non-sensitive (the number itself is
--                             shown on the customer-facing invoice).
--   invoice_prefix         , text prefix for the number (e.g. 'INV-2026-').
--                             Plaintext; non-sensitive.
--   invoice_email_subject_template, Resend email subject; supports
--                             {{invoice_number}} {{org_name}} placeholders.
--   invoice_email_body_template   , Resend email body markdown/html. Same
--                             placeholders. Body is intentionally generic
--                             so server-side rendering doesn't see business
--                             content, only the link.
--   default_payment_terms_days, default Net X days for new invoices.
--   public_org_name        , non-encrypted org display name used in:
--                             (a) the email subject/body templates above,
--                             (b) the customer hosted view (so a recipient
--                                 not yet decrypting in-browser sees who
--                                 sent the invoice).
--                             ⚠️ ZKA tradeoff: org name leaks plaintext.
--                             Acceptable because: orgs put their name on
--                             their website anyway; this is the customer
--                             facing identity, not the books data.
--                             Customers can opt out by leaving it null and
--                             the hosted view falls back to "An organization
--                             using Orange Way Books Vault".

ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS invoice_next_number INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS invoice_prefix TEXT NOT NULL DEFAULT 'INV-',
  ADD COLUMN IF NOT EXISTS invoice_email_subject_template TEXT NULL,
  ADD COLUMN IF NOT EXISTS invoice_email_body_template TEXT NULL,
  ADD COLUMN IF NOT EXISTS default_payment_terms_days INTEGER NULL,
  ADD COLUMN IF NOT EXISTS public_org_name TEXT NULL;

COMMENT ON COLUMN public.org_settings.invoice_next_number IS
  'Auto-increment counter for invoice numbering. Read+1 on issue, then write back. Plaintext; non-sensitive (visible on each invoice).';
COMMENT ON COLUMN public.org_settings.invoice_prefix IS
  'Prefix prepended to invoice_next_number (e.g. "INV-2026-" → "INV-2026-042"). Plaintext.';
COMMENT ON COLUMN public.org_settings.public_org_name IS
  'Non-encrypted org display name for customer-facing surfaces (email subject, hosted view banner). Opt-out by leaving null.';

-- Atomic increment helper for invoice numbering. SECURITY DEFINER so the
-- caller's RLS doesn't matter; org membership is verified inside.
CREATE OR REPLACE FUNCTION public.next_invoice_number(p_org_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_prefix TEXT;
  v_next   INTEGER;
  v_result TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.org_members
     WHERE org_id = p_org_id AND user_id = v_user_id
  ) THEN
    RAISE EXCEPTION 'Forbidden: not a member of this org' USING ERRCODE = '42501';
  END IF;

  -- Atomically increment + return.
  UPDATE public.org_settings
     SET invoice_next_number = invoice_next_number + 1
   WHERE org_id = p_org_id
   RETURNING invoice_prefix, invoice_next_number - 1
        INTO v_prefix, v_next;

  IF v_next IS NULL THEN
    RAISE EXCEPTION 'org_settings row missing for this org' USING ERRCODE = 'P0002';
  END IF;

  -- Format: "<prefix><zero-padded-3-digit-number>", but allow > 999 to
  -- overflow naturally. 'INV-' + '001' / '042' / '1042' all valid.
  v_result := v_prefix | lpad(v_next::text, 3, '0');
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.next_invoice_number(UUID) TO authenticated;

COMMENT ON FUNCTION public.next_invoice_number(UUID) IS
  'Invoicing: atomically increment + return the next invoice number for an org. Verifies caller membership via auth.uid().';
