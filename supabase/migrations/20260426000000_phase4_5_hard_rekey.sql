-- ============================================================
-- Hard re-key: resumable rotation jobs, version
-- columns on business tables, rollback window, auto-purge.
-- ============================================================
-- Design reference: docs/OWB-MULTIUSER-DESIGN.md (hard re-key sections).
--
-- What Phase 4.5 does:
--
--   Phase 4.3 wraps a PLACEHOLDER random DEK because the org wrap layer doesn't yet have
--   a shared org DEK, today all encryption uses per-user-per-org MEK.
--   Phase 4.5 establishes the real shared org DEK, re-encrypts every
--   existing business row under it, updates every invitee wrap, and
--   supports rotating DEK + signing key together on-demand.
--
-- What this migration adds:
--
--   1. `key_rotation_jobs`, resumable job state machine. One active
--      job per org at a time. Tracks row counts, error log, rollback
--      deadline.
--   2. `active_key_versions`, one row per org; points at the CURRENT
--      active DEK + signing key key_version. Rollback is a single UPDATE.
--   3. `org_keys.is_placeholder`, marks Phase 4.3 placeholder wraps so
--      Phase 4.5 can migrate them without touching real wraps.
--   4. `org_keys.key_version` column (matches existing `key_version=1`
--      default), ensuring lookups can target a specific version.
--   5. `dek_key_version INT NOT NULL DEFAULT 1` on every encrypted
--      business table. Row-level rekey bumps this atomically with the
--      new ciphertext.
--   6. `user_last_seen_key_versions`, force-refresh cookie table. UI
--      compares current active versions vs last seen; banner if newer.
--   7. `advance_rotation_job()`, SECURITY DEFINER helper for legal
--      state transitions + audit events.
--   8. `purge_expired_old_key_wraps()`, SECURITY DEFINER VOLATILE sweep
--      that clears old wrap rows after the 30-day rollback window lapses.
--   9. pg_cron schedule (guarded; same pattern as Phase 4.4 sweep).
--
-- Idempotent: every CREATE / ALTER is guarded. Running twice is a no-op.
--
-- Safety notes:
--   - All existing rows keep dek_key_version = 1 (the default).
--   - The Phase 4.3 placeholder wrap behavior remains correct for orgs
--     that don't have an active_key_versions row yet.
--   - Transaction signing from Phase 4.4: the verify trigger must accept
--     any signature_key_version <= current_active. Phase 4.5 does NOT
--     alter that trigger, `org_signing_keys` rows at both old and new
--     key_versions coexist during a rotation, and the existing verifier
--     looks up by (org_id, key_version) which works for either.

BEGIN;

-- ══════════════════════════════════════════════════════════════════════
-- 1. key_rotation_jobs, resumable job state machine
-- ══════════════════════════════════════════════════════════════════════
--
-- Lifecycle:
--   pending            → job inserted, nothing committed yet
--   generating_keys    → client is generating new DEK + new signing key
--   wrapping_members   → client is inserting new wraps (additive; old
--                        wraps still valid under active_key_versions)
--   rekeying_rows      → client is paging business tables in batches of
--                        500, decrypting with old DEK and re-encrypting
--                        with new DEK; row.dek_key_version bumped atom-
--                        ically with the new ciphertext
--   finalizing         → client called finalize-rekey; active_key_versions
--                        is atomically flipped to the new versions
--   complete           → success; rollback_expires_at populated 30 days
--                        out so emergency rollback is possible
--   aborted            → client aborted mid-job; new wraps + partially-
--                        updated rows were rolled back by the abort
--                        handler; active_key_versions unchanged
--   rolled_back        → emergency rollback during rollback window;
--                        active_key_versions reverted to previous
--                        versions

CREATE TABLE IF NOT EXISTS public.key_rotation_jobs (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  status                     TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN (
                                'pending',
                                'generating_keys',
                                'wrapping_members',
                                'rekeying_rows',
                                'finalizing',
                                'complete',
                                'aborted',
                                'rolled_back'
                              )),
  trigger_type               TEXT NOT NULL
                              CHECK (trigger_type IN ('first_time_setup','manual','post_revoke')),
  started_by                 UUID NOT NULL REFERENCES auth.users(id),
  started_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at               TIMESTAMPTZ,
  new_dek_key_version        INT  NOT NULL,
  new_osk_key_version        INT  NOT NULL,
  previous_dek_key_version   INT,
  previous_osk_key_version   INT,
  rollback_expires_at        TIMESTAMPTZ,
  rows_total                 INT  NOT NULL DEFAULT 0,
  rows_processed             INT  NOT NULL DEFAULT 0,
  rows_failed                INT  NOT NULL DEFAULT 0,
  abort_reason               TEXT,
  error_log                  JSONB NOT NULL DEFAULT '[]'::jsonb
);

-- Only ONE active job per org. Completed / aborted / rolled_back jobs
-- stay around for history and rollback.
CREATE UNIQUE INDEX IF NOT EXISTS ux_key_rotation_jobs_single_active
  ON public.key_rotation_jobs(org_id)
  WHERE status NOT IN ('complete','aborted','rolled_back');

CREATE INDEX IF NOT EXISTS idx_key_rotation_jobs_org_started
  ON public.key_rotation_jobs(org_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_key_rotation_jobs_rollback_window
  ON public.key_rotation_jobs(rollback_expires_at)
  WHERE status = 'complete' AND rollback_expires_at IS NOT NULL;

ALTER TABLE public.key_rotation_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "key_rotation_jobs_select_inviters" ON public.key_rotation_jobs;
CREATE POLICY "key_rotation_jobs_select_inviters"
  ON public.key_rotation_jobs
  FOR SELECT TO authenticated
  USING (public.user_has_capability(auth.uid(), 'users.invite', org_id));

-- Non-inviter org members also need SELECT so the maintenance banner
-- can react to jobs in-flight. This exposes status + stage + progress
-- counts, no secret material.
DROP POLICY IF EXISTS "key_rotation_jobs_select_members" ON public.key_rotation_jobs;
CREATE POLICY "key_rotation_jobs_select_members"
  ON public.key_rotation_jobs
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
       WHERE om.org_id = public.key_rotation_jobs.org_id
         AND om.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "key_rotation_jobs_insert_inviters" ON public.key_rotation_jobs;
CREATE POLICY "key_rotation_jobs_insert_inviters"
  ON public.key_rotation_jobs
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_capability(auth.uid(), 'users.invite', org_id));

DROP POLICY IF EXISTS "key_rotation_jobs_update_inviters" ON public.key_rotation_jobs;
CREATE POLICY "key_rotation_jobs_update_inviters"
  ON public.key_rotation_jobs
  FOR UPDATE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'users.invite', org_id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'users.invite', org_id));

COMMENT ON TABLE public.key_rotation_jobs IS
  'Phase 4.5: resumable rotation job state machine. One active job per '
  'org. After status=complete, rollback_expires_at is 30 days out and '
  'emergency rollback is allowed during that window.';


-- ══════════════════════════════════════════════════════════════════════
-- 2. active_key_versions, current active pointer for DEK + signing key
-- ══════════════════════════════════════════════════════════════════════
--
-- Exactly one row per org. Updated atomically by finalize-rekey (forward)
-- and by abort-rekey (rollback). Client reads this on load; compares to
-- `user_last_seen_key_versions` to decide if a reload banner is needed.

CREATE TABLE IF NOT EXISTS public.active_key_versions (
  org_id                   UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  active_dek_key_version   INT NOT NULL DEFAULT 1,
  active_osk_key_version   INT NOT NULL DEFAULT 1,
  last_rotated_at          TIMESTAMPTZ
);

ALTER TABLE public.active_key_versions ENABLE ROW LEVEL SECURITY;

-- Any org member reads the active pointer (needed to decrypt with the
-- right key_version and to detect "someone else rotated keys" state).
DROP POLICY IF EXISTS "active_key_versions_select_members" ON public.active_key_versions;
CREATE POLICY "active_key_versions_select_members"
  ON public.active_key_versions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
       WHERE om.org_id = public.active_key_versions.org_id
         AND om.user_id = auth.uid()
    )
  );

-- Writes go through the finalize-rekey / abort-rekey edge functions
-- under the service role. No end-user UPDATE / INSERT / DELETE policy.

-- Backfill: one row per existing organization with key_version=1.
INSERT INTO public.active_key_versions (org_id, active_dek_key_version, active_osk_key_version)
SELECT o.id, 1, 1
  FROM public.organizations o
 WHERE NOT EXISTS (
   SELECT 1 FROM public.active_key_versions a WHERE a.org_id = o.id
 );

COMMENT ON TABLE public.active_key_versions IS
  'Current active DEK + signing key key_version per org. Atomically '
  'flipped by finalize-rekey; reverted by emergency rollback within the '
  '30-day window. Client compares to user_last_seen_key_versions to '
  'decide if a reload banner is needed after peer rotation.';


-- ══════════════════════════════════════════════════════════════════════
-- 3. org_keys: is_placeholder + key_version columns
-- ══════════════════════════════════════════════════════════════════════
--
-- Phase 4.3 sets is_placeholder=TRUE when wrapping a random placeholder
-- DEK. Phase 4.5 first-time-setup swaps those for real DEK wraps (is
-- _placeholder=FALSE) and the migration logic uses this column to decide
-- which orgs need first-time-setup versus manual rotation.
--
-- key_version already exists from the Phase 4.3 org_keys extension
-- (see 20260424000000_phase4_3_invites.sql) via the wrap_algo column
-- insert. This guard makes the intent explicit and ensures presence.

ALTER TABLE public.org_keys
  ADD COLUMN IF NOT EXISTS is_placeholder BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.org_keys
  ADD COLUMN IF NOT EXISTS key_version INT NOT NULL DEFAULT 1;

-- Back-fill: any org_keys row whose wrap_algo='v3-self-mek' is a pre-
-- Phase-4.3 self-wrap (not a placeholder). Rows with wrap_algo=
-- 'hybrid-x25519-mlkem768' written between Phase 4.3 and Phase 4.5
-- SHOULD be flagged as placeholder since they wrap the random placeholder
-- DEK from generatePlaceholderOrgDek(). The edge function patched below
-- writes is_placeholder explicitly on every future insert.
UPDATE public.org_keys
   SET is_placeholder = TRUE
 WHERE wrap_algo = 'hybrid-x25519-mlkem768'
   AND is_placeholder = FALSE
   AND key_version = 1;

COMMENT ON COLUMN public.org_keys.is_placeholder IS
  'Phase 4.5: TRUE for Phase 4.3 placeholder wraps (random DEK, no real '
  'shared-org-DEK semantics). Phase 4.5 first-time-setup migrates these '
  'to real DEK wraps (FALSE).';

COMMENT ON COLUMN public.org_keys.key_version IS
  'Phase 4.5: the DEK key_version this wrap targets. Multiple versions '
  'coexist during a rotation: old version stays readable for the 30-day '
  'rollback window until purge_expired_old_key_wraps() clears it.';


-- ══════════════════════════════════════════════════════════════════════
-- 4. Business tables: add dek_key_version column
-- ══════════════════════════════════════════════════════════════════════
--
-- Every encrypted business table gets a `dek_key_version INT NOT NULL
-- DEFAULT 1` column. Row-level rekey bumps this atomically with the new
-- ciphertext. The client's decrypt path reads this column to pick the
-- matching DEK (during rotation some rows are on old, some on new).

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'transactions',
    'journal_entries',
    'journal_entry_lines',
    'contacts',
    'legacy_account_map',
    'payment_requests',
    'accounts',
    'organizations',
    'org_settings',
    'attachments',
    'transaction_metadata',
    'account_metadata'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (
      SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = t
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS dek_key_version INT NOT NULL DEFAULT 1',
        t
      );
    ELSE
      RAISE NOTICE 'Phase 4.5: table public.% does not exist, skipping dek_key_version add', t;
    END IF;
  END LOOP;
END;
$$;


-- ══════════════════════════════════════════════════════════════════════
-- 5. user_last_seen_key_versions, force-refresh cookie table
-- ══════════════════════════════════════════════════════════════════════
--
-- Updated on successful unlock. Client reads on every load; if active
-- versions > last seen, UI shows "Your team rotated keys. Reload?"
-- banner. RLS restricts reads and writes to the user themselves.

CREATE TABLE IF NOT EXISTS public.user_last_seen_key_versions (
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id         UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  dek_key_version INT NOT NULL DEFAULT 1,
  osk_key_version INT NOT NULL DEFAULT 1,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, org_id)
);

ALTER TABLE public.user_last_seen_key_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_last_seen_select_own" ON public.user_last_seen_key_versions;
CREATE POLICY "user_last_seen_select_own"
  ON public.user_last_seen_key_versions
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "user_last_seen_insert_own" ON public.user_last_seen_key_versions;
CREATE POLICY "user_last_seen_insert_own"
  ON public.user_last_seen_key_versions
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "user_last_seen_update_own" ON public.user_last_seen_key_versions;
CREATE POLICY "user_last_seen_update_own"
  ON public.user_last_seen_key_versions
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE public.user_last_seen_key_versions IS
  'Per-user last-seen active DEK + signing key versions. Client '
  'compares to active_key_versions on every load to detect peer-initiated '
  'rotation and prompt the user to reload.';


-- ══════════════════════════════════════════════════════════════════════
-- 6. advance_rotation_job(), legal-state-transition helper
-- ══════════════════════════════════════════════════════════════════════
--
-- Validates state transitions and writes a `rekey.status_changed` audit
-- event. Raises when an illegal transition is requested.

CREATE OR REPLACE FUNCTION public.advance_rotation_job(
  p_job_id     UUID,
  p_new_status TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job         RECORD;
  v_allowed     BOOLEAN := FALSE;
BEGIN
  SELECT * INTO v_job
    FROM public.key_rotation_jobs
   WHERE id = p_job_id
   FOR UPDATE;

  IF v_job IS NULL THEN
    RAISE EXCEPTION 'Rotation job % not found', p_job_id;
  END IF;

  -- Legal transitions. Any state -> aborted is always allowed. complete
  -- -> rolled_back only allowed during rollback window.
  IF p_new_status = 'aborted' THEN
    v_allowed := v_job.status NOT IN ('complete','aborted','rolled_back');
  ELSIF p_new_status = 'rolled_back' THEN
    v_allowed := v_job.status = 'complete'
             AND v_job.rollback_expires_at IS NOT NULL
             AND v_job.rollback_expires_at > now();
  ELSIF v_job.status = 'pending'          AND p_new_status = 'generating_keys'  THEN v_allowed := TRUE;
  ELSIF v_job.status = 'generating_keys'  AND p_new_status = 'wrapping_members' THEN v_allowed := TRUE;
  ELSIF v_job.status = 'wrapping_members' AND p_new_status = 'rekeying_rows'    THEN v_allowed := TRUE;
  ELSIF v_job.status = 'rekeying_rows'    AND p_new_status = 'finalizing'       THEN v_allowed := TRUE;
  ELSIF v_job.status = 'finalizing'       AND p_new_status = 'complete'         THEN v_allowed := TRUE;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'Illegal rotation-job transition: % -> %', v_job.status, p_new_status;
  END IF;

  UPDATE public.key_rotation_jobs
     SET status       = p_new_status,
         completed_at = CASE WHEN p_new_status IN ('complete','aborted','rolled_back')
                             THEN now() ELSE completed_at END
   WHERE id = p_job_id;

  INSERT INTO public.vault_security_events (user_id, event, metadata)
  VALUES (
    v_job.started_by,
    'rekey.status_changed',
    jsonb_build_object(
      'job_id',      p_job_id,
      'org_id',      v_job.org_id,
      'from_status', v_job.status,
      'to_status',   p_new_status,
      'trigger',     v_job.trigger_type
    )
  );
END;
$$;

COMMENT ON FUNCTION public.advance_rotation_job(UUID, TEXT) IS
  'Phase 4.5: validate + apply a key_rotation_jobs state transition. '
  'Writes a rekey.status_changed audit event on every legal transition.';


-- ══════════════════════════════════════════════════════════════════════
-- 7. purge_expired_old_key_wraps(), 30-day rollback cleanup sweep
-- ══════════════════════════════════════════════════════════════════════
--
-- For every completed job whose rollback_expires_at < now(): delete the
-- previous-version wraps (org_keys + org_member_signing_key_wraps + org_signing
-- _keys at previous_osk_key_version), then clear the previous_*_key_
-- version fields + rollback_expires_at on the job row so the sweep is
-- idempotent.

CREATE OR REPLACE FUNCTION public.purge_expired_old_key_wraps()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
VOLATILE
AS $$
DECLARE
  v_purged_count INTEGER := 0;
  v_job          RECORD;
BEGIN
  FOR v_job IN
    SELECT id, org_id, previous_dek_key_version, previous_osk_key_version, started_by
      FROM public.key_rotation_jobs
     WHERE status = 'complete'
       AND rollback_expires_at IS NOT NULL
       AND rollback_expires_at < now()
       AND (previous_dek_key_version IS NOT NULL OR previous_osk_key_version IS NOT NULL)
  LOOP
    IF v_job.previous_dek_key_version IS NOT NULL THEN
      DELETE FROM public.org_keys
       WHERE org_id = v_job.org_id
         AND key_version = v_job.previous_dek_key_version;
    END IF;

    IF v_job.previous_osk_key_version IS NOT NULL THEN
      DELETE FROM public.org_member_signing_key_wraps
       WHERE org_id = v_job.org_id
         AND key_version = v_job.previous_osk_key_version;

      DELETE FROM public.org_signing_keys
       WHERE org_id = v_job.org_id
         AND key_version = v_job.previous_osk_key_version;
    END IF;

    UPDATE public.key_rotation_jobs
       SET previous_dek_key_version = NULL,
           previous_osk_key_version = NULL,
           rollback_expires_at      = NULL
     WHERE id = v_job.id;

    INSERT INTO public.vault_security_events (user_id, event, metadata)
    VALUES (
      v_job.started_by,
      'rekey.old_wraps_purged',
      jsonb_build_object(
        'job_id',                   v_job.id,
        'org_id',                   v_job.org_id,
        'purged_dek_key_version',   v_job.previous_dek_key_version,
        'purged_osk_key_version',   v_job.previous_osk_key_version
      )
    );

    v_purged_count := v_purged_count + 1;
  END LOOP;

  RETURN v_purged_count;
END;
$$;

COMMENT ON FUNCTION public.purge_expired_old_key_wraps() IS
  'Phase 4.5: clear previous-version DEK + signing-key wraps once a rotation '
  'job is past its 30-day rollback window. Idempotent, safe to run '
  'daily or on-demand.';


-- ══════════════════════════════════════════════════════════════════════
-- 8. pg_cron schedule (guarded, same pattern as Phase 4.4 sweep)
-- ══════════════════════════════════════════════════════════════════════
--
-- If pg_cron is enabled, schedule the purge daily at 03:17 UTC (random
-- off-peak minute to avoid bunching with other scheduled jobs). If the
-- extension is not available the guard silently skips; deploy
-- prompt documents how to wire a scheduled function instead.

DO $$
DECLARE
  v_existing_jobid BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    SELECT jobid INTO v_existing_jobid
      FROM cron.job
     WHERE jobname = 'purge-expired-old-key-wraps'
     LIMIT 1;
    IF v_existing_jobid IS NOT NULL THEN
      PERFORM cron.unschedule(v_existing_jobid);
    END IF;

    PERFORM cron.schedule(
      'purge-expired-old-key-wraps',
      '17 3 * * *',
      $CRON$SELECT public.purge_expired_old_key_wraps()$CRON$
    );

    RAISE NOTICE 'Phase 4.5: scheduled purge_expired_old_key_wraps daily at 03:17 UTC via pg_cron.';
  ELSE
    RAISE NOTICE 'Phase 4.5: pg_cron not enabled, schedule purge-expired-old-key-wraps via Supabase scheduled function.';
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Phase 4.5: pg_cron scheduling skipped (%).', SQLERRM;
END;
$$;


COMMIT;

-- ════════════════════════════════════════════════════════════════════
-- POST-MIGRATION:
--   1. Deploy edge functions: start-rekey-job (new), rekey-batch (new),
--      finalize-rekey (new), abort-rekey (new), complete-invite-wrap
--      (patched to read active_key_versions + set is_placeholder),
--      invite-org-member (patched same way).
--   2. If pg_cron is not available, schedule a Supabase scheduled
--      function to POST to purge-expired-old-key-wraps every 24h
--      (daily is fine, nothing urgent happens at the 30-day mark).
-- ════════════════════════════════════════════════════════════════════
