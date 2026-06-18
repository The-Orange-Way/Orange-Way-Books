
-- Organizations
CREATE TABLE public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  legacy_journal_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Organization members
CREATE TABLE public.org_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'Member',
  joined_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, org_id)
);

-- Org settings
CREATE TABLE public.org_settings (
  org_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  primary_currency TEXT DEFAULT 'USD',
  secondary_currency TEXT DEFAULT 'BTC',
  bitcoin_display TEXT DEFAULT 'sats',
  date_format TEXT DEFAULT 'MM-DD-YYYY'
);

-- Account metadata (encrypted)
CREATE TABLE public.account_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  legacy_account_id UUID NOT NULL,
  legacy_account_code TEXT NOT NULL,
  encrypted_name TEXT,
  encrypted_description TEXT,
  key_version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Wallets (name encrypted)
CREATE TABLE public.accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  legacy_account_id UUID,
  legacy_account_code TEXT,
  encrypted_name TEXT NOT NULL,
  asset TEXT NOT NULL DEFAULT 'BTC',
  account_type TEXT DEFAULT 'Manual',
  key_version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Transaction metadata (encrypted)
CREATE TABLE public.transaction_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  legacy_tx_id UUID,
  encrypted_description TEXT,
  encrypted_contact TEXT,
  receipt_url TEXT,
  key_version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Enable RLS
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.org_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.account_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_metadata ENABLE ROW LEVEL SECURITY;

-- RLS policies
CREATE POLICY "org_members_own" ON public.org_members FOR ALL USING (user_id = auth.uid());

CREATE POLICY "orgs_via_membership" ON public.organizations FOR ALL
  USING (id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

CREATE POLICY "settings_via_membership" ON public.org_settings FOR ALL
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

CREATE POLICY "account_metadata_via_membership" ON public.account_metadata FOR ALL
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

CREATE POLICY "accounts_via_membership" ON public.accounts FOR ALL
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

CREATE POLICY "tx_metadata_via_membership" ON public.transaction_metadata FOR ALL
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));
