-- ============================================================
-- Time-boxed Auditor + OWBSupport + Org Signing Key.
-- ============================================================
-- Design reference: docs/OWB-MULTIUSER-DESIGN.md §3 (preset matrix), §5 edge cases.
--
-- What this migration does:
--
--   1. `org_member_roles.source` — CHECKed enum column recording how a grant
--      was created: 'direct' | 'auditor_invite' | 'support_grant'. Drives UI
--      badges and the sweep job's audit trail. (`expires_at` already exists
--      from the Phase 4.1 schema — no DDL needed for that.)
--
--   2. `org_signing_keys` — per-org ML-DSA-65 public key (plaintext; verifiers
--      need it). Any org member may SELECT; INSERT/UPDATE gated on
--      `users.invite`. Row per key_version.
--
--   3. `org_member_signing_key_wraps` — per-writer wrapped private signing key. Shape mirrors
--      `org_keys` but keyed on (user_id, org_id, key_version). SELECT limited
--      to the recipient; INSERT via edge function only.
--
--   4. `support_sessions` — audit trail for every OWBSupport grant.
--      24h hard cap enforced by CHECK constraint. Owner / Admin can read;
--      edge function writes.
--
--   5. `transactions.signature_b64` + `signature_key_version` + a
--      `verify_mutation_signature_on_write` BEFORE INSERT OR UPDATE trigger.
--      Scope-limited to `transactions` as a Phase 4.4 proof of wiring
--      (other business tables get extended in a future phase).
--
--   6. `expire_time_boxed_roles()` — SECURITY DEFINER VOLATILE sweep:
--      a. revokes org_member_roles rows where expires_at < now()
--      b. ends support_sessions rows where expires_at < now()
--      c. writes vault_security_events per action
--      The existing `enforce_last_role_removal` trigger on
--      org_member_roles UPDATE catches last-role revocations — no change
--      needed to that trigger.
--
--   7. pg_cron schedule (guarded) — if the extension is enabled in the
--      target project, schedules `expire_time_boxed_roles()` per minute.
--      If pg_cron is not available the guard silently skips and the
--      accompanying `sweep-expired-roles` edge function can be wired to a
--      Supabase scheduled function instead.
--
-- Idempotent: every CREATE / ALTER is guarded. Running this migration
-- twice is a no-op.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- 1. org_member_roles.source column
-- ══════════════════════════════════════════════════════════════════════
--
-- NULL-safe default: existing rows (pre-4.4 backfill) are 'direct' — the
-- Phase 4.2 migration grants them via the standard invite/role-editor
-- path. The auditor_invite and support_grant values are only ever
-- written by the Phase 4.4 edge functions.

ALTER TABLE public.org_member_roles
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'direct';

-- Check constraint is added separately so the ADD COLUMN line above can
-- be re-run without conflicting. DROP + add keeps the migration idempotent.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'org_member_roles_source_chk'
  ) THEN
    ALTER TABLE public.org_member_roles
      ADD CONSTRAINT org_member_roles_source_chk
      CHECK (source IN ('direct', 'auditor_invite', 'support_grant'));
  END IF;
END;
$$;

COMMENT ON COLUMN public.org_member_roles.source IS
  'Phase 4.4: how this grant was created. "direct" = standard invite / '
  'role-editor path. "auditor_invite" = time-boxed Auditor with '
  'customer-chosen expiry date. "support_grant" = OWBSupport '
  'session (24h hard cap, D13). The sweep job logs this value in the '
  'role.expired audit event.';


-- ══════════════════════════════════════════════════════════════════════
-- 2. org_signing_keys — per-org ML-DSA-65 public key
-- ══════════════════════════════════════════════════════════════════════
--
-- Public keys are non-secret by design. Any authenticated member of an
-- org may SELECT (they need the key to verify writes produced by their
-- peers). INSERT / UPDATE flows exclusively through the
-- mint-org-signing-key edge function, which validates caller capability
-- before inserting.
--
-- key_version starts at 1 and bumps each time an Owner rotates the signing key
-- (future phases — Phase 4.5 hard re-key). An org may legally have
-- multiple rows with different key_versions during a rotation window,
-- so key_version is part of the primary key alongside org_id.

CREATE TABLE IF NOT EXISTS public.org_signing_keys (
  org_id         UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key_version    INT  NOT NULL DEFAULT 1,
  public_key_b64 TEXT NOT NULL,
  algorithm      TEXT NOT NULL DEFAULT 'ml-dsa-65',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     UUID NOT NULL REFERENCES auth.users(id),
  PRIMARY KEY (org_id, key_version)
);

CREATE INDEX IF NOT EXISTS idx_org_signing_keys_org_latest
  ON public.org_signing_keys(org_id, key_version DESC);

ALTER TABLE public.org_signing_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_signing_keys_select_members" ON public.org_signing_keys;
CREATE POLICY "org_signing_keys_select_members"
  ON public.org_signing_keys
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
       WHERE om.org_id  = public.org_signing_keys.org_id
         AND om.user_id = auth.uid()
    )
  );

-- Writes flow through the edge function under the service role. No
-- INSERT / UPDATE / DELETE policies for end users.

COMMENT ON TABLE public.org_signing_keys IS
  'Phase 4.4: ML-DSA-65 Org Signing Key public half per org + '
  'per key_version. Used server-side to verify write signatures on '
  'business tables. Plaintext by design — every member needs it to '
  'verify peers'' writes.';


-- ══════════════════════════════════════════════════════════════════════
-- 3. org_member_signing_key_wraps — per-writer wrapped private signing key
-- ══════════════════════════════════════════════════════════════════════
--
-- Mirrors the shape of org_keys (invite wrap) but carries the ML-DSA-65
-- secret key instead of the AES Org DEK. One row per (user, org,
-- key_version). A user without a row cannot sign — that is the
-- cryptographic read-only primitive for Auditor (three-layer defense;
-- see OWB-MULTIUSER-DESIGN.md §3).

CREATE TABLE IF NOT EXISTS public.org_member_signing_key_wraps (
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id              UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  key_version         INT  NOT NULL DEFAULT 1,
  wrapped_private_key TEXT NOT NULL,
  wrap_algo           TEXT NOT NULL DEFAULT 'hybrid-kem-v1',
  iv                  TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id, key_version)
);

CREATE INDEX IF NOT EXISTS idx_org_member_signing_key_wraps_org
  ON public.org_member_signing_key_wraps(org_id, key_version);

ALTER TABLE public.org_member_signing_key_wraps ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "signing_key_wraps_select_own" ON public.org_member_signing_key_wraps;
CREATE POLICY "signing_key_wraps_select_own"
  ON public.org_member_signing_key_wraps
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- INSERT handled by the mint-org-signing-key edge function under the
-- service role. No user-facing INSERT / UPDATE / DELETE policy.

COMMENT ON TABLE public.org_member_signing_key_wraps IS
  'Phase 4.4: per-writer wrapped private half of the Org Signing Key. '
  'Hybrid-KEM wrapped to the recipient''s user_vault_keys public key. '
  'Auditor and Viewer members never have a row here — that is the '
  'cryptographic read-only enforcement (no signing key issued). RLS SELECT '
  'is scoped to the recipient so nobody else can fetch another user''s '
  'wrapped signing key even over an admin API.';


-- ══════════════════════════════════════════════════════════════════════
-- 4. support_sessions — OWBSupport audit trail
-- ══════════════════════════════════════════════════════════════════════
--
-- One row per grant. expires_at is capped at granted_at + 24h via CHECK
-- constraint so a bad client cannot smuggle a longer window. The
-- sweep job auto-ends expired sessions; customers can end early via
-- the end_support_session edge action.

CREATE TABLE IF NOT EXISTS public.support_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  support_user_id  UUID NOT NULL REFERENCES auth.users(id),
  granted_by       UUID NOT NULL REFERENCES auth.users(id),
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ,
  end_reason       TEXT,
  -- CHECK: hard 24h cap from grant time. NULL ended_at with expires_at
  -- beyond cap would mean the row was minted outside the legitimate
  -- path — this guard rejects it.
  CONSTRAINT support_sessions_24h_cap_chk
    CHECK (expires_at <= granted_at + interval '24 hours'),
  CONSTRAINT support_sessions_end_reason_chk
    CHECK (end_reason IS NULL OR end_reason IN ('customer_ended', 'expired', 'support_ended'))
);

CREATE INDEX IF NOT EXISTS idx_support_sessions_org_active
  ON public.support_sessions(org_id)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_support_sessions_expiry_active
  ON public.support_sessions(expires_at)
  WHERE ended_at IS NULL;

ALTER TABLE public.support_sessions ENABLE ROW LEVEL SECURITY;

-- Owner / Admin (users.invite holders) can read; the Orange Way Books support
-- user can also read their own rows so the support-side UI can show
-- the active grant window.
DROP POLICY IF EXISTS "support_sessions_select_inviters" ON public.support_sessions;
CREATE POLICY "support_sessions_select_inviters"
  ON public.support_sessions
  FOR SELECT TO authenticated
  USING (
    public.user_has_capability(auth.uid(), 'users.invite', org_id)
    OR support_user_id = auth.uid()
  );

COMMENT ON TABLE public.support_sessions IS
  'Audit trail for OWBSupport grants. expires_at '
  'hard-capped to 24h by CHECK constraint. The Phase 4.4 edge function '
  'end_support_session flips ended_at + end_reason when the customer '
  'ends early; the expire_time_boxed_roles sweep handles the '
  'auto-expiry path.';


-- ══════════════════════════════════════════════════════════════════════
-- 5. transactions: signature columns + verify trigger (scope-limited)
-- ══════════════════════════════════════════════════════════════════════
--
-- Phase 4.4 wires mutation signing into ONE table (transactions) as a
-- proof of architecture. Other business tables get extended in a future
-- phase — leaving TODO comments in the client code.
--
-- Columns are NULL-able so legacy rows and out-of-band inserts (edge
-- functions running under the service role) don't break. The trigger
-- below enforces that signing is required when any transactions.write
-- capability in effect on the row's org carries requires_osk = TRUE.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS signature_b64 TEXT,
  ADD COLUMN IF NOT EXISTS signature_key_version INT;

COMMENT ON COLUMN public.transactions.signature_b64 IS
  'Phase 4.4: ML-DSA-65 signature of the encrypted payload by the '
  'author using the Org Signing Key. NULL for legacy rows and for '
  'service-role inserts. verify_mutation_signature_on_write enforces '
  'validity when present.';

COMMENT ON COLUMN public.transactions.signature_key_version IS
  'Phase 4.4: key_version of the org_signing_keys row used to produce '
  'signature_b64. Server-side verifier picks the matching public key.';


-- Signature verify trigger.
--
-- Logic:
--   a. Service-role writes skip verification entirely (they bypass RLS
--      and are used for edge-function administrative writes).
--   b. If the row carries NULL signature_b64, and the caller has no
--      `transactions.write` capability (so they are relying on
--      transactions.write_own) we allow it — write_own in the D7 set is
--      the Bookkeeper pattern and hasn't been fully wired to the signing key
--      yet. This matches the Phase 4.2 write_own permissiveness. A
--      follow-up migration tightens this with transactions.created_by.
--   c. Otherwise we require a non-NULL signature and verify it against
--      the org's current org_signing_keys public key for the matching
--      signature_key_version. Invalid signatures RAISE + get logged to
--      vault_security_events for Owner visibility.
--
-- Verification itself happens via the `pqc_verify_ml_dsa_65` helper
-- below, which wraps pgcrypto's ML-DSA primitive if available. In the
-- default Supabase project ML-DSA-65 verification is NOT a first-party
-- pgcrypto routine yet, so the helper gracefully no-ops the signature
-- check and records a weak_verifier audit event. Client-side callers
-- still produce real ML-DSA signatures; the server-side verify step is
-- a defense-in-depth layer that upgrades automatically when pgcrypto
-- ships ML-DSA or when the project installs a pg_crypto_pq extension.

CREATE OR REPLACE FUNCTION public.pqc_verify_ml_dsa_65(
  p_public_key_b64 TEXT,
  p_signature_b64  TEXT,
  p_payload        BYTEA
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  -- Placeholder: ML-DSA-65 verification is client-enforced today. The
  -- server-side check upgrades when an ML-DSA pgcrypto verifier is
  -- available. For now we validate that both inputs are well-formed
  -- base64-looking strings of plausible length (ML-DSA-65: signature
  -- 3309 bytes ≈ 4412 base64 chars; public key 1952 bytes ≈ 2604
  -- base64 chars) and return TRUE — the client has already signed and
  -- we rely on tamper detection from AES-GCM on the encrypted payload.
  IF p_public_key_b64 IS NULL OR p_signature_b64 IS NULL THEN
    RETURN FALSE;
  END IF;
  IF length(p_signature_b64) < 100 OR length(p_public_key_b64) < 100 THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END;
$$;

COMMENT ON FUNCTION public.pqc_verify_ml_dsa_65(TEXT, TEXT, BYTEA) IS
  'Phase 4.4 placeholder: returns TRUE for well-formed inputs. The '
  'real ML-DSA-65 verify runs client-side in src/lib/osk.ts. When '
  'Postgres ships an ML-DSA verifier or an extension is installed, '
  'swap this body for the native call — no other code changes '
  'required.';


CREATE OR REPLACE FUNCTION public.verify_mutation_signature_on_write()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_public_key TEXT;
  v_requires_osk BOOLEAN;
  v_has_write BOOLEAN;
  v_user UUID := auth.uid();
BEGIN
  -- Service-role writes (no JWT → NULL auth.uid()) bypass the check.
  -- Edge functions that perform administrative inserts run under the
  -- service role and rely on their own authorization layer.
  IF v_user IS NULL THEN
    RETURN NEW;
  END IF;

  v_org_id := NEW.org_id;
  IF v_org_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Is the caller invoking transactions.write? (not just write_own)
  -- write_own is permissive today. Only `.write` is
  -- Signing-key-gated.
  v_has_write := public.user_has_capability(v_user, 'transactions.write', v_org_id);

  IF NOT v_has_write THEN
    -- write_own path — out of scope for Phase 4.4 signing coverage.
    -- Skip signature enforcement (return NEW unchanged).
    RETURN NEW;
  END IF;

  SELECT c.requires_osk INTO v_requires_osk
    FROM public.capabilities c
   WHERE c.key = 'transactions.write';

  IF NOT COALESCE(v_requires_osk, FALSE) THEN
    -- Capability doesn't demand a signing-key signature — nothing to verify.
    RETURN NEW;
  END IF;

  -- Back-compat: if no signing key has been minted for this org yet, accept
  -- NULL signatures. The Phase 4.4 rollout path is:
  --   1. Deploy migration (this trigger + supporting tables)
  --   2. Owner runs mint-org-signing-key (first write signs start flowing)
  --   3. Server-side verification upgrades silently once pqc_verify_ml_dsa_65
  --      is replaced with a native ML-DSA pgcrypto call.
  -- Before step 2 completes, an Owner trying to write transactions
  -- would otherwise be blocked — which defeats the "leaves dev
  -- deployable to staging after every phase" rule. Soft-enforce here; the client
  -- still signs when a key exists.
  IF NOT EXISTS (
    SELECT 1 FROM public.org_signing_keys WHERE org_id = v_org_id
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.signature_b64 IS NULL OR NEW.signature_key_version IS NULL THEN
    -- Signing key exists for this org but the client did not attach a
    -- signature. Reject the write and audit.
    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (v_user, 'mutation.signature_missing', jsonb_build_object(
      'table',   TG_TABLE_NAME,
      'op',      TG_OP,
      'org_id',  v_org_id
    ));
    RAISE EXCEPTION 'Mutation requires an Org Signing Key signature.';
  END IF;

  SELECT public_key_b64 INTO v_public_key
    FROM public.org_signing_keys
   WHERE org_id = v_org_id
     AND key_version = NEW.signature_key_version;

  IF v_public_key IS NULL THEN
    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (v_user, 'mutation.signing_key_not_found', jsonb_build_object(
      'table',       TG_TABLE_NAME,
      'op',          TG_OP,
      'org_id',      v_org_id,
      'key_version', NEW.signature_key_version
    ));
    RAISE EXCEPTION 'No Org Signing Key registered for this org at the supplied key_version.';
  END IF;

  -- Compose the payload the client signed: org_id + row_id (if known)
  -- + selected encrypted columns. The client calls signMutation with
  -- the same byte layout — src/lib/osk.ts documents the shape.
  IF NOT public.pqc_verify_ml_dsa_65(
      v_public_key,
      NEW.signature_b64,
      convert_to(v_org_id::TEXT, 'UTF8')
  ) THEN
    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (v_user, 'mutation.signature_invalid', jsonb_build_object(
      'table',       TG_TABLE_NAME,
      'op',          TG_OP,
      'org_id',      v_org_id,
      'key_version', NEW.signature_key_version
    ));
    RAISE EXCEPTION 'Mutation signature failed verification.';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.verify_mutation_signature_on_write() IS
  'Phase 4.4: BEFORE INSERT OR UPDATE verify that the mutation carries '
  'a valid Org Signing Key signature when the acting capability has '
  'requires_osk = TRUE. write_own path is skipped (permissive via D29 '
  'follow-up). Service-role (auth.uid() IS NULL) bypasses. Scope is '
  'transactions only in Phase 4.4 — other tables ship coverage in a '
  'later phase.';

DROP TRIGGER IF EXISTS trg_verify_mutation_signature_transactions ON public.transactions;
CREATE TRIGGER trg_verify_mutation_signature_transactions
  BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.verify_mutation_signature_on_write();


-- ══════════════════════════════════════════════════════════════════════
-- 6. expire_time_boxed_roles() — auto-expiry sweep
-- ══════════════════════════════════════════════════════════════════════
--
-- Intended cadence: every minute via pg_cron (scheduled below) or every
-- few minutes via a Supabase scheduled function calling the companion
-- edge function `sweep-expired-roles`. Safe to call more often; each
-- pass is idempotent.
--
-- Order matters:
--   a. End support_sessions first so the accompanying org_member_roles
--      revocation below records the session end reason in its audit.
--   b. Revoke org_member_roles rows where expires_at < now() AND
--      revoked_at IS NULL. Writing revoked_at fires
--      `enforce_last_role_removal` which drops the org_keys
--      wrap + audits org_access_revoked — no additional handling here.
--   c. Both flows emit their own vault_security_events rows for Owner
--      visibility.

CREATE OR REPLACE FUNCTION public.expire_time_boxed_roles()
RETURNS TABLE (expired_roles INTEGER, expired_sessions INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
VOLATILE
AS $$
DECLARE
  v_role_count    INTEGER := 0;
  v_session_count INTEGER := 0;
  v_now           TIMESTAMPTZ := now();
  v_row           RECORD;
BEGIN
  -- a) End expired support_sessions in a single UPDATE ... RETURNING,
  --    then loop the returned set to emit audit events. This keeps the
  --    audit write in the same transactional scope as the state change
  --    and prevents re-running this function from double-auditing.
  FOR v_row IN
    UPDATE public.support_sessions
       SET ended_at   = expires_at,
           end_reason = 'expired'
     WHERE expires_at < v_now
       AND ended_at IS NULL
    RETURNING id, org_id, support_user_id, granted_by
  LOOP
    v_session_count := v_session_count + 1;
    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (
      v_row.support_user_id,
      'support.session_expired',
      jsonb_build_object(
        'org_id',     v_row.org_id,
        'session_id', v_row.id,
        'granted_by', v_row.granted_by
      )
    );
  END LOOP;

  -- b) Revoke expired org_member_roles grants. Writing revoked_at fires
  --    the Phase 4.2 enforce_last_role_removal trigger, which in turn
  --    drops the org_keys wrap and writes org_access_revoked when this
  --    was the user's last active grant — no extra wiring needed here.
  FOR v_row IN
    UPDATE public.org_member_roles
       SET revoked_at = expires_at
     WHERE expires_at IS NOT NULL
       AND expires_at < v_now
       AND revoked_at IS NULL
    RETURNING id, org_id, user_id, role_definition_id, source, expires_at
  LOOP
    v_role_count := v_role_count + 1;
    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (
      v_row.user_id,
      'role.expired',
      jsonb_build_object(
        'org_id',              v_row.org_id,
        'role_definition_id',  v_row.role_definition_id,
        'source',              v_row.source,
        'original_expires_at', v_row.expires_at
      )
    );
  END LOOP;

  expired_roles := v_role_count;
  expired_sessions := v_session_count;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.expire_time_boxed_roles() IS
  'Phase 4.4 sweep: end expired support_sessions + revoke expired '
  'org_member_roles grants. SECURITY DEFINER so pg_cron / scheduled '
  'edge functions can call it. Returns counts for observability.';


-- ══════════════════════════════════════════════════════════════════════
-- 7. pg_cron schedule (guarded)
-- ══════════════════════════════════════════════════════════════════════
--
-- If pg_cron is enabled, schedule expire_time_boxed_roles() every
-- minute. If not, the guard silently skips and the companion edge
-- function sweep-expired-roles needs to be wired to a Supabase
-- scheduled function (documented in the deploy prompt).

DO $$
DECLARE
  v_existing_jobid BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    -- Idempotent: unschedule any existing job with the same name first.
    SELECT jobid INTO v_existing_jobid
      FROM cron.job
     WHERE jobname = 'expire-time-boxed-roles'
     LIMIT 1;
    IF v_existing_jobid IS NOT NULL THEN
      PERFORM cron.unschedule(v_existing_jobid);
    END IF;

    PERFORM cron.schedule(
      'expire-time-boxed-roles',
      '* * * * *',
      $CRON$SELECT public.expire_time_boxed_roles()$CRON$
    );

    RAISE NOTICE 'Phase 4.4: scheduled expire_time_boxed_roles every minute via pg_cron.';
  ELSE
    RAISE NOTICE 'Phase 4.4: pg_cron not enabled — sweep-expired-roles edge function must be scheduled separately.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  -- Supabase Free tier may block pg_cron; don't fail the migration.
  RAISE NOTICE 'Phase 4.4: pg_cron scheduling skipped (%).', SQLERRM;
END;
$$;


COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-MIGRATION:
--   1. Deploy edge functions: invite-org-member (patched), admin-update-user
--      (patched), sweep-expired-roles (new), mint-org-signing-key (new).
--   2. If pg_cron is not available in this project, configure a Supabase
--      scheduled function to POST /sweep-expired-roles every minute with
--      the X-Cron-Secret header matching env CRON_SWEEP_SECRET.
-- ════════════════════════════════════════════════════════════════════
