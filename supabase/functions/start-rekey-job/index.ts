/**
 * start-rekey-job, Supabase Edge Function.
 *
 * Owner-initiated entry point for a hard re-key. Validates authorization,
 * ensures no other active job exists for the org, counts rows across
 * business tables, and inserts a `key_rotation_jobs` row in status
 * `pending`. Returns the job id + row count + time estimate for the
 * 7-step safety dialog.
 *
 * DOES NOT perform any crypto, the client drives every stage after
 * this. DOES NOT advance the job past `pending`; the client calls
 * `advance_rotation_job` as it progresses.
 *
 * Request body (JSON):
 *   { "org_id": "<uuid>", "trigger_type": "first_time_setup"|"manual"|"post_revoke" }
 *
 * Response (200):
 *   { job_id, rows_total, estimated_seconds,
 *     new_dek_key_version, new_osk_key_version,
 *     previous_dek_key_version, previous_osk_key_version }
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_TRIGGERS = new Set(['first_time_setup', 'manual', 'post_revoke']);
const VALID_REFRESH_MODES = new Set(['quick', 'deep']);

// Tables we count rows for when estimating. Must match rekey.ts
// BUSINESS_TABLES, if a table exists in one place but not the other
// the estimate is off but the job still runs correctly.
const COUNTABLE_TABLES = [
  'transactions',
  'journal_entries',
  'journal_entry_lines',
  'contacts',
  'chart_of_accounts',
  'payment_requests',
  'wallets',
  'organizations',
  'org_settings',
  'attachments',
] as const;

// Rough estimate, 600 rows/sec for decrypt+encrypt round trip.
const ROWS_PER_SECOND = 600;

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
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return jsonResponse({ error: 'Missing Authorization header' }, 401, cors);
    }
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const {
      data: { user: caller },
      error: authErr,
    } = await callerClient.auth.getUser();
    if (authErr || !caller) {
      return jsonResponse({ error: 'Unauthorized' }, 401, cors);
    }

    // Aggressive rate limit, re-key jobs are heavy. One start per 30s
    // is already far above legitimate usage.
    const rl = await rateLimit(adminClient, {
      scope: 'start-rekey-job',
      subject: caller.id,
      maxPerWindow: 5,
      windowSeconds: 300,
    });
    if (!rl.allowed) {
      return jsonResponse({ error: 'Rate limit exceeded; try again shortly' }, 429, cors);
    }

    const raw = await readBoundedText(req);
    if (raw === null) {
      return jsonResponse({ error: 'Request body too large' }, 413, cors);
    }
    let body: { org_id?: unknown; trigger_type?: unknown; refresh_mode?: unknown };
    try {
      body = JSON.parse(raw | '{}');
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
    }

    const orgId = typeof body.org_id === 'string' ? body.org_id.trim() : '';
    const triggerType = typeof body.trigger_type === 'string' ? body.trigger_type.trim() : '';
    // Quick vs Deep refresh. Default to 'quick' for back-compat
    // callers that don't supply the field.
    const refreshModeRaw =
      typeof body.refresh_mode === 'string' ? body.refresh_mode.trim() : 'quick';
    if (!orgId || !UUID_RE.test(orgId)) {
      return jsonResponse({ error: 'org_id is required' }, 400, cors);
    }
    if (!VALID_TRIGGERS.has(triggerType)) {
      return jsonResponse(
        { error: 'trigger_type must be first_time_setup, manual, or post_revoke' },
        400,
        cors,
      );
    }
    if (!VALID_REFRESH_MODES.has(refreshModeRaw)) {
      return jsonResponse({ error: 'refresh_mode must be quick or deep' }, 400, cors);
    }
    const refreshMode = refreshModeRaw as 'quick' | 'deep';

    // Caller must hold users.invite in this org.
    const { data: hasCap, error: capErr } = await adminClient.rpc('user_has_capability', {
      p_user_id: caller.id,
      p_capability: 'users.invite',
      p_org_id: orgId,
    });
    if (capErr) {
      console.error('start-rekey-job capability check failed:', capErr);
      return jsonResponse({ error: 'Failed to authorize caller' }, 500, cors);
    }
    if (!hasCap) {
      return jsonResponse(
        { error: "You don't have permission to update this team's keys." },
        403,
        cors,
      );
    }

    // Reject if an active job already exists for this org.
    const { data: activeJob } = await adminClient
      .from('key_rotation_jobs')
      .select('id, status')
      .eq('org_id', orgId)
      .not('status', 'in', '(complete,aborted,rolled_back)')
      .maybeSingle();
    if (activeJob) {
      return jsonResponse(
        {
          error: 'A key update is already running for this team.',
          existing_job_id: (activeJob as { id: string }).id,
        },
        409,
        cors,
      );
    }

    // Look up the current active DEK + signing key versions. Defaults to 1 if
    // the active_key_versions row doesn't exist yet (pre-backfill in
    // which case we treat the migration baseline as v1).
    const { data: active } = await adminClient
      .from('active_key_versions')
      .select('active_dek_key_version, active_osk_key_version')
      .eq('org_id', orgId)
      .maybeSingle();
    const activeRow = active as {
      active_dek_key_version?: number;
      active_osk_key_version?: number;
    } | null;
    const currentDekVersion = activeRow?.active_dek_key_version ?? 1;
    const currentOskVersion = activeRow?.active_osk_key_version ?? 1;
    const newDekVersion = currentDekVersion + 1;
    const newOskVersion = currentOskVersion + 1;

    // For first-time-setup, previous_* is NULL, the baseline is
    // placeholder wraps, not a real prior DEK. For manual / post_revoke,
    // previous_* is the pre-rotation version (used by emergency rollback).
    const prevDekVersion = triggerType === 'first_time_setup' ? null : currentDekVersion;
    const prevOskVersion = triggerType === 'first_time_setup' ? null : currentOskVersion;

    // Row count estimate across business tables. Each table is an
    // independent count(*), keeps DoS pressure bounded.
    let rowsTotal = 0;
    for (const table of COUNTABLE_TABLES) {
      try {
        // org_settings keys on org_id; organizations keys on id.
        const orgColumn = table === 'organizations' ? 'id' : 'org_id';
        const { count } = await adminClient
          .from(table)
          .select('*', { count: 'exact', head: true })
          .eq(orgColumn, orgId);
        rowsTotal += count ?? 0;
      } catch (err) {
        console.warn(`start-rekey-job: count failed for ${table}:`, err);
      }
    }

    const { data: inserted, error: insertErr } = await adminClient
      .from('key_rotation_jobs')
      .insert({
        org_id: orgId,
        status: 'pending',
        trigger_type: triggerType,
        refresh_mode: refreshMode,
        started_by: caller.id,
        new_dek_key_version: newDekVersion,
        new_osk_key_version: newOskVersion,
        previous_dek_key_version: prevDekVersion,
        previous_osk_key_version: prevOskVersion,
        rows_total: rowsTotal,
      })
      .select('id')
      .single();
    if (insertErr || !inserted) {
      console.error('start-rekey-job insert failed:', insertErr);
      return jsonResponse({ error: 'Could not start the key update.' }, 500, cors);
    }

    // Audit event, separate from advance_rotation_job's
    // rekey.status_changed because this captures the SEED of the job.
    try {
      await adminClient.from('vault_security_events').insert({
        user_id: caller.id,
        event: 'rekey.started',
        metadata: {
          job_id: (inserted as { id: string }).id,
          org_id: orgId,
          trigger_type: triggerType,
          refresh_mode: refreshMode,
          rows_total: rowsTotal,
          new_dek_key_version: newDekVersion,
          new_osk_key_version: newOskVersion,
        },
      });
    } catch (err) {
      console.warn('start-rekey-job audit insert threw:', err);
    }

    // Deep refresh re-encrypts every row; rough multiplier vs. Quick.
    // Client mirrors this same math for UI consistency.
    const DEEP_TIME_MULTIPLIER = 8;
    const baseEstimate = Math.max(60, Math.ceil(rowsTotal / ROWS_PER_SECOND));
    const estimatedSeconds =
      refreshMode === 'deep' ? baseEstimate * DEEP_TIME_MULTIPLIER : baseEstimate;

    return jsonResponse(
      {
        job_id: (inserted as { id: string }).id,
        rows_total: rowsTotal,
        estimated_seconds: estimatedSeconds,
        refresh_mode: refreshMode,
        new_dek_key_version: newDekVersion,
        new_osk_key_version: newOskVersion,
        previous_dek_key_version: prevDekVersion,
        previous_osk_key_version: prevOskVersion,
      },
      200,
      cors,
    );
  } catch (err) {
    console.error('start-rekey-job error:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});
