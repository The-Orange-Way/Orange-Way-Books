-- Week 3 I17, auto-post JE on invoice payment apply
--
-- Extends apply_invoice_payment() to also write a journal_entries +
-- journal_entry_lines pair recording the Dr Wallet / Cr A/R movement
-- when the org has an Accounts Receivable account configured.
--
-- If the org has not set accounts_receivable_account_map_id, the
-- apply succeeds and returns je_posted=false so the operator can wire
-- up A/R from Chart of Accounts and re-apply later (or post the JE
-- manually).
--
-- Why we don't reverse the deposit's original JE: the deposit's
-- transaction already posted to whatever account the operator picked.
-- If they categorized it as A/R, this JE matches and is net zero on
-- A/R. If they categorized it as income, they're double-counting
-- until they manually reclassify, and the match panel surfaces a
-- warning when this happens. (I16 phase will add automatic
-- reclassification on merge.)

BEGIN;

-- 1. New column on org_settings.
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS accounts_receivable_account_map_id UUID NULL;

COMMENT ON COLUMN public.org_settings.accounts_receivable_account_map_id IS
  'legacy_account_map.id of the org Accounts Receivable account. Used by apply_invoice_payment to post Dr Wallet / Cr A/R on each invoice payment.';

-- 2. Replace apply_invoice_payment with a version that posts the JE.
DROP FUNCTION IF EXISTS public.apply_invoice_payment(
  UUID, UUID, NUMERIC, TEXT, NUMERIC, TEXT
);

CREATE OR REPLACE FUNCTION public.apply_invoice_payment(
  p_invoice_id              UUID,
  p_transaction_id          UUID,
  p_amount_applied          NUMERIC,
  p_encrypted_amount_applied TEXT,
  p_applied_rate            NUMERIC DEFAULT NULL,
  p_encrypted_notes         TEXT    DEFAULT NULL
)
RETURNS TABLE (
  payment_id        UUID,
  invoice_status    TEXT,
  total_applied     NUMERIC,
  invoice_amount    NUMERIC,
  je_posted         BOOLEAN,
  je_id             UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id            UUID;
  v_invoice_amount    NUMERIC;
  v_invoice_number    TEXT;
  v_invoice_currency  TEXT;
  v_payment_id        UUID;
  v_total             NUMERIC;
  v_new_status        TEXT;
  v_current_status    TEXT;
  v_ar_account_id     UUID;
  v_account_id         UUID;
  v_wallet_account_id UUID;
  v_tx_date           DATE;
  v_je_id             UUID;
  v_je_posted         BOOLEAN := FALSE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT i.org_id, i.amount, i.status, i.invoice_number, i.currency
    INTO v_org_id, v_invoice_amount, v_current_status, v_invoice_number, v_invoice_currency
    FROM public.invoices i
   WHERE i.id = p_invoice_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'Invoice not found';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.org_members
     WHERE org_id = v_org_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this org';
  END IF;

  SELECT t.account_id, t.date
    INTO v_account_id, v_tx_date
    FROM public.transactions t
   WHERE t.id = p_transaction_id AND t.org_id = v_org_id;
  IF v_account_id IS NULL AND NOT FOUND THEN
    RAISE EXCEPTION 'Transaction not found in this org';
  END IF;

  IF p_amount_applied IS NULL OR p_amount_applied <= 0 THEN
    RAISE EXCEPTION 'amount_applied must be positive';
  END IF;
  IF p_encrypted_amount_applied IS NULL OR length(p_encrypted_amount_applied) = 0 THEN
    RAISE EXCEPTION 'encrypted_amount_applied is required';
  END IF;

  -- Idempotent insert.
  INSERT INTO public.invoice_payments (
    invoice_id, transaction_id, amount_applied, encrypted_amount_applied,
    applied_rate, encrypted_notes, applied_by, applied_at
  ) VALUES (
    p_invoice_id, p_transaction_id, p_amount_applied, p_encrypted_amount_applied,
    p_applied_rate, p_encrypted_notes, auth.uid(), now()
  )
  ON CONFLICT (invoice_id, transaction_id) DO NOTHING
  RETURNING id INTO v_payment_id;

  IF v_payment_id IS NULL THEN
    SELECT id INTO v_payment_id
      FROM public.invoice_payments
     WHERE invoice_id = p_invoice_id AND transaction_id = p_transaction_id;
  END IF;

  SELECT COALESCE(SUM(amount_applied), 0)
    INTO v_total
    FROM public.invoice_payments
   WHERE invoice_id = p_invoice_id;

  IF v_total >= v_invoice_amount AND v_invoice_amount > 0 THEN
    v_new_status := 'PAID';
  ELSIF v_total > 0 THEN
    v_new_status := 'PARTIAL';
  ELSE
    v_new_status := v_current_status;
  END IF;

  IF v_current_status IN ('VOIDED', 'WRITTEN_OFF') THEN
    v_new_status := v_current_status;
  ELSIF v_current_status = 'PAID' AND v_new_status = 'PARTIAL' THEN
    v_new_status := 'PAID';
  END IF;

  UPDATE public.invoices
     SET status  = v_new_status,
         paid_at = CASE WHEN v_new_status = 'PAID' AND paid_at IS NULL THEN now() ELSE paid_at END
   WHERE id = p_invoice_id;

  -- Post the JE Dr Wallet / Cr A/R if both ends are configured. We
  -- look up the org's A/R account first; if missing, skip.
  SELECT s.accounts_receivable_account_map_id
    INTO v_ar_account_id
    FROM public.org_settings s
   WHERE s.org_id = v_org_id;

  IF v_ar_account_id IS NOT NULL AND v_account_id IS NOT NULL THEN
    SELECT w.legacy_account_id
      INTO v_wallet_account_id
      FROM public.accounts w
     WHERE w.id = v_account_id AND w.org_id = v_org_id;
  END IF;

  IF v_ar_account_id IS NOT NULL AND v_wallet_account_id IS NOT NULL THEN
    INSERT INTO public.journal_entries (
      org_id, date, memo, currency, status, source_type
    ) VALUES (
      v_org_id,
      COALESCE(v_tx_date, CURRENT_DATE),
      'Invoice payment ' | v_invoice_number,
      v_invoice_currency,
      'POSTED',
      'invoice_payment'
    )
    RETURNING id INTO v_je_id;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description
    ) VALUES
      (v_je_id, v_wallet_account_id, p_amount_applied, 0,
        'Dr Wallet, payment on ' | v_invoice_number),
      (v_je_id, v_ar_account_id, 0, p_amount_applied,
        'Cr A/R, payment on ' | v_invoice_number);

    v_je_posted := TRUE;
  END IF;

  RETURN QUERY SELECT v_payment_id, v_new_status, v_total, v_invoice_amount, v_je_posted, v_je_id;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_invoice_payment(
  UUID, UUID, NUMERIC, TEXT, NUMERIC, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_invoice_payment(
  UUID, UUID, NUMERIC, TEXT, NUMERIC, TEXT
) TO authenticated;

COMMIT;
