-- ============================================================
-- Flash Wave 1, billing accounts, subscriptions, and Flash
-- payment + OAuth state tables.
-- ============================================================
--
-- What this migration does:
--   1. billing_accounts, who pays. Either a single org ('org') or a
--      firm covering many orgs ('firm'). Wave 1 only writes 'org'.
--   2. organizations.billing_account_id, each org points at the
--      billing_account that pays for it. Nullable so existing orgs
--      stay valid until backfilled.
--   3. subscriptions, one per billing_account. plan + price live here;
--      tiers come later by adding plan strings, no schema change.
--   4. flash_payments, one row per Flash payment link we create.
--   5. flash_payment_events, webhook log for debugging + idempotency.
--   6. flash_platform_tokens, single-row OAuth token store for the
--      Orange Way Books platform Flash connection. RLS enabled with NO policies
--      so only service_role can touch it.
--   7. flash_oauth_state, short-lived CSRF + linking state for the
--      OAuth handshake.
--
-- RLS model:
--   * billing_accounts, subscriptions, flash_payments, readable by
--     the owner_user_id and by members of any org that points at the
--     billing_account. Writes are service-role only (subscription
--     state machine runs server-side).
--   * flash_payment_events, flash_platform_tokens, flash_oauth_state
--    , RLS enabled, zero policies. Service role only.
--
-- Idempotency: every CREATE/ALTER is guarded.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- 1. billing_accounts
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.billing_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('org', 'firm')),
  display_name TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_accounts_owner
  ON public.billing_accounts(owner_user_id);

-- ══════════════════════════════════════════════════════════════════════
-- 2. organizations.billing_account_id, must precede the billing_accounts
--    RLS policy below since the policy joins through this column.
-- ══════════════════════════════════════════════════════════════════════
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS billing_account_id UUID
    REFERENCES public.billing_accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_organizations_billing_account
  ON public.organizations(billing_account_id)
  WHERE billing_account_id IS NOT NULL;

COMMENT ON COLUMN public.organizations.billing_account_id IS
  'Billing account paying for this org. NULL = no billing relationship yet '
  '(pre-Flash orgs, or orgs awaiting firm-billing assignment).';

ALTER TABLE public.billing_accounts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "billing_accounts_select_owner_or_member" ON public.billing_accounts;
CREATE POLICY "billing_accounts_select_owner_or_member"
  ON public.billing_accounts
  FOR SELECT
  TO authenticated
  USING (
    owner_user_id = auth.uid()
    OR id IN (
      SELECT o.billing_account_id
        FROM public.organizations o
        JOIN public.org_members m ON m.org_id = o.id
       WHERE m.user_id = auth.uid()
         AND o.billing_account_id IS NOT NULL
    )
  );

-- ══════════════════════════════════════════════════════════════════════
-- 3. subscriptions
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id UUID NOT NULL UNIQUE
    REFERENCES public.billing_accounts(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL CHECK (status IN (
    'trialing','active','past_due','read_only','locked','cancelled','deleted'
  )),
  trial_ends_at TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  past_due_since TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  scheduled_deletion_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subscriptions_select_billing_visible" ON public.subscriptions;
CREATE POLICY "subscriptions_select_billing_visible"
  ON public.subscriptions
  FOR SELECT
  TO authenticated
  USING (
    billing_account_id IN (
      SELECT id FROM public.billing_accounts WHERE owner_user_id = auth.uid()
      UNION
      SELECT o.billing_account_id
        FROM public.organizations o
        JOIN public.org_members m ON m.org_id = o.id
       WHERE m.user_id = auth.uid()
         AND o.billing_account_id IS NOT NULL
    )
  );

-- ══════════════════════════════════════════════════════════════════════
-- 4. flash_payments
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.flash_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id UUID NOT NULL REFERENCES public.subscriptions(id) ON DELETE CASCADE,
  external_reference TEXT NOT NULL UNIQUE,
  flash_payment_link_url TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'pending','completed','failed','expired','refunded'
  )),
  gross_cents INTEGER,
  flash_fee_cents INTEGER,
  platform_fee_cents INTEGER,
  net_cents INTEGER,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flash_payments_subscription
  ON public.flash_payments(subscription_id);

ALTER TABLE public.flash_payments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "flash_payments_select_billing_visible" ON public.flash_payments;
CREATE POLICY "flash_payments_select_billing_visible"
  ON public.flash_payments
  FOR SELECT
  TO authenticated
  USING (
    subscription_id IN (
      SELECT s.id FROM public.subscriptions s
       WHERE s.billing_account_id IN (
         SELECT id FROM public.billing_accounts WHERE owner_user_id = auth.uid()
         UNION
         SELECT o.billing_account_id
           FROM public.organizations o
           JOIN public.org_members m ON m.org_id = o.id
          WHERE m.user_id = auth.uid()
            AND o.billing_account_id IS NOT NULL
       )
    )
  );

-- ══════════════════════════════════════════════════════════════════════
-- 5. flash_payment_events, service role only
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.flash_payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  external_reference TEXT,
  payload JSONB NOT NULL,
  signature TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flash_payment_events_ext_ref
  ON public.flash_payment_events(external_reference)
  WHERE external_reference IS NOT NULL;

ALTER TABLE public.flash_payment_events ENABLE ROW LEVEL SECURITY;
-- No policies: service_role bypasses; no client access.

-- ══════════════════════════════════════════════════════════════════════
-- 6. flash_platform_tokens, singleton, service role only
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.flash_platform_tokens (
  id TEXT PRIMARY KEY DEFAULT 'singleton',
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.flash_platform_tokens ENABLE ROW LEVEL SECURITY;
-- No policies: service_role bypasses; clients must never read these.

-- ══════════════════════════════════════════════════════════════════════
-- 7. flash_oauth_state, short-lived CSRF state, service role only
-- ══════════════════════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS public.flash_oauth_state (
  state TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_flash_oauth_state_expires
  ON public.flash_oauth_state(expires_at);

ALTER TABLE public.flash_oauth_state ENABLE ROW LEVEL SECURITY;
-- No policies: service_role bypasses. The state value itself is the
-- only thing that links a callback to the user who initiated the flow.

COMMIT;
