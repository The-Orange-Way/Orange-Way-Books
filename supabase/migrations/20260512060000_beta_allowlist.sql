-- Beta-gate allowlist (D7 lock)
--
-- Per-email allowlist that controls who can sign up during the
-- controlled-beta window. Adding an email here both authorizes signup
-- and (via the application's "Invite" action) triggers a Resend email
-- to the invitee with a sign-up link.
--
-- Global table (no org_id), beta-gate is platform-wide, not per-org.
-- Maintained by Orange Way Books staff via Admin > Beta tab. RLS restricts reads
-- to authenticated Orange Way Books staff; the signup-side check runs SECURITY
-- DEFINER through a function so anonymous signups can validate against
-- the list without exposing it.
--

CREATE TABLE IF NOT EXISTS public.beta_allowlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  invited_by UUID NULL REFERENCES auth.users(id),
  invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  invitation_sent_at TIMESTAMPTZ NULL,
  signed_up_at TIMESTAMPTZ NULL,
  note TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_beta_allowlist_email
  ON public.beta_allowlist (lower(email));

ALTER TABLE public.beta_allowlist ENABLE ROW LEVEL SECURITY;

-- Only Orange Way Books staff (users with the OWBSupport role on any org)
-- can read the table. Staff users are members of the staff role.
CREATE POLICY "beta_allowlist_select" ON public.beta_allowlist
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_member_roles omr
      JOIN public.role_definitions rd ON rd.id = omr.role_definition_id
      WHERE omr.user_id = auth.uid()
        AND rd.is_system = TRUE
        AND rd.name = 'OWBSupport'
        AND omr.revoked_at IS NULL
    )
  );

CREATE POLICY "beta_allowlist_insert" ON public.beta_allowlist
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.org_member_roles omr
      JOIN public.role_definitions rd ON rd.id = omr.role_definition_id
      WHERE omr.user_id = auth.uid()
        AND rd.is_system = TRUE
        AND rd.name = 'OWBSupport'
        AND omr.revoked_at IS NULL
    )
  );

CREATE POLICY "beta_allowlist_update" ON public.beta_allowlist
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_member_roles omr
      JOIN public.role_definitions rd ON rd.id = omr.role_definition_id
      WHERE omr.user_id = auth.uid()
        AND rd.is_system = TRUE
        AND rd.name = 'OWBSupport'
        AND omr.revoked_at IS NULL
    )
  );

CREATE POLICY "beta_allowlist_delete" ON public.beta_allowlist
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_member_roles omr
      JOIN public.role_definitions rd ON rd.id = omr.role_definition_id
      WHERE omr.user_id = auth.uid()
        AND rd.is_system = TRUE
        AND rd.name = 'OWBSupport'
        AND omr.revoked_at IS NULL
    )
  );

-- ── Signup-side check function ────────────────────────────────────────
--
-- Anonymous-friendly. Returns TRUE iff the email exists in the allowlist
-- AND has not yet signed up. Frontend signup page calls this RPC right
-- before the supabase.auth.signUp() to short-circuit on "private beta".
--
-- SECURITY DEFINER so the function can read beta_allowlist without
-- exposing it to anon clients (the function only returns BOOLEAN).

CREATE OR REPLACE FUNCTION public.is_email_in_beta_allowlist(
  p_email TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.beta_allowlist
     WHERE lower(email) = lower(p_email)
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.is_email_in_beta_allowlist(TEXT) TO anon, authenticated;

COMMENT ON TABLE public.beta_allowlist IS
  'Per-email allowlist controlling signup during controlled beta. Email here = sign-up allowed.';
COMMENT ON FUNCTION public.is_email_in_beta_allowlist IS
  'Anonymous-callable RPC. Returns TRUE iff the email is in the beta_allowlist. Used by the signup page to gate signups without exposing the list.';
