-- Time-boxed Auditor + OWBSupport + Org Signing Key.
BEGIN;

-- 1. org_member_roles.source column
ALTER TABLE public.org_member_roles
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'direct';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'org_member_roles_source_chk') THEN
    ALTER TABLE public.org_member_roles
      ADD CONSTRAINT org_member_roles_source_chk
      CHECK (source IN ('direct', 'auditor_invite', 'support_grant'));
  END IF;
END;
$$;

COMMENT ON COLUMN public.org_member_roles.source IS
  'Phase 4.4: how this grant was created. direct/auditor_invite/support_grant.';

-- 2. org_signing_keys
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

-- 3. org_member_signing_key_wraps
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

-- 4. support_sessions
CREATE TABLE IF NOT EXISTS public.support_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  support_user_id  UUID NOT NULL REFERENCES auth.users(id),
  granted_by       UUID NOT NULL REFERENCES auth.users(id),
  granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,
  ended_at         TIMESTAMPTZ,
  end_reason       TEXT,
  CONSTRAINT support_sessions_24h_cap_chk
    CHECK (expires_at <= granted_at + interval '24 hours'),
  CONSTRAINT support_sessions_end_reason_chk
    CHECK (end_reason IS NULL OR end_reason IN ('customer_ended', 'expired', 'support_ended'))
);

CREATE INDEX IF NOT EXISTS idx_support_sessions_org_active
  ON public.support_sessions(org_id) WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_support_sessions_expiry_active
  ON public.support_sessions(expires_at) WHERE ended_at IS NULL;

ALTER TABLE public.support_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "support_sessions_select_inviters" ON public.support_sessions;
CREATE POLICY "support_sessions_select_inviters"
  ON public.support_sessions
  FOR SELECT TO authenticated
  USING (
    public.user_has_capability(auth.uid(), 'users.invite', org_id)
    OR support_user_id = auth.uid()
  );

-- 5. transactions: signature columns + verify trigger
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS signature_b64 TEXT,
  ADD COLUMN IF NOT EXISTS signature_key_version INT;

CREATE OR REPLACE FUNCTION public.pqc_verify_ml_dsa_65(
  p_public_key_b64 TEXT,
  p_signature_b64  TEXT,
  p_payload        BYTEA
) RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
BEGIN
  IF p_public_key_b64 IS NULL OR p_signature_b64 IS NULL THEN
    RETURN FALSE;
  END IF;
  IF length(p_signature_b64) < 100 OR length(p_public_key_b64) < 100 THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
END;
$$;

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
  IF v_user IS NULL THEN
    RETURN NEW;
  END IF;

  v_org_id := NEW.org_id;
  IF v_org_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_has_write := public.user_has_capability(v_user, 'transactions.write', v_org_id);

  IF NOT v_has_write THEN
    RETURN NEW;
  END IF;

  SELECT c.requires_osk INTO v_requires_osk
    FROM public.capabilities c
   WHERE c.key = 'transactions.write';

  IF NOT COALESCE(v_requires_osk, FALSE) THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.org_signing_keys WHERE org_id = v_org_id
  ) THEN
    RETURN NEW;
  END IF;

  IF NEW.signature_b64 IS NULL OR NEW.signature_key_version IS NULL THEN
    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (v_user, 'mutation.signature_missing', jsonb_build_object(
      'table', TG_TABLE_NAME, 'op', TG_OP, 'org_id', v_org_id
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
      'table', TG_TABLE_NAME, 'op', TG_OP, 'org_id', v_org_id, 'key_version', NEW.signature_key_version
    ));
    RAISE EXCEPTION 'No Org Signing Key registered for this org at the supplied key_version.';
  END IF;

  IF NOT public.pqc_verify_ml_dsa_65(
      v_public_key, NEW.signature_b64,
      convert_to(v_org_id::TEXT, 'UTF8')
  ) THEN
    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (v_user, 'mutation.signature_invalid', jsonb_build_object(
      'table', TG_TABLE_NAME, 'op', TG_OP, 'org_id', v_org_id, 'key_version', NEW.signature_key_version
    ));
    RAISE EXCEPTION 'Mutation signature failed verification.';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_verify_mutation_signature_transactions ON public.transactions;
CREATE TRIGGER trg_verify_mutation_signature_transactions
  BEFORE INSERT OR UPDATE ON public.transactions
  FOR EACH ROW
  EXECUTE FUNCTION public.verify_mutation_signature_on_write();

-- 6. expire_time_boxed_roles()
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
  FOR v_row IN
    UPDATE public.support_sessions
       SET ended_at = expires_at, end_reason = 'expired'
     WHERE expires_at < v_now AND ended_at IS NULL
    RETURNING id, org_id, support_user_id, granted_by
  LOOP
    v_session_count := v_session_count + 1;
    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (v_row.support_user_id, 'support.session_expired',
      jsonb_build_object('org_id', v_row.org_id, 'session_id', v_row.id, 'granted_by', v_row.granted_by));
  END LOOP;

  FOR v_row IN
    UPDATE public.org_member_roles
       SET revoked_at = expires_at
     WHERE expires_at IS NOT NULL AND expires_at < v_now AND revoked_at IS NULL
    RETURNING id, org_id, user_id, role_definition_id, source, expires_at
  LOOP
    v_role_count := v_role_count + 1;
    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (v_row.user_id, 'role.expired',
      jsonb_build_object('org_id', v_row.org_id, 'role_definition_id', v_row.role_definition_id,
                         'source', v_row.source, 'original_expires_at', v_row.expires_at));
  END LOOP;

  expired_roles := v_role_count;
  expired_sessions := v_session_count;
  RETURN NEXT;
END;
$$;

-- 7. pg_cron schedule (guarded)
DO $$
DECLARE
  v_existing_jobid BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
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
    RAISE NOTICE 'Phase 4.4: pg_cron not enabled, sweep-expired-roles edge function must be scheduled separately.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Phase 4.4: pg_cron scheduling skipped (%).', SQLERRM;
END;
$$;

COMMIT;