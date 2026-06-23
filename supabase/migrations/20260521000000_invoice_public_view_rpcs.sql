-- Invoicing, anon RPCs for the public hosted view
--
-- The customer-facing hosted view (Bitwarden Send pattern) needs:
--   1. An anon-callable RPC to fetch the encrypted share blob by its
--      non-secret public_url_id. The decryption key lives in the URL
--      fragment of the share link and never reaches the server.
--   2. An anon-callable RPC to record a view (increment counter +
--      set viewed_at on first view). This is what flips status SENT
--      → VIEWED, the same status convention used by QuickBooks,
--      FreshBooks, Wave.
--
-- Both RPCs are SECURITY DEFINER + scope-restricted. They cannot
-- read any other invoice column except what's needed for the public
-- view path. They cannot mutate anything except the view counter
-- and viewed_at.
--
-- Expiry: if public_share_expires_at is set and now() exceeds it,
-- the RPC returns null. Caller's UI treats null as "link expired".
--
-- Refs:
--   Internal design notes attached to the migration.
--   Pattern: Bitwarden Send + Signal attachments

-- ── Fetch the encrypted invoice payload for the public view ──────────
CREATE OR REPLACE FUNCTION public.get_public_invoice(p_url_id TEXT)
RETURNS TABLE (
  encrypted_share_blob TEXT,
  status TEXT,
  currency TEXT,
  issue_date DATE,
  due_date DATE,
  sent_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  view_count INT,
  org_public_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
BEGIN
  RETURN QUERY
  SELECT
    i.encrypted_share_blob,
    i.status,
    i.currency,
    i.issue_date,
    i.due_date,
    i.sent_at,
    i.public_share_expires_at,
    i.public_view_count,
    os.public_org_name
  FROM public.invoices i
  LEFT JOIN public.org_settings os ON os.org_id = i.org_id
  WHERE i.public_url_id = p_url_id
    AND i.encrypted_share_blob IS NOT NULL
    AND (i.public_share_expires_at IS NULL OR i.public_share_expires_at > now())
    AND i.status NOT IN ('VOIDED', 'WRITTEN_OFF')
  LIMIT 1;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_public_invoice(TEXT) TO anon, authenticated;

COMMENT ON FUNCTION public.get_public_invoice IS
  'Anon-callable RPC for the customer-facing hosted invoice view. Returns the encrypted blob + plaintext lifecycle metadata (status, dates, currency) + the org public_org_name. Decryption key lives in the URL fragment and never reaches the server.';

-- ── Record a view: increment counter + set viewed_at on first view ──
CREATE OR REPLACE FUNCTION public.record_public_invoice_view(p_url_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id UUID;
  v_first_view BOOLEAN := FALSE;
BEGIN
  SELECT id INTO v_id
    FROM public.invoices
   WHERE public_url_id = p_url_id
     AND encrypted_share_blob IS NOT NULL
     AND (public_share_expires_at IS NULL OR public_share_expires_at > now())
     AND status NOT IN ('VOIDED', 'WRITTEN_OFF')
   LIMIT 1;

  IF v_id IS NULL THEN
    RETURN FALSE;
  END IF;

  UPDATE public.invoices
     SET public_view_count = public_view_count + 1,
         viewed_at = COALESCE(viewed_at, now()),
         status = CASE
           WHEN status = 'SENT' THEN 'VIEWED'
           ELSE status
         END
   WHERE id = v_id
   RETURNING (viewed_at = now()) INTO v_first_view;

  RETURN COALESCE(v_first_view, FALSE);
END;
$$;

GRANT EXECUTE ON FUNCTION public.record_public_invoice_view(TEXT) TO anon, authenticated;

COMMENT ON FUNCTION public.record_public_invoice_view IS
  'Anon-callable RPC. Increments view counter + sets viewed_at on first view + flips status SENT → VIEWED. Returns TRUE iff this was the first view.';
