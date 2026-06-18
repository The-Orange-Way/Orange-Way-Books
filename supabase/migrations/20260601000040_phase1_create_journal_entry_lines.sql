-- Phase 1 — Migration 4/9: Create `journal_entry_lines` with locked end-state schema.
--
-- The OLD shape had plaintext `debit NUMERIC = 0` + `credit NUMERIC = 0` placeholder
-- columns alongside `encrypted_debit` + `encrypted_credit`. The placeholders were
-- hardcoded to zero in encryptJournalEntryLine (`src/lib/crypto-fields.ts:445`) and
-- served no purpose other than satisfying fork constraints we no longer need.
-- New shape drops them entirely.
--
-- Amount columns are encrypted-only. Account FK now points at the new
-- `chart_of_accounts(id)`. Description, account_name, account_code columns
-- keep their existing names (they already hold ciphertext today despite the names —
-- preserving the convention to minimize client-code churn).
--
-- Plaintext metadata for rate resolution stays plaintext: pinned_rate_id (FK to
-- public market rates, not customer data), rate_pending (boolean, structural state),
-- rate_asof (timestamp), primary_currency_at_posting (currency code at the
-- ORG level — a tiny metadata leak, but justified by the existing rate-pinning
-- system architecture).
--
-- Note: manual_rate_reason + manual_rate_source on the OLD schema were plaintext
-- but contain customer-typed content. We move them to encrypted in this redesign.

CREATE TABLE public.journal_entry_lines (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_entry_id                UUID NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  account_id                      UUID NOT NULL REFERENCES public.chart_of_accounts(id),
  key_version                     INT  NOT NULL DEFAULT 2,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Encrypted (ZKA L2) — server cannot read any of these
  encrypted_debit                 TEXT NOT NULL,    -- ciphertext of decimal amount (single-sided enforced client-side)
  encrypted_credit                TEXT NOT NULL,    -- ciphertext of decimal amount
  encrypted_book_value            TEXT NULL,        -- ciphertext of decimal (optional)
  encrypted_amount_native         TEXT NULL,        -- ciphertext: signed wallet-currency amount (debit+ / credit-)
  encrypted_amount_primary        TEXT NULL,        -- ciphertext: amount translated to primary currency at posting date
  encrypted_posted_rate           TEXT NULL,        -- ciphertext: rate ratio (primary per wallet unit)
  encrypted_wallet_currency       TEXT NULL,        -- ciphertext: wallet currency code
  encrypted_primary_currency_at_posting TEXT NULL,  -- ciphertext (was plaintext on OLD schema; encrypted for stricter ZKA bar)
  encrypted_manual_rate_reason    TEXT NULL,        -- ciphertext: customer-typed reason (≥40 chars enforced client-side)
  encrypted_manual_rate_source    TEXT NULL,        -- ciphertext: source label
  account_name                    TEXT NULL,        -- ciphertext (legacy name; holds AES-GCM output)
  account_code                    TEXT NULL,        -- ciphertext (legacy name)
  description                     TEXT NULL,        -- ciphertext (legacy name)
  encrypted_metadata              JSONB NULL,
  -- Plaintext structural metadata for rate resolution
  pinned_rate_id                  UUID NULL REFERENCES public.exchange_rates(id) ON DELETE SET NULL,
  rate_pending                    BOOLEAN NOT NULL DEFAULT false,
  rate_asof                       TIMESTAMPTZ NULL,
  dual_amounts_backfilled         BOOLEAN NOT NULL DEFAULT true   -- new schema always writes dual amounts
);

CREATE INDEX idx_jel_journal_entry ON public.journal_entry_lines (journal_entry_id);
CREATE INDEX idx_jel_account       ON public.journal_entry_lines (account_id);
CREATE INDEX idx_jel_rate_pending  ON public.journal_entry_lines (journal_entry_id) WHERE rate_pending = true;

ALTER TABLE public.journal_entry_lines ENABLE ROW LEVEL SECURITY;

-- SELECT: any org member of the parent JE's org
CREATE POLICY journal_entry_lines_select
  ON public.journal_entry_lines
  FOR SELECT TO authenticated
  USING (
    journal_entry_id IN (
      SELECT id FROM public.journal_entries
      WHERE public.current_user_org_rank(org_id) IS NOT NULL
    )
  );

-- INSERT/UPDATE/DELETE gated on capability via parent JE's org_id
CREATE POLICY journal_entry_lines_insert
  ON public.journal_entry_lines
  FOR INSERT TO authenticated
  WITH CHECK (
    journal_entry_id IN (
      SELECT id FROM public.journal_entries
      WHERE public.user_has_capability(auth.uid(), 'journal_entries.write', org_id)
    )
  );

CREATE POLICY journal_entry_lines_update
  ON public.journal_entry_lines
  FOR UPDATE TO authenticated
  USING (
    journal_entry_id IN (
      SELECT id FROM public.journal_entries
      WHERE public.user_has_capability(auth.uid(), 'journal_entries.write', org_id)
    )
  )
  WITH CHECK (
    journal_entry_id IN (
      SELECT id FROM public.journal_entries
      WHERE public.user_has_capability(auth.uid(), 'journal_entries.write', org_id)
    )
  );

CREATE POLICY journal_entry_lines_delete
  ON public.journal_entry_lines
  FOR DELETE TO authenticated
  USING (
    journal_entry_id IN (
      SELECT id FROM public.journal_entries
      WHERE public.user_has_capability(auth.uid(), 'journal_entries.delete', org_id)
    )
  );

-- Cross-row sanity: a line's account must be in the same org as the parent JE.
-- account_id FK already enforces "account exists"; this trigger adds the
-- same-org check (parallel to the chart_of_accounts parent-same-org trigger).
CREATE OR REPLACE FUNCTION public.check_jel_account_same_org()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_je_org_id      UUID;
  v_account_org_id UUID;
BEGIN
  SELECT org_id INTO v_je_org_id      FROM public.journal_entries   WHERE id = NEW.journal_entry_id;
  SELECT org_id INTO v_account_org_id FROM public.chart_of_accounts WHERE id = NEW.account_id;
  IF v_je_org_id IS NULL THEN
    RAISE EXCEPTION 'journal_entry % does not exist', NEW.journal_entry_id USING ERRCODE = '23503';
  END IF;
  IF v_account_org_id IS NULL THEN
    RAISE EXCEPTION 'account_id % does not exist', NEW.account_id USING ERRCODE = '23503';
  END IF;
  IF v_je_org_id <> v_account_org_id THEN
    RAISE EXCEPTION 'journal_entry_lines.account_id % belongs to a different org than its parent journal_entry', NEW.account_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_jel_account_same_org
  BEFORE INSERT OR UPDATE OF journal_entry_id, account_id
  ON public.journal_entry_lines
  FOR EACH ROW
  EXECUTE FUNCTION public.check_jel_account_same_org();

COMMENT ON TABLE public.journal_entry_lines IS
  'Locked end-state shape (2026-05-30 redesign). No $1 placeholder debit/credit plaintext columns. All amounts encrypted-only. FK on account_id → chart_of_accounts(id) with same-org trigger.';
