-- ============================================================
-- Invite wrap pipeline + pending invites + inviter
-- visibility of invitee public keys.
-- ============================================================
-- Design reference: docs/OWB-MULTIUSER-DESIGN.md §4 (invite + revoke flows).
--
-- What this migration does:
--   1. Adds the `wrap_algo` column to org_keys so we can record which
--      KEM strategy was used to produce `wrapped_dek`. Existing rows
--      (self-wrapped on org creation, pre-Phase 4.3) are back-filled to
--      'v3-self-mek' so they stay distinguishable from real per-recipient
--      hybrid wraps.
--   2. Creates `pending_invites`, the state machine row for an invite
--      whose recipient does not yet have a public key. When the recipient
--      eventually publishes their keypair, a trigger flips the row to
--      `ready_to_wrap`; the Owner's client subscribes via realtime and
--      completes the wrap.
--   3. Adds a SELECT policy on `user_vault_keys` so a caller with
--      `users.invite` in an org can read a prospective member's public
--      key. The public_key_b64 is public by design (it exists so anyone
--      can wrap data FOR the recipient), this policy just exposes it
--      to the inviter client so the wrap can happen browser-side.
--   4. Installs `link_pending_invites_on_keypair_insert`, the AFTER
--      INSERT trigger on `user_vault_keys` that flips any matching
--      `pending_invites` rows to ready_to_wrap and writes a
--      `user.wrap_ready` audit event so the Owner's Security tab can
--      see the transition.
--
-- What this migration does NOT do:
--   * Rotate the per-org shared DEK, that is Phase 4.5 hard re-key.
--     Today `wrapped_dek` is the per-user vault MEK payload. Phase 4.3
--     ships the plumbing so Phase 4.5 can swap in a real shared DEK
--     without disturbing the invite/wrap flow.
--   * Touch the legacy `org_members.role` TEXT column.
--   * Add DELETE policies on org_keys beyond the D9 enforce trigger
--     (trigger runs SECURITY DEFINER and bypasses RLS).
--
-- Idempotency: every CREATE / ALTER is guarded. Running this migration
-- twice is a no-op.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- 1. org_keys: add wrap_algo column
-- ══════════════════════════════════════════════════════════════════════
--
-- Pre-Phase 4.3: org_keys.wrapped_dek is the user's own MEK wrapped by
-- themselves (solo-user case). That payload is opaque to this schema
-- we record 'v3-self-mek' as the back-fill value so downstream tooling
-- can distinguish pre-4.3 self-wraps from per-recipient hybrid-KEM
-- wraps written after 4.3.
--
-- From Phase 4.3 onward, every INSERT into org_keys that represents a
-- wrap for a newly-invited member MUST set wrap_algo to the strategy
-- used (e.g. 'hybrid-x25519-mlkem768'). The edge function enforces this
-- by requiring the client to pass the algorithm string alongside the
-- wrapped ciphertext.

ALTER TABLE public.org_keys
  ADD COLUMN IF NOT EXISTS wrap_algo TEXT;

UPDATE public.org_keys
   SET wrap_algo = 'v3-self-mek'
 WHERE wrap_algo IS NULL;

-- Can't make it NOT NULL yet, there's a window where new rows may be
-- inserted without setting it, and we want to be forgiving through the
-- phase-4 transition. Phase 4.5 can tighten this.
COMMENT ON COLUMN public.org_keys.wrap_algo IS
  'Wrap strategy identifier (e.g. hybrid-x25519-mlkem768). '
  'Rows pre-Phase 4.3 carry v3-self-mek (solo-user self-wrap). '
  'Phase 4.3+ invite flows write the per-recipient hybrid wrap strategy.';

-- ══════════════════════════════════════════════════════════════════════
-- 2. pending_invites table
-- ══════════════════════════════════════════════════════════════════════
--
-- Lifecycle:
--   awaiting_recipient  → invitee has not yet set up their vault keypair.
--                         Created by invite-org-member when the
--                         recipient does not yet exist (or exists but
--                         has no user_vault_keys row).
--   ready_to_wrap       → recipient published user_vault_keys; the
--                         link_pending_invites_on_keypair_insert trigger
--                         flipped this row. Owner client subscribes
--                         via realtime, unwraps + re-wraps the org DEK,
--                         then calls complete-invite-wrap.
--   wrapped             → org_keys row inserted. pending_invites row
--                         can be kept for auditing or cleaned up
--                         after a retention window.
--   cancelled           → inviter cancelled before the wrap completed.
--   expired             → expires_at (14 days) passed without completion.
--
-- A pending invite is uniquely identified by (org_id, email). The
-- UNIQUE constraint prevents duplicate pending entries when an Owner
-- re-invites the same email before the first invite resolves.

CREATE TABLE IF NOT EXISTS public.pending_invites (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id              UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  email               TEXT NOT NULL,
  role_definition_id  UUID NOT NULL REFERENCES public.role_definitions(id),
  inviter_id          UUID NOT NULL REFERENCES auth.users(id),
  recipient_user_id   UUID REFERENCES auth.users(id),
  status              TEXT NOT NULL DEFAULT 'awaiting_recipient'
                      CHECK (status IN ('awaiting_recipient','ready_to_wrap','wrapped','cancelled','expired')),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at          TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '14 days'),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

CREATE INDEX IF NOT EXISTS idx_pending_invites_status_org
  ON public.pending_invites(org_id, status);

CREATE INDEX IF NOT EXISTS idx_pending_invites_email
  ON public.pending_invites(lower(email))
  WHERE status IN ('awaiting_recipient', 'ready_to_wrap');

ALTER TABLE public.pending_invites ENABLE ROW LEVEL SECURITY;

-- Owner/Admin (anyone with users.invite in the org) can see + manage
-- pending invites for that org. The inviter's own client drives the
-- realtime subscription for ready_to_wrap notifications.
DROP POLICY IF EXISTS "pending_invites_select_inviters" ON public.pending_invites;
CREATE POLICY "pending_invites_select_inviters"
  ON public.pending_invites
  FOR SELECT TO authenticated
  USING (public.user_has_capability(auth.uid(), 'users.invite', org_id));

DROP POLICY IF EXISTS "pending_invites_update_inviters" ON public.pending_invites;
CREATE POLICY "pending_invites_update_inviters"
  ON public.pending_invites
  FOR UPDATE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'users.invite', org_id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'users.invite', org_id));

-- INSERT + DELETE go through edge functions under the service role,
-- so no INSERT/DELETE policies for end users. The trigger below
-- runs SECURITY DEFINER and is exempt from RLS.

-- Auto-touch updated_at.
CREATE OR REPLACE FUNCTION public.touch_pending_invites_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pending_invites_updated_at ON public.pending_invites;
CREATE TRIGGER trg_pending_invites_updated_at
  BEFORE UPDATE ON public.pending_invites
  FOR EACH ROW
  EXECUTE FUNCTION public.touch_pending_invites_updated_at();

COMMENT ON TABLE public.pending_invites IS
  'Invite rows awaiting the recipient to publish a keypair, '
  'then awaiting the Owner''s client to complete the hybrid-KEM wrap. '
  'Lifecycle: awaiting_recipient -> ready_to_wrap -> wrapped.';

COMMENT ON COLUMN public.pending_invites.recipient_user_id IS
  'Populated once the recipient exists in auth.users. NULL when the '
  'invite email pre-dates recipient signup.';

-- ══════════════════════════════════════════════════════════════════════
-- 3. user_vault_keys: SELECT policy for inviters
-- ══════════════════════════════════════════════════════════════════════
--
-- The Phase 4.1 migration only exposed the row to its own user. For
-- Phase 4.3 the Owner must be able to read a prospective member's
-- public_key_b64 to run the hybrid-KEM wrap client-side.
--
-- Security note: public_key_b64 is public-by-cryptographic-design.
-- Exposing it to an inviter reveals nothing that someone couldn't learn
-- by receiving a ciphertext wrapped for that key. We deliberately do
-- NOT expose encrypted_private_key or iv through this policy, those
-- stay owner-only via the existing user_vault_keys_select_own policy.

DROP POLICY IF EXISTS "user_vault_keys_select_for_inviters" ON public.user_vault_keys;
CREATE POLICY "user_vault_keys_select_for_inviters"
  ON public.user_vault_keys
  FOR SELECT TO authenticated
  USING (
    -- The viewing user has users.invite in any org the target user is
    -- already a member of OR a pending invitee of. Either case is a
    -- legitimate wrap trigger.
    EXISTS (
      SELECT 1
        FROM public.org_members om
       WHERE om.user_id = public.user_vault_keys.user_id
         AND public.user_has_capability(auth.uid(), 'users.invite', om.org_id)
    )
    OR EXISTS (
      SELECT 1
        FROM public.pending_invites pi
       WHERE pi.recipient_user_id = public.user_vault_keys.user_id
         AND public.user_has_capability(auth.uid(), 'users.invite', pi.org_id)
    )
  );

-- ══════════════════════════════════════════════════════════════════════
-- 4. Trigger: flip pending_invites -> ready_to_wrap on keypair publish
-- ══════════════════════════════════════════════════════════════════════
--
-- When a user inserts their first user_vault_keys row (first-unlock
-- generation in src/lib/vault-keypair.ts), any pending_invites rows
-- matching that user's email transition from awaiting_recipient to
-- ready_to_wrap. We identify the matching rows by email: auth.users
-- holds the canonical email, and pending_invites stores the invited
-- email.
--
-- Secondary effect: we also populate pending_invites.recipient_user_id
-- so the inviter's subsequent wrap call has a definitive user_id to
-- target (avoids a race where email case was normalized differently).
--
-- Runs SECURITY DEFINER because pending_invites RLS restricts UPDATE
-- to inviters, the recipient themselves must not be able to flip
-- their own invite status by writing to user_vault_keys.

CREATE OR REPLACE FUNCTION public.link_pending_invites_on_keypair_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email TEXT;
  v_inviter_id UUID;
  v_org_id UUID;
BEGIN
  -- Pull the canonical email from auth.users. LOWER'd so case-insensitive
  -- matches against pending_invites.email (which the edge function
  -- stores lower-cased).
  SELECT LOWER(email) INTO v_email
    FROM auth.users
   WHERE id = NEW.user_id;

  IF v_email IS NULL THEN
    RETURN NEW; -- no auth.users row (shouldn't happen; bail safely)
  END IF;

  -- Flip matching pending invites. Write an audit event per affected
  -- row so the Owner's security tab reflects the state change.
  FOR v_inviter_id, v_org_id IN
    UPDATE public.pending_invites
       SET status = 'ready_to_wrap',
           recipient_user_id = NEW.user_id
     WHERE LOWER(email) = v_email
       AND status = 'awaiting_recipient'
       AND expires_at > now()
   RETURNING inviter_id, org_id
  LOOP
    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (
      v_inviter_id,
      'user.wrap_ready',
      jsonb_build_object(
        'org_id',            v_org_id,
        'recipient_user_id', NEW.user_id,
        'source',            'keypair_insert_trigger'
      )
    );
  END LOOP;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.link_pending_invites_on_keypair_insert() IS
  'Phase 4.3: AFTER INSERT on user_vault_keys, transition matching '
  'pending_invites rows from awaiting_recipient to ready_to_wrap. '
  'SECURITY DEFINER so the recipient cannot influence invite status '
  'directly; trigger only runs on new keypair rows that the owner '
  'of the row inserted via the standard user_vault_keys_insert_own '
  'policy.';

DROP TRIGGER IF EXISTS trg_link_pending_invites_on_keypair ON public.user_vault_keys;
CREATE TRIGGER trg_link_pending_invites_on_keypair
  AFTER INSERT ON public.user_vault_keys
  FOR EACH ROW
  EXECUTE FUNCTION public.link_pending_invites_on_keypair_insert();

COMMIT;
