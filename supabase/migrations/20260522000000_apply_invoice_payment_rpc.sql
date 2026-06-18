-- Week 3 I14 — apply_invoice_payment RPC
--
-- Atomic operation: insert invoice_payments row + recompute invoice
-- status. Called by the client after the user picks an invoice in the
-- "Match to invoice?" panel on the Transactions edit modal.
--
-- ZKA: amount_applied stored both in plaintext (coarse mirror for SUM)
-- and as encrypted_amount_applied (canonical ZKA L2 value). Caller
-- supplies both; the server only sums the plaintext to decide the
-- status flip.
--
-- Status logic:
--   sum(applied) >= invoice.amount → PAID + paid_at = now()
--   0 < sum < invoice.amount       → PARTIAL
--   sum = 0                        → unchanged (defensive — shouldn't fire)
--
-- Idempotency: invoice_payments has UNIQUE (invoice_id, transaction_id).
-- Re-applying the same pair is a no-op (returns the existing row id).
--
-- Authorization: caller must be a member of the invoice's org. The
-- function runs SECURITY DEFINER but checks org membership against
-- auth.uid() before doing anything.

BEGIN;

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
  invoice_amount    NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id          UUID;
  v_invoice_amount  NUMERIC;
  v_payment_id      UUID;
  v_total           NUMERIC;
  v_new_status      TEXT;
  v_current_status  TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  -- Load + auth the invoice.
  SELECT i.org_id, i.amount, i.status
    INTO v_org_id, v_invoice_amount, v_current_status
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

  -- Also verify the transaction belongs to the same org. This blocks
  -- a confused-deputy where org A's invoice is "paid" by org B's
  -- transaction.
  IF NOT EXISTS (
    SELECT 1 FROM public.transactions t
     WHERE t.id = p_transaction_id AND t.org_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'Transaction not found in this org';
  END IF;

  IF p_amount_applied IS NULL OR p_amount_applied <= 0 THEN
    RAISE EXCEPTION 'amount_applied must be positive';
  END IF;
  IF p_encrypted_amount_applied IS NULL OR length(p_encrypted_amount_applied) = 0 THEN
    RAISE EXCEPTION 'encrypted_amount_applied is required';
  END IF;

  -- Idempotent insert. On conflict, keep the existing row.
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

  -- Recompute total applied + new status.
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

  -- Only advance status forward; never demote PAID → PARTIAL on a
  -- partial-payment correction. Also preserve VOIDED / WRITTEN_OFF.
  IF v_current_status IN ('VOIDED', 'WRITTEN_OFF') THEN
    v_new_status := v_current_status;
  ELSIF v_current_status = 'PAID' AND v_new_status = 'PARTIAL' THEN
    v_new_status := 'PAID';
  END IF;

  UPDATE public.invoices
     SET status  = v_new_status,
         paid_at = CASE WHEN v_new_status = 'PAID' AND paid_at IS NULL THEN now() ELSE paid_at END
   WHERE id = p_invoice_id;

  RETURN QUERY SELECT v_payment_id, v_new_status, v_total, v_invoice_amount;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_invoice_payment(
  UUID, UUID, NUMERIC, TEXT, NUMERIC, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.apply_invoice_payment(
  UUID, UUID, NUMERIC, TEXT, NUMERIC, TEXT
) TO authenticated;

COMMIT;
