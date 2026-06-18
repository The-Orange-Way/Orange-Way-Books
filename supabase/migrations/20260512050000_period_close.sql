-- Period close (P1 enforcement) + OWBSupport owner-level uplift
--
-- Two tables and a function that together enforce period-close
-- semantics, plus a re-seed of the OWBSupport role to include the
-- owner-level capabilities approved during launch planning.
--
-- Tables:
--   org_period_closes        - audit-trail of every close event ever issued.
--                              Stores the (locked_through_date, closed_by,
--                              closed_at) tuple. Most-recent row's
--                              locked_through_date is the active lock.
--                              Reopen is modeled as a NEW close row with
--                              earlier locked_through_date OR an
--                              `is_reopen_of` self-FK breadcrumb.
--   period_unlock_sessions   - the "Owner clicked hard-unlock" escape hatch.
--                              A row here means "this user has the ability
--                              to write into the closed period until
--                              expires_at." Defaults to 24h TTL.
--
-- The function is_date_in_closed_period(org_id, date) returns TRUE iff
-- there's a close-row with locked_through_date >= date AND no active
-- unlock session for the caller. Used by RLS on transactions +
-- journal_entries to refuse writes.
--

CREATE TABLE IF NOT EXISTS public.org_period_closes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  locked_through_date DATE NOT NULL,
  closed_by UUID NOT NULL REFERENCES auth.users(id),
  closed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Encrypted free-text reason / note (ZKA L2).
  encrypted_note TEXT NULL,
  key_version INT NOT NULL DEFAULT 2,
  -- Set when this row represents a re-close after an Owner re-opened the
  -- period earlier. The breadcrumb makes the timeline auditable.
  reopened_from_id UUID NULL REFERENCES public.org_period_closes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_period_closes_org ON public.org_period_closes (org_id, closed_at DESC);

ALTER TABLE public.org_period_closes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "period_closes_select" ON public.org_period_closes
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

-- Only callers with periods.close (Owner/Admin/Accountant/OWBSupport
-- after this migration) can INSERT a forward close.
CREATE POLICY "period_closes_insert" ON public.org_period_closes
  FOR INSERT TO authenticated
  WITH CHECK (
    org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
    AND public.user_has_capability(auth.uid(), 'periods.close', org_id)
  );

-- ── Unlock sessions ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.period_unlock_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id),
  granted_by UUID NOT NULL REFERENCES auth.users(id),
  unlock_through_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '24 hours'),
  revoked_at TIMESTAMPTZ NULL,
  encrypted_reason TEXT NULL,
  key_version INT NOT NULL DEFAULT 2
);

CREATE INDEX IF NOT EXISTS idx_unlock_sessions_active
  ON public.period_unlock_sessions (org_id, user_id, expires_at)
  WHERE revoked_at IS NULL;

ALTER TABLE public.period_unlock_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "unlock_sessions_select" ON public.period_unlock_sessions
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

-- Only callers with periods.unlock can INSERT an unlock session. The user-
-- side wiring restricts the Reopen button to Owners; this is the DB
-- backstop in case the UI is bypassed.
CREATE POLICY "unlock_sessions_insert" ON public.period_unlock_sessions
  FOR INSERT TO authenticated
  WITH CHECK (
    org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
    AND public.user_has_capability(auth.uid(), 'periods.unlock', org_id)
  );

-- ── The check function ────────────────────────────────────────────────
--
-- Returns TRUE iff `at_date` falls in a closed period for `p_org_id` AND
-- the calling user has no active unlock session covering that date.

CREATE OR REPLACE FUNCTION public.is_date_in_closed_period(
  p_org_id UUID,
  p_user_id UUID,
  at_date DATE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lock_date DATE;
  v_has_unlock BOOLEAN;
BEGIN
  -- Latest close row for the org. Effective lock = its locked_through_date.
  -- If reopened_from_id is set the older row is superseded.
  SELECT locked_through_date INTO v_lock_date
    FROM public.org_period_closes
   WHERE org_id = p_org_id
   ORDER BY closed_at DESC
   LIMIT 1;

  IF v_lock_date IS NULL OR at_date > v_lock_date THEN
    RETURN FALSE;
  END IF;

  -- Is there an active unlock session for this user covering at_date?
  SELECT EXISTS (
    SELECT 1 FROM public.period_unlock_sessions
     WHERE org_id = p_org_id
       AND user_id = p_user_id
       AND revoked_at IS NULL
       AND expires_at > now()
       AND unlock_through_date >= at_date
  ) INTO v_has_unlock;

  RETURN NOT v_has_unlock;
END;
$$;

COMMENT ON FUNCTION public.is_date_in_closed_period IS
  'Returns TRUE iff at_date is inside the org''s closed period AND the caller has no active unlock session covering that date. Used by RLS on transactions + journal_entries.';

-- ── OWBSupport role: owner-level uplift ──────────────────────────
--
-- 2026-05-12 design decision: OWBSupport should be able to do
-- everything an Owner can do, MINUS this protected set:
--
--   users.revoke           (only Owner can kick another user)
--   users.invite           (could be used to add an attacker email)
--   users.manage_roles     (eslegacytion vector)
--   roles.manage           (eslegacytion vector)
--   org.manage             (org-wide settings, currency change, archive)
--   periods.close          (closing is an Owner business decision)
--
-- Everything else (read/write everywhere + periods.unlock so support can
-- help customers reopen) is granted.
--
-- Idempotent: ON CONFLICT lets this migration re-run on a populated DB
-- without duplicating grants.

INSERT INTO public.role_capabilities (role_id, capability_key)
SELECT rd.id, c.key
  FROM public.role_definitions rd, public.capabilities c
 WHERE rd.name = 'OWBSupport'
   AND rd.is_system = TRUE
   AND rd.org_id IS NULL
   AND c.key NOT IN (
     'users.revoke', 'users.invite', 'users.manage_roles',
     'roles.manage', 'org.manage', 'periods.close'
   )
ON CONFLICT (role_id, capability_key) DO NOTHING;

COMMENT ON TABLE public.org_period_closes IS
  'Audit-trail of period-close events. Most-recent row by closed_at gives the active lock date. Reopens are tracked as new rows with reopened_from_id breadcrumb. Encrypted note carries the closer''s reason.';

COMMENT ON TABLE public.period_unlock_sessions IS
  'TTL-bounded escape hatch for Owner-initiated reopen. While an active row exists for (user, org, date-range), writes into the closed period are allowed for that user. Sweep-expired-roles cron handles expiry.';
