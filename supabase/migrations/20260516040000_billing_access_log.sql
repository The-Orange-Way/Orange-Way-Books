-- S16, Audit log for sensitive billing reads
--
-- billing_accounts, subscriptions, and flash_payments hold information
-- that's not encrypted (Stripe customer ids, subscription plans, payment
-- amounts) because the billing surface is operationally trusted, NOT
-- under the ZKA contract. Reading these tables is governed by RLS today,
-- but the SELECT itself leaves no trail, which means we can't answer
-- "who looked at my org's payment history last week?" or notice
-- anomalous patterns.
--
-- This migration introduces:
--   1. public.billing_access_log, append-only record of who accessed
--      which billing_account, when, and from what client context.
--   2. public.log_billing_access(...) RPC, SECURITY DEFINER, callable
--      by any authenticated user. Inserts one row scoped to auth.uid().
--
-- The application calls the RPC on every page mount that displays
-- billing data. This is best-effort: a malicious client could bypass
-- the call, but RLS already prevents cross-tenant reads, so the gap is
-- "we didn't log a legitimately-authorized access" rather than "an
-- unauthorized access slipped through silently". The trail covers the
-- legitimate path and gives us a starting point for forensic queries.
--
-- Surfaced by 2026-05-16 security review (finding E.5). Tracked as S16.

CREATE TABLE IF NOT EXISTS public.billing_access_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_account_id UUID NOT NULL REFERENCES public.billing_accounts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),

  -- Plaintext context strings, short, non-sensitive labels:
  --   'billing_page_view', 'invoice_pdf_open', 'subscription_status_check',
  --   'flash_status_admin_check', etc.
  -- We DO NOT log full URLs / referrers, those can carry PII.
  access_context TEXT NOT NULL,
  client_ip INET NULL,
  user_agent TEXT NULL,
  accessed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_access_log_account_time
  ON public.billing_access_log (billing_account_id, accessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_access_log_user_time
  ON public.billing_access_log (user_id, accessed_at DESC);

ALTER TABLE public.billing_access_log ENABLE ROW LEVEL SECURITY;

-- Billing account owner can read their own access log.
-- (Org members who share the billing account via organizations.billing_account_id
-- can also read, same audience as billing_accounts SELECT policy.)
CREATE POLICY "billing_access_log_select_owner" ON public.billing_access_log
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
        FROM public.billing_accounts ba
       WHERE ba.id = billing_access_log.billing_account_id
         AND (
           ba.owner_user_id = auth.uid()
           OR EXISTS (
             SELECT 1
               FROM public.organizations o
               JOIN public.org_members om ON om.org_id = o.id
              WHERE o.billing_account_id = ba.id
                AND om.user_id = auth.uid()
           )
         )
    )
  );

-- INSERT / UPDATE / DELETE are SERVICE-ROLE only. Writes happen via the
-- log_billing_access() RPC (SECURITY DEFINER) below. Direct client writes
-- are blocked.

-- ── RPC ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_billing_access(
  p_billing_account_id UUID,
  p_access_context TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
  END IF;

  -- Sanity-check the caller has read access to this billing account in
  -- the first place. Mirrors the billing_accounts SELECT policy. If they
  -- don't, we don't want to log a misleading "successful access" event.
  IF NOT EXISTS (
    SELECT 1
      FROM public.billing_accounts ba
     WHERE ba.id = p_billing_account_id
       AND (
         ba.owner_user_id = v_user_id
         OR EXISTS (
           SELECT 1
             FROM public.organizations o
             JOIN public.org_members om ON om.org_id = o.id
            WHERE o.billing_account_id = ba.id
              AND om.user_id = v_user_id
         )
       )
  ) THEN
    RAISE EXCEPTION 'Forbidden: caller cannot read this billing account' USING ERRCODE = '42501';
  END IF;

  -- Context label cap: keep it short + bounded.
  IF length(p_access_context) > 80 THEN
    p_access_context := substring(p_access_context FROM 1 FOR 80);
  END IF;

  INSERT INTO public.billing_access_log (billing_account_id, user_id, access_context)
  VALUES (p_billing_account_id, v_user_id, p_access_context)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_billing_access(UUID, TEXT) TO authenticated;

COMMENT ON TABLE public.billing_access_log IS
  'S16: append-only audit trail for reads of billing_accounts / subscriptions / flash_payments. Written via log_billing_access() RPC.';
COMMENT ON FUNCTION public.log_billing_access(UUID, TEXT) IS
  'S16: log a billing-account access by the caller. SECURITY DEFINER; verifies the caller has read access (mirroring billing_accounts SELECT policy) before inserting. Returns the log row id.';
