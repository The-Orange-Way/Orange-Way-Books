-- Week 3 I16 — Wave Pattern A merge: deposit + placeholder invoice payment
--
-- When a customer manually marks an invoice paid today, the apply
-- path creates an invoice_payments row. That row's transaction_id points
-- at a synthetic "placeholder" wallet transaction (no bank import behind
-- it). Later, the real deposit lands via bank import / wallet sync. The
-- ranker (src/lib/invoiceMatch.ts) surfaces the invoice as a candidate
-- for the new deposit. Without a merge path the user would end up with
-- TWO invoice_payments rows (one placeholder, one real) and the invoice
-- would over-apply.
--
-- This migration adds the columns + RPC to MERGE the placeholder payment
-- with the real deposit:
--   - is_placeholder       : flagged TRUE when the linked transaction
--                            was not produced by an import/sync (manual
--                            "Mark paid" path). Defaults FALSE.
--   - superseded_by_transaction_id / superseded_at : when a placeholder
--     is merged, we DON'T delete the row (audit trail) — we update its
--     transaction_id to the real one and write the previous id into
--     superseded_by_transaction_id for traceability.
--   - signature_b64 / signature_key_version : Phase 4.4 signing-key signature on
--     the merge mutation. RLS already gates the write; the signature is
--     a defense-in-depth attestation that a writer-key holder produced
--     the change.
--
-- The merge RPC is idempotent: re-calling with the same arguments after
-- the placeholder has already been folded into the real transaction is
-- a no-op (returns the existing row).
--
-- ZKA: amount_applied stays untouched. Only the FK and metadata move.
-- The JE that was posted against the placeholder transaction's wallet
-- (if any) is reversed and a fresh JE is posted against the real
-- transaction's wallet — legacy ledger backend legacy_account_ids may differ.

BEGIN;

-- 1. Columns on invoice_payments.
ALTER TABLE public.invoice_payments
  ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS superseded_by_transaction_id UUID NULL
    REFERENCES public.transactions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS superseded_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS signature_b64 TEXT NULL,
  ADD COLUMN IF NOT EXISTS signature_key_version INT NULL;

CREATE INDEX IF NOT EXISTS idx_invoice_payments_placeholder
  ON public.invoice_payments (invoice_id)
  WHERE is_placeholder = TRUE;

COMMENT ON COLUMN public.invoice_payments.is_placeholder IS
  'TRUE when the linked transaction is a manual "Mark paid" placeholder, not a real bank/wallet import. Cleared on merge with a real deposit.';
COMMENT ON COLUMN public.invoice_payments.superseded_by_transaction_id IS
  'When a placeholder payment was merged with a real deposit, the prior placeholder transaction_id is recorded here for audit.';
COMMENT ON COLUMN public.invoice_payments.signature_b64 IS
  'Phase 4.4 signing-key signature over (org_id|merge|invoice_id|old_tx|new_tx). Stamped on merge.';

-- 2. The merge RPC.
--
-- Inputs:
--   p_invoice_payment_id  — the existing placeholder invoice_payments row
--   p_new_transaction_id  — the real (bank-import) transaction to fold in
--   p_signature_b64       — mutation signature over the merge payload
--   p_signature_key_version
--
-- Behavior:
--   1. Auth + org membership + payments.create capability check.
--   2. Verify p_invoice_payment_id is currently placeholder.
--   3. Verify the new transaction belongs to the same org as the invoice.
--   4. Reverse the JE that was posted against the placeholder (if any)
--      and post a fresh JE against the real transaction's wallet.
--   5. Update the invoice_payments row: set transaction_id = new,
--      superseded_by_transaction_id = old, superseded_at = now(),
--      is_placeholder = FALSE, signature_b64 = sig.
--   6. Idempotent: if the row already points at p_new_transaction_id and
--      is_placeholder is FALSE, return a no-op result.
--
-- Amount-mismatch tolerance is enforced CLIENT-side in mergeWithPlaceholder
-- because the canonical amount lives in the encrypted column. The server
-- only sees the coarse plaintext mirror.

DROP FUNCTION IF EXISTS public.merge_invoice_payment(
  UUID, UUID, TEXT, INT
);

CREATE OR REPLACE FUNCTION public.merge_invoice_payment(
  p_invoice_payment_id    UUID,
  p_new_transaction_id    UUID,
  p_signature_b64         TEXT,
  p_signature_key_version INT
)
RETURNS TABLE (
  payment_id                  UUID,
  invoice_id                  UUID,
  new_transaction_id          UUID,
  superseded_transaction_id   UUID,
  je_reversed_id              UUID,
  je_posted_id                UUID,
  noop                        BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_invoice_id        UUID;
  v_org_id            UUID;
  v_invoice_number    TEXT;
  v_invoice_currency  TEXT;
  v_old_tx_id         UUID;
  v_is_placeholder    BOOLEAN;
  v_amount_applied    NUMERIC;
  v_new_account_id     UUID;
  v_new_wallet_acct   UUID;
  v_new_tx_date       DATE;
  v_ar_account_id     UUID;
  v_existing_je_id    UUID;
  v_reversal_je_id    UUID := NULL;
  v_fresh_je_id       UUID := NULL;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF p_signature_b64 IS NULL OR length(p_signature_b64) = 0 THEN
    RAISE EXCEPTION 'mutation signature required for merge';
  END IF;

  SELECT ip.invoice_id, ip.transaction_id, ip.is_placeholder, ip.amount_applied,
         i.org_id, i.invoice_number, i.currency
    INTO v_invoice_id, v_old_tx_id, v_is_placeholder, v_amount_applied,
         v_org_id, v_invoice_number, v_invoice_currency
    FROM public.invoice_payments ip
    JOIN public.invoices i ON i.id = ip.invoice_id
   WHERE ip.id = p_invoice_payment_id;
  IF v_invoice_id IS NULL THEN
    RAISE EXCEPTION 'Invoice payment not found';
  END IF;

  -- Idempotent short-circuit: row already points at the new tx and
  -- is not flagged placeholder anymore → previous merge already ran.
  IF v_old_tx_id = p_new_transaction_id AND v_is_placeholder = FALSE THEN
    RETURN QUERY SELECT p_invoice_payment_id, v_invoice_id, p_new_transaction_id,
                        NULL::UUID, NULL::UUID, NULL::UUID, TRUE;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.org_members
     WHERE org_id = v_org_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'Not a member of this org';
  END IF;
  IF NOT public.user_has_capability(auth.uid(), 'payments.create', v_org_id) THEN
    RAISE EXCEPTION 'Missing payments.create capability';
  END IF;

  IF v_is_placeholder = FALSE THEN
    RAISE EXCEPTION 'Invoice payment is not a placeholder; refusing to merge';
  END IF;

  SELECT t.account_id, t.date
    INTO v_new_account_id, v_new_tx_date
    FROM public.transactions t
   WHERE t.id = p_new_transaction_id AND t.org_id = v_org_id;
  IF v_new_account_id IS NULL AND NOT FOUND THEN
    RAISE EXCEPTION 'New transaction not found in this org';
  END IF;

  -- Reverse the JE that was posted against the placeholder (if any).
  SELECT je.id
    INTO v_existing_je_id
    FROM public.journal_entries je
   WHERE je.org_id = v_org_id
     AND je.source_type = 'invoice_payment'
     AND je.memo = 'Invoice payment ' | v_invoice_number
     AND je.reversal_of_id IS NULL
   ORDER BY je.created_at DESC NULLS LAST, je.date DESC
   LIMIT 1;

  IF v_existing_je_id IS NOT NULL THEN
    INSERT INTO public.journal_entries (
      org_id, date, memo, currency, status, source_type, reversal_of_id
    ) VALUES (
      v_org_id,
      COALESCE(v_new_tx_date, CURRENT_DATE),
      'Reversal of placeholder payment ' | v_invoice_number,
      v_invoice_currency,
      'POSTED',
      'invoice_payment_merge',
      v_existing_je_id
    )
    RETURNING id INTO v_reversal_je_id;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description
    )
    SELECT v_reversal_je_id, account_id, credit, debit,
           'Reversal — placeholder payment ' | v_invoice_number
      FROM public.journal_entry_lines
     WHERE journal_entry_id = v_existing_je_id;
  END IF;

  SELECT s.accounts_receivable_account_map_id
    INTO v_ar_account_id
    FROM public.org_settings s
   WHERE s.org_id = v_org_id;

  IF v_ar_account_id IS NOT NULL AND v_new_account_id IS NOT NULL THEN
    SELECT w.legacy_account_id
      INTO v_new_wallet_acct
      FROM public.accounts w
     WHERE w.id = v_new_account_id AND w.org_id = v_org_id;
  END IF;

  IF v_ar_account_id IS NOT NULL AND v_new_wallet_acct IS NOT NULL THEN
    INSERT INTO public.journal_entries (
      org_id, date, memo, currency, status, source_type
    ) VALUES (
      v_org_id,
      COALESCE(v_new_tx_date, CURRENT_DATE),
      'Invoice payment ' | v_invoice_number,
      v_invoice_currency,
      'POSTED',
      'invoice_payment'
    )
    RETURNING id INTO v_fresh_je_id;

    INSERT INTO public.journal_entry_lines (
      journal_entry_id, account_id, debit, credit, description
    ) VALUES
      (v_fresh_je_id, v_new_wallet_acct, v_amount_applied, 0,
        'Dr Wallet — payment on ' | v_invoice_number),
      (v_fresh_je_id, v_ar_account_id, 0, v_amount_applied,
        'Cr A/R — payment on ' | v_invoice_number);
  END IF;

  UPDATE public.invoice_payments
     SET transaction_id              = p_new_transaction_id,
         superseded_by_transaction_id = v_old_tx_id,
         superseded_at                = now(),
         is_placeholder               = FALSE,
         signature_b64                = p_signature_b64,
         signature_key_version        = p_signature_key_version
   WHERE id = p_invoice_payment_id;

  RETURN QUERY SELECT p_invoice_payment_id, v_invoice_id, p_new_transaction_id,
                      v_old_tx_id, v_reversal_je_id, v_fresh_je_id, FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.merge_invoice_payment(
  UUID, UUID, TEXT, INT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.merge_invoice_payment(
  UUID, UUID, TEXT, INT
) TO authenticated;

COMMIT;
