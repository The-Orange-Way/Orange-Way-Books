-- Idempotent: create remaining public tables often missing on partial deploys.
-- Safe to run multiple times. Run after organizations / org_members exist.

-- ── account_metadata (legacy chart metadata) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.account_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  legacy_account_id UUID NOT NULL,
  legacy_account_code TEXT NOT NULL,
  encrypted_name TEXT,
  encrypted_description TEXT,
  key_version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.account_metadata ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "acct_meta_insert" ON public.account_metadata;
DROP POLICY IF EXISTS "acct_meta_select" ON public.account_metadata;
CREATE POLICY "acct_meta_insert" ON public.account_metadata FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
CREATE POLICY "acct_meta_select" ON public.account_metadata FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

-- ── transaction_metadata (legacy tx metadata) ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.transaction_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  legacy_tx_id UUID,
  encrypted_description TEXT,
  encrypted_contact TEXT,
  receipt_url TEXT,
  key_version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.transaction_metadata ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "tx_meta_insert" ON public.transaction_metadata;
DROP POLICY IF EXISTS "tx_meta_select" ON public.transaction_metadata;
CREATE POLICY "tx_meta_insert" ON public.transaction_metadata FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
CREATE POLICY "tx_meta_select" ON public.transaction_metadata FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

-- ── exchange_rates (public FX cache, no org FK) ─────────────────────────────
CREATE TABLE IF NOT EXISTS public.exchange_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  base_currency TEXT NOT NULL,
  quote_currency TEXT NOT NULL,
  rate NUMERIC NOT NULL,
  rate_date DATE NOT NULL,
  provider TEXT NOT NULL,
  fetched_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (base_currency, quote_currency, rate_date, provider)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates_lookup
  ON public.exchange_rates (base_currency, quote_currency, rate_date);

DO $$
BEGIN
  IF to_regclass('public.exchange_rates') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.exchange_rates FROM anon';
    EXECUTE 'GRANT SELECT ON public.exchange_rates TO authenticated';
  END IF;
END $$;

-- ── payment_requests (Payments page) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  ref_number TEXT,
  encrypted_payee TEXT,
  encrypted_description TEXT,
  encrypted_rejection_reason TEXT,
  amount NUMERIC NOT NULL DEFAULT 0,
  encrypted_amount TEXT,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'PENDING',
  request_type TEXT NOT NULL DEFAULT 'Invoice',
  vendor_ref TEXT,
  due_date DATE,
  document_date DATE,
  payment_address TEXT,
  requested_by UUID REFERENCES auth.users(id),
  approved_by UUID REFERENCES auth.users(id),
  paid_at TIMESTAMPTZ,
  key_version INTEGER DEFAULT 2,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE public.payment_requests ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;

ALTER TABLE public.payment_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage payment requests for their org" ON public.payment_requests;
CREATE POLICY "Users can manage payment requests for their org"
  ON public.payment_requests FOR ALL
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

CREATE INDEX IF NOT EXISTS idx_payment_requests_org ON public.payment_requests (org_id);
CREATE INDEX IF NOT EXISTS idx_payment_requests_status ON public.payment_requests (org_id, status);

-- ── connectors (Admin integrations) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.connectors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL CHECK (connector_type IN ('blink', 'exchange', 'bank')),
  label TEXT NOT NULL DEFAULT '',
  encrypted_label TEXT,
  config_encrypted TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected', 'disconnected', 'error')),
  last_sync TIMESTAMPTZ,
  key_version SMALLINT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.connectors ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;

CREATE INDEX IF NOT EXISTS idx_connectors_org_id ON public.connectors (org_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connectors_org_type ON public.connectors (org_id, connector_type);

ALTER TABLE public.connectors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own org connectors" ON public.connectors;
DROP POLICY IF EXISTS "Users can insert own org connectors" ON public.connectors;
DROP POLICY IF EXISTS "Users can update own org connectors" ON public.connectors;
DROP POLICY IF EXISTS "Users can delete own org connectors" ON public.connectors;

CREATE POLICY "Users can view own org connectors" ON public.connectors FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
CREATE POLICY "Users can insert own org connectors" ON public.connectors FOR INSERT TO authenticated
  WITH CHECK (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
CREATE POLICY "Users can update own org connectors" ON public.connectors FOR UPDATE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
CREATE POLICY "Users can delete own org connectors" ON public.connectors FOR DELETE TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

CREATE OR REPLACE FUNCTION public.set_connectors_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_connectors_updated_at ON public.connectors;
CREATE TRIGGER trg_connectors_updated_at
  BEFORE UPDATE ON public.connectors
  FOR EACH ROW
  EXECUTE FUNCTION public.set_connectors_updated_at();

-- ── audit_logs ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.audit_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'ARCHIVE', 'UNARCHIVE', 'POST', 'VOID', 'RECONCILE')),
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'organization', 'wallet', 'transaction', 'journal_entry', 'contact',
    'payment_request', 'chart_of_account', 'connector', 'org_settings', 'member'
  )),
  entity_id UUID NOT NULL,
  summary TEXT,
  before_snapshot TEXT,
  after_snapshot TEXT,
  key_version INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON public.audit_logs (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_entity ON public.audit_logs (entity_type, entity_id);

ALTER TABLE public.audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can read audit logs in their org" ON public.audit_logs;
CREATE POLICY "Users can read audit logs in their org"
  ON public.audit_logs FOR ALL
  USING (
    org_id IN (
      SELECT om.org_id FROM public.org_members om WHERE om.user_id = auth.uid()
    )
  );
