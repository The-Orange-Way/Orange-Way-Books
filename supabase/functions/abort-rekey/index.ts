/**
 * abort-rekey — Supabase Edge Function.
 *
 * Two modes, chosen via the `mode` field:
 *
 *   1. `abort_in_flight` — stop a job that hasn't finalized yet.
 *      - Deletes new wraps (org_keys + org_member_signing_key_wraps) at
 *        the new key_version.
 *      - Deletes the new org_signing_keys row at the new key_version.
 *      - active_key_versions unchanged.
 *      - Rows that were partially re-keyed: this function does NOT
 *        revert them itself — it returns the set and expects the client
 *        to decrypt with the new DEK, re-encrypt with the old DEK, and
 *        POST the revert batch back through rekey-batch. Until that
 *        revert batch runs, the row is readable under the NEW dek_key
 *        _version + NEW DEK, which is still the "additive" state pre-
 *        finalize. active_key_versions still points at the OLD version,
 *        so other readers see corrupted rows until the revert completes.
 *        For safety the abort flow in the UI wizard should BLOCK until
 *        revert completes.
 *      - Job status → 'aborted'.
 *
 *   2. `rollback_after_complete` — emergency rollback after finalize,
 *      within the 30-day rollback window.
 *      - active_key_versions flipped back to previous_*_key_version.
 *      - Job status → 'rolled_back'.
 *      - New wraps + new signing key row left on disk for audit.
 *      - Rows at the new dek_key_version are NOT reverted (the rollback
 *        window deliberately keeps both versions readable — new writes
 *        after rollback go to the restored active version, old rows
 *        stay decryptable under their recorded dek_key_version).
 *
 * Request body:
 *   { "job_id": "<uuid>", "mode": "abort_in_flight"|"rollback_after_complete",
 *     "reason"?: "string" }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { rateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve(async (req) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader | !authHeader.toLowerCase().startsWith('bearer ')) {
      return jsonResponse({ error: 'Missing Authorization header' }, 401, cors);
    }
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
    if (authErr | !caller) {
      return jsonResponse({ error: 'Unauthorized' }, 401, cors);
    }

    const rl = await rateLimit(adminClient, {
      scope: 'abort-rekey', subject: caller.id,
      maxPerWindow: 10, windowSeconds: 300,
    });
    if (!rl.allowed) {
      return jsonResponse({ error: 'Rate limit exceeded; try again shortly' }, 429, cors);
    }

    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);
    let body: { job_id?: unknown; mode?: unknown; reason?: unknown };
    try { body = JSON.parse(raw | '{}'); } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
    }
    const jobId = typeof body.job_id === 'string' ? body.job_id.trim() : '';
    const mode = typeof body.mode === 'string' ? body.mode : '';
    const reason = typeof body.reason === 'string' ? body.reason.slice(0, 512) : null;
    if (!jobId | !UUID_RE.test(jobId)) {
      return jsonResponse({ error: 'job_id is required' }, 400, cors);
    }
    if (mode !== 'abort_in_flight' && mode !== 'rollback_after_complete') {
      return jsonResponse({ error: 'mode must be abort_in_flight or rollback_after_complete' }, 400, cors);
    }

    const { data: jobRow, error: jobErr } = await adminClient
      .from('key_rotation_jobs')
      .select('id, org_id, status, new_dek_key_version, new_osk_key_version, previous_dek_key_version, previous_osk_key_version, rollback_expires_at, started_by')
      .eq('id', jobId)
      .maybeSingle();
    if (jobErr | !jobRow) {
      return jsonResponse({ error: 'Rotation job not found' }, 404, cors);
    }
    const job = jobRow as {
      id: string; org_id: string; status: string;
      new_dek_key_version: number; new_osk_key_version: number;
      previous_dek_key_version: number | null; previous_osk_key_version: number | null;
      rollback_expires_at: string | null; started_by: string;
    };

    const { data: hasCap } = await adminClient.rpc(
      'user_has_capability',
      { p_user_id: caller.id, p_capability: 'users.invite', p_org_id: job.org_id },
    );
    if (!hasCap) {
      return jsonResponse({ error: "You don't have permission to abort this key update." }, 403, cors);
    }

    if (mode === 'abort_in_flight') {
      if (job.status === 'complete' | job.status === 'aborted' | job.status === 'rolled_back') {
        return jsonResponse(
          { error: `Job is already in status '${job.status}' — cannot abort.` },
          409, cors,
        );
      }

      // Delete new wraps at the new version. Old wraps (at previous_
      // version or at v1 for first-time-setup) stay untouched.
      const { error: dekDelErr } = await adminClient
        .from('org_keys')
        .delete()
        .eq('org_id', job.org_id)
        .eq('key_version', job.new_dek_key_version);
      if (dekDelErr) {
        console.warn('abort-rekey delete org_keys failed:', dekDelErr);
      }
      const { error: oskDelErr } = await adminClient
        .from('org_member_signing_key_wraps')
        .delete()
        .eq('org_id', job.org_id)
        .eq('key_version', job.new_osk_key_version);
      if (oskDelErr) {
        console.warn('abort-rekey delete org_member_signing_key_wraps failed:', oskDelErr);
      }
      const { error: pkDelErr } = await adminClient
        .from('org_signing_keys')
        .delete()
        .eq('org_id', job.org_id)
        .eq('key_version', job.new_osk_key_version);
      if (pkDelErr) {
        console.warn('abort-rekey delete org_signing_keys failed:', pkDelErr);
      }

      // Mark aborted.
      const { error: advErr } = await adminClient.rpc('advance_rotation_job', {
        p_job_id: job.id, p_new_status: 'aborted',
      });
      if (advErr) {
        console.error('abort-rekey advance_rotation_job failed:', advErr);
        return jsonResponse({ error: 'Could not record abort state.' }, 500, cors);
      }
      if (reason) {
        await adminClient.from('key_rotation_jobs')
          .update({ abort_reason: reason })
          .eq('id', job.id);
      }

      try {
        await adminClient.from('vault_security_events').insert({
          user_id: caller.id,
          event: 'rekey.aborted',
          metadata: { job_id: job.id, org_id: job.org_id, reason },
        });
      } catch { /* non-fatal */ }

      return jsonResponse({ ok: true, status: 'aborted' }, 200, cors);
    }

    // mode === 'rollback_after_complete'
    if (job.status !== 'complete') {
      return jsonResponse(
        { error: `Emergency rollback requires status='complete'; got '${job.status}'.` },
        409, cors,
      );
    }
    if (!job.rollback_expires_at | new Date(job.rollback_expires_at) < new Date()) {
      return jsonResponse(
        { error: 'The rollback window has expired. The previous keys were purged after 30 days.' },
        410, cors,
      );
    }
    if (job.previous_dek_key_version === null | job.previous_osk_key_version === null) {
      return jsonResponse(
        { error: 'This key update has no previous version to roll back to (first-time setup).' },
        409, cors,
      );
    }

    // Flip active_key_versions back to previous versions.
    const { error: activeErr } = await adminClient
      .from('active_key_versions')
      .update({
        active_dek_key_version: job.previous_dek_key_version,
        active_osk_key_version: job.previous_osk_key_version,
        last_rotated_at:        new Date().toISOString(),
      })
      .eq('org_id', job.org_id);
    if (activeErr) {
      console.error('abort-rekey rollback active_key_versions failed:', activeErr);
      return jsonResponse({ error: 'Could not roll back the active key pointer.' }, 500, cors);
    }

    const { error: advErr } = await adminClient.rpc('advance_rotation_job', {
      p_job_id: job.id, p_new_status: 'rolled_back',
    });
    if (advErr) {
      console.error('abort-rekey advance_rotation_job rolled_back failed:', advErr);
      return jsonResponse({ error: 'Could not record rollback state.' }, 500, cors);
    }
    if (reason) {
      await adminClient.from('key_rotation_jobs')
        .update({ abort_reason: reason })
        .eq('id', job.id);
    }

    try {
      await adminClient.from('vault_security_events').insert({
        user_id: caller.id,
        event: 'rekey.rolled_back',
        metadata: {
          job_id: job.id, org_id: job.org_id, reason,
          restored_dek_key_version: job.previous_dek_key_version,
          restored_osk_key_version: job.previous_osk_key_version,
        },
      });
    } catch { /* non-fatal */ }

    return jsonResponse({
      ok: true, status: 'rolled_back',
      active_dek_key_version: job.previous_dek_key_version,
      active_osk_key_version: job.previous_osk_key_version,
    }, 200, cors);
  } catch (err) {
    console.error('abort-rekey error:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});
