-- Phase 1 — Migration 2/9: Create `chart_of_accounts` (replaces `legacy_account_map`).
--
-- Fully ZKA. Server sees: row UUID, org_id, parent_id (UUID), opened_at,
-- closed_at, key_version, timestamps. Everything customer-meaningful is
-- encrypted: account name, code, description, type, sub-type, group flag,
-- system flag, archived flag, allowed currencies.
--
-- Account type taxonomy lives in the encrypted columns. The browser decrypts
-- all chart_of_accounts rows on app load (small set: 40-200 accounts per org)
-- and caches the mapping. `ledger-engine.ts` looks up by accountId → gets the
-- decrypted type → applies normal-balance math. Server never needs to know.

CREATE TABLE public.chart_of_accounts (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  parent_id                       UUID NULL,        -- self-ref FK below; deferrable so a tree can be inserted in one tx
  -- Encrypted (ZKA L2) — server cannot read any of these
  encrypted_name                  TEXT NOT NULL,    -- "Bitcoin Cold Storage"
  encrypted_code                  TEXT NULL,        -- "1001" or "A1001" — user-chosen
  encrypted_description           TEXT NULL,        -- free text
  encrypted_account_type          TEXT NOT NULL,    -- "Asset" | "Liability" | "Equity" | "Income" | "Expense"
  encrypted_account_sub_type      TEXT NULL,        -- "Bank" | "Cash" | "Receivable" | "Payable" | "CreditCard" | "Stock" | "MutualFund" | "Trading" | "FixedAsset" | "COGS" | "Tax" | "Other"
  encrypted_is_group              TEXT NOT NULL,    -- encrypted boolean: tree group marker
  encrypted_is_system             TEXT NOT NULL,    -- encrypted boolean: seed protection (system-seeded, can't be user-deleted)
  encrypted_is_archived           TEXT NULL,        -- encrypted boolean: soft-delete flag
  encrypted_allowed_currencies    TEXT NULL,        -- encrypted JSON array of ISO codes; null = unrestricted
  encrypted_metadata              JSONB NULL,       -- catch-all for any future customer-typed metadata
  -- Plaintext structural metadata
  opened_at                       DATE NULL,        -- date the account became active (Beancount-inspired)
  closed_at                       DATE NULL,        -- date the account was closed (null = still open)
  key_version                     INT  NOT NULL DEFAULT 2,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Self-ref FK with DEFERRABLE INITIALLY DEFERRED so seeding a tree of
-- accounts in a single transaction works regardless of insert order.
ALTER TABLE public.chart_of_accounts
  ADD CONSTRAINT chart_of_accounts_parent_fk
  FOREIGN KEY (parent_id) REFERENCES public.chart_of_accounts(id)
  ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX idx_chart_of_accounts_org    ON public.chart_of_accounts (org_id);
CREATE INDEX idx_chart_of_accounts_parent ON public.chart_of_accounts (parent_id) WHERE parent_id IS NOT NULL;

ALTER TABLE public.chart_of_accounts ENABLE ROW LEVEL SECURITY;

-- SELECT: any org member can read the chart (browser needs all rows on load to compute balances).
CREATE POLICY chart_of_accounts_select
  ON public.chart_of_accounts
  FOR SELECT TO authenticated
  USING (public.current_user_org_rank(org_id) IS NOT NULL);

-- Writes gated on the capability system (Phase 4.2 pattern from 20260423010000).
CREATE POLICY chart_of_accounts_insert
  ON public.chart_of_accounts
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_capability(auth.uid(), 'accounts.write', org_id));

CREATE POLICY chart_of_accounts_update
  ON public.chart_of_accounts
  FOR UPDATE TO authenticated
  USING      (public.user_has_capability(auth.uid(), 'accounts.write', org_id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'accounts.write', org_id));

CREATE POLICY chart_of_accounts_delete
  ON public.chart_of_accounts
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'accounts.delete', org_id));

-- Parent-same-org trigger. Replaces the old check_legacy_account_parent_same_org.
-- Prevents users from creating an account whose parent belongs to a different org.
CREATE OR REPLACE FUNCTION public.check_chart_of_accounts_parent_same_org()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  parent_org UUID;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT org_id INTO parent_org
    FROM public.chart_of_accounts
    WHERE id = NEW.parent_id;
  IF parent_org IS NULL THEN
    RAISE EXCEPTION 'chart_of_accounts.parent_id % does not exist', NEW.parent_id
      USING ERRCODE = '23503';
  END IF;
  IF parent_org <> NEW.org_id THEN
    RAISE EXCEPTION 'chart_of_accounts.parent_id % belongs to another org', NEW.parent_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_chart_of_accounts_parent_same_org
  BEFORE INSERT OR UPDATE OF parent_id, org_id
  ON public.chart_of_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.check_chart_of_accounts_parent_same_org();

COMMENT ON TABLE public.chart_of_accounts IS
  'Replaces legacy_account_map. Fully ZKA — server cannot read account name, code, description, type, sub-type, group/system/archived flags, or allowed currencies. Only structural metadata (UUIDs, dates, key_version) is plaintext.';

COMMENT ON COLUMN public.chart_of_accounts.encrypted_account_type IS
  'AES-256-GCM ciphertext of "Asset" | "Liability" | "Equity" | "Income" | "Expense". Decrypted client-side on app load + cached in memory. ledger-engine.ts uses the decrypted value to apply normal-balance math.';

COMMENT ON COLUMN public.chart_of_accounts.encrypted_account_sub_type IS
  'AES-256-GCM ciphertext of GnuCash-style sub-type: Bank | Cash | Receivable | Payable | CreditCard | Stock | MutualFund | Trading | FixedAsset | COGS | Tax | Other. Drives UI grouping + Balance Sheet sectioning.';

COMMENT ON COLUMN public.chart_of_accounts.encrypted_is_group IS
  'AES-256-GCM ciphertext of boolean. True = container node in the tree (no postings allowed). False = leaf (postable).';

COMMENT ON COLUMN public.chart_of_accounts.encrypted_is_system IS
  'AES-256-GCM ciphertext of boolean. True = seed-created account that user cannot delete (e.g., Transfer Clearing, FX Revaluation, Owner Equity).';
