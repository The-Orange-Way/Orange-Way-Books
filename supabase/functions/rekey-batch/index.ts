/**
 * rekey-batch — Supabase Edge Function.
 *
 * Worker endpoint called repeatedly by the client during a rekey job.
 * Handles two kinds of batches:
 *
 *   1. stage='wrap_members':
 *        batch.kind='dek'  → insert rows into `org_keys` at new key_version
 *        batch.kind='osk'  → insert one org_signing_keys row + wraps at
 *                            new key_version
 *      Inserts are additive: active_key_versions is NOT touched yet.
 *
 *   2. stage='rekey_rows':
 *        batch.rows[] each specifies:
 *          { table, row_id, new_dek_key_version, new_ciphertext_fields }
 *        For each row, the function UPDATEs the matching business-table
 *        row with the new ciphertext columns + new dek_key_version.
 *        Empty new_ciphertext_fields → only bump dek_key_version (this
 *        is the first-time-setup fast path where old ciphertext under
 *        the per-user MEK stays readable).
 *
 * Authorization: caller must hold `users.invite` in the job's org_id.
 * The job must be in the right status for the requested stage.
 *
 * Atomicity: each batch is processed inside ONE outer try/catch. If any
 * single row UPDATE fails the function returns { ok: false, failed_rows
 * }. The CLIENT must then call abort-rekey; no partial-commit handling
 * happens here because PostgREST doesn't give us a transaction around
 * multiple UPDATEs.
 *
 * Request body:
 *   {
 *     "job_id": "<uuid>",
 *     "stage":  "wrap_members" | "rekey_rows",
 *     "batch":  <stage-specific shape — see above>
 *   }
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
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

// Audit M5: only log Supabase error code + message. Future Supabase versions
// could grow a `context` or `details` field carrying row content; logging
// the whole error object would leak that. Strip down to the safe fields.
function safeErr(err: unknown): { code: string; message: string } {
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    return {
      code: typeof e.code === 'string' ? e.code : '',
      message: typeof e.message === 'string' ? e.message : String(err),
    };
  }
  return { code: '', message: String(err) };
}

const MAX_BATCH_SIZE_ROWS = 500;
const MAX_BATCH_SIZE_WRAPS = 200;

// Whitelist of business tables that accept rekey_rows updates. Any
// other value is rejected so a malicious client cannot overwrite
// arbitrary rows.
const ALLOWED_REKEY_TABLES = new Set([
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
  'transaction_metadata',
  'account_metadata',
]);

// Per-table allowed ciphertext column names. Accepting any column name
// would let a bad client write into status/amount/PK columns.
const ALLOWED_CIPHERTEXT_COLUMNS: Readonly<Record<string, Set<string>>> = Object.freeze({
  transactions: new Set([
    'memo',
    'encrypted_amount',
    'encrypted_usd_value',
    'encrypted_exchange_rate',
    'asset',
    'type',
    'status',
    'cleared_status',
  ]),
  journal_entries: new Set([
    'memo',
    'ref_number',
    'currency',
    'encrypted_exchange_rate',
    'status',
    'source_type',
    'encrypted_period_locked',
  ]),
  journal_entry_lines: new Set([
    'account_name',
    'account_code',
    'description',
    'encrypted_debit',
    'encrypted_credit',
    'encrypted_book_value',
    'encrypted_amount_native',
    'encrypted_amount_primary',
    'encrypted_posted_rate',
    'encrypted_wallet_currency',
  ]),
  contacts: new Set([
    'name',
    'street',
    'city',
    'state',
    'zip',
    'country',
    'email',
    'phone',
    'type',
  ]),
  chart_of_accounts: new Set([
    'encrypted_name',
    'encrypted_code',
    'encrypted_description',
    'encrypted_account_type',
    'encrypted_account_sub_type',
    'encrypted_is_group',
    'encrypted_is_system',
    'encrypted_is_archived',
    'encrypted_allowed_currencies',
  ]),
  payment_requests: new Set([
    'encrypted_payee',
    'encrypted_description',
    'encrypted_rejection_reason',
    'encrypted_amount',
    'currency',
    'status',
    'request_type',
    'vendor_ref',
    'payment_address',
  ]),
  wallets: new Set([
    'encrypted_name',
    'encrypted_balance',
    'asset',
    'account_type',
    'connection_type',
    'external_account_code',
  ]),
  organizations: new Set(['name']),
  org_settings: new Set([
    'primary_currency',
    'secondary_currency',
    'bitcoin_display',
    'fiscal_year_type',
    'encrypted_fiscal_month',
    'date_format',
    'time_format',
    'number_format',
    'timezone',
  ]),
  attachments: new Set(['file_name', 'mime_type']),
  transaction_metadata: new Set([]),
  account_metadata: new Set([]),
});

interface RekeyJob {
  id: string;
  org_id: string;
  status: string;
  new_dek_key_version: number;
  new_osk_key_version: number;
  rows_processed: number;
  rows_failed: number;
  error_log: unknown[];
}

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

    // High-frequency endpoint — generous limit, but cap excessive calls.
    const rl = await rateLimit(adminClient, {
      scope: 'rekey-batch',
      subject: caller.id,
      maxPerWindow: 600,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      return jsonResponse({ error: 'Rate limit exceeded; slow down' }, 429, cors);
    }

    const raw = await readBoundedText(req);
    if (raw === null) {
      return jsonResponse({ error: 'Request body too large' }, 413, cors);
    }
    let body: { job_id?: unknown; stage?: unknown; batch?: unknown; mode?: unknown };
    try {
      body = JSON.parse(raw | '{}');
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
    }

    const jobId = typeof body.job_id === 'string' ? body.job_id.trim() : '';
    const stage = typeof body.stage === 'string' ? body.stage : '';
    // Quick vs Deep refresh. Optional — back-compat callers and
    // legacy jobs don't supply it. When absent we fall back to the job's
    // stored refresh_mode (or 'quick' if even that is missing). The
    // field is advisory in this endpoint: Quick expects empty
    // new_ciphertext_fields (version-bump-only), Deep expects populated
    // new_ciphertext_fields. Both paths are already supported below;
    // we just use the hint for an audit tag.
    const modeHint = typeof body.mode === 'string' ? body.mode : '';
    if (modeHint && modeHint !== 'quick' && modeHint !== 'deep') {
      return jsonResponse({ error: 'mode must be quick or deep' }, 400, cors);
    }
    if (!jobId || !UUID_RE.test(jobId)) {
      return jsonResponse({ error: 'job_id is required' }, 400, cors);
    }
    if (stage !== 'wrap_members' && stage !== 'rekey_rows') {
      return jsonResponse({ error: 'stage must be wrap_members or rekey_rows' }, 400, cors);
    }

    // Load job + authorize.
    const { data: jobData, error: jobErr } = await adminClient
      .from('key_rotation_jobs')
      .select(
        'id, org_id, status, new_dek_key_version, new_osk_key_version, rows_processed, rows_failed, error_log',
      )
      .eq('id', jobId)
      .maybeSingle();
    if (jobErr || !jobData) {
      return jsonResponse({ error: 'Rotation job not found' }, 404, cors);
    }
    const job = jobData as RekeyJob;

    const { data: hasCap } = await adminClient.rpc('user_has_capability', {
      p_user_id: caller.id,
      p_capability: 'users.invite',
      p_org_id: job.org_id,
    });
    if (!hasCap) {
      return jsonResponse(
        { error: "You don't have permission to continue this key update." },
        403,
        cors,
      );
    }

    if (job.status === 'complete' || job.status === 'aborted' || job.status === 'rolled_back') {
      return jsonResponse(
        { error: `Job is in status '${job.status}' — no further work accepted.` },
        409,
        cors,
      );
    }

    if (stage === 'wrap_members') {
      return await handleWrapMembers(body.batch, job, cors);
    }
    return await handleRekeyRows(body.batch, job, cors);
  } catch (err) {
    console.error('rekey-batch error:', safeErr(err));
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});

/* ═══════════════════════════════════════════════════════════════════ */
/* wrap_members                                                         */
/* ═══════════════════════════════════════════════════════════════════ */

async function handleWrapMembers(
  batchRaw: unknown,
  job: RekeyJob,
  cors: Record<string, string>,
): Promise<Response> {
  if (!batchRaw || typeof batchRaw !== 'object') {
    return jsonResponse({ error: 'batch must be an object' }, 400, cors);
  }
  const batch = batchRaw as {
    kind?: string;
    rows?: unknown[];
    public_key_b64?: string;
    org_id?: string;
  };
  if (batch.kind !== 'dek' && batch.kind !== 'osk') {
    return jsonResponse({ error: 'batch.kind must be dek or osk' }, 400, cors);
  }
  if (!Array.isArray(batch.rows)) {
    return jsonResponse({ error: 'batch.rows must be an array' }, 400, cors);
  }
  if (batch.rows.length === 0) {
    return jsonResponse({ ok: true, inserted: 0 }, 200, cors);
  }
  if (batch.rows.length > MAX_BATCH_SIZE_WRAPS) {
    return jsonResponse(
      { error: `Too many wraps in one batch (max ${MAX_BATCH_SIZE_WRAPS})` },
      400,
      cors,
    );
  }

  if (batch.kind === 'dek') {
    // Validate each DEK wrap row.
    const dekRows: Array<{
      org_id: string;
      user_id: string;
      wrapped_dek: string;
      iv: string;
      wrap_algo: string;
      key_version: number;
      is_placeholder: boolean;
    }> = [];
    for (let i = 0; i < batch.rows.length; i++) {
      const r = batch.rows[i] as Record<string, unknown>;
      if (typeof r.user_id !== 'string' || !UUID_RE.test(r.user_id)) {
        return jsonResponse({ error: `rows[${i}].user_id invalid` }, 400, cors);
      }
      if (
        typeof r.wrapped_dek !== 'string' ||
        !BASE64_RE.test(r.wrapped_dek) ||
        r.wrapped_dek.length > 8192
      ) {
        return jsonResponse({ error: `rows[${i}].wrapped_dek invalid` }, 400, cors);
      }
      if (typeof r.iv !== 'string' || !BASE64_RE.test(r.iv) || r.iv.length > 64) {
        return jsonResponse({ error: `rows[${i}].iv invalid` }, 400, cors);
      }
      if (typeof r.wrap_algo !== 'string' || r.wrap_algo.length > 64) {
        return jsonResponse({ error: `rows[${i}].wrap_algo invalid` }, 400, cors);
      }
      if (typeof r.key_version !== 'number' || r.key_version !== job.new_dek_key_version) {
        return jsonResponse(
          { error: `rows[${i}].key_version must be ${job.new_dek_key_version}` },
          400,
          cors,
        );
      }
      dekRows.push({
        org_id: job.org_id,
        user_id: r.user_id,
        wrapped_dek: r.wrapped_dek,
        iv: r.iv,
        wrap_algo: r.wrap_algo,
        key_version: job.new_dek_key_version,
        is_placeholder: false,
      });
    }

    const { error } = await adminClient
      .from('org_keys')
      .upsert(dekRows, { onConflict: 'org_id,user_id,key_version' });
    if (error) {
      console.error('rekey-batch dek upsert failed:', safeErr(error));
      return jsonResponse({ error: 'Could not save a new key wrap.' }, 500, cors);
    }

    try {
      await adminClient.from('vault_security_events').insert({
        user_id: job.org_id,
        event: 'rekey.batch_completed',
        metadata: { job_id: job.id, stage: 'wrap_members', kind: 'dek', count: dekRows.length },
      });
    } catch {
      /* non-fatal */
    }

    return jsonResponse({ ok: true, inserted: dekRows.length }, 200, cors);
  }

  // batch.kind === 'osk' — insert the signing-key row + wraps.
  if (typeof batch.public_key_b64 !== 'string' || !BASE64_RE.test(batch.public_key_b64)) {
    return jsonResponse({ error: 'batch.public_key_b64 invalid' }, 400, cors);
  }
  const oskRows: Array<{
    user_id: string;
    org_id: string;
    key_version: number;
    wrapped_private_key: string;
    wrap_algo: string;
    iv: string;
  }> = [];
  for (let i = 0; i < batch.rows.length; i++) {
    const r = batch.rows[i] as Record<string, unknown>;
    if (typeof r.user_id !== 'string' || !UUID_RE.test(r.user_id)) {
      return jsonResponse({ error: `rows[${i}].user_id invalid` }, 400, cors);
    }
    if (
      typeof r.wrapped_private_key !== 'string' ||
      !BASE64_RE.test(r.wrapped_private_key) ||
      r.wrapped_private_key.length > 32768
    ) {
      return jsonResponse({ error: `rows[${i}].wrapped_private_key invalid` }, 400, cors);
    }
    if (typeof r.iv !== 'string' || !BASE64_RE.test(r.iv) || r.iv.length > 64) {
      return jsonResponse({ error: `rows[${i}].iv invalid` }, 400, cors);
    }
    if (typeof r.wrap_algo !== 'string' || r.wrap_algo.length > 64) {
      return jsonResponse({ error: `rows[${i}].wrap_algo invalid` }, 400, cors);
    }
    if (typeof r.key_version !== 'number' || r.key_version !== job.new_osk_key_version) {
      return jsonResponse(
        { error: `rows[${i}].key_version must be ${job.new_osk_key_version}` },
        400,
        cors,
      );
    }
    oskRows.push({
      user_id: r.user_id,
      org_id: job.org_id,
      key_version: job.new_osk_key_version,
      wrapped_private_key: r.wrapped_private_key,
      wrap_algo: r.wrap_algo,
      iv: r.iv,
    });
  }

  // Upsert the public-key row first — one per (org, key_version). If
  // it already exists at this version we allow it (idempotent resume).
  const { data: existing } = await adminClient
    .from('org_signing_keys')
    .select('key_version')
    .eq('org_id', job.org_id)
    .eq('key_version', job.new_osk_key_version)
    .maybeSingle();
  if (!existing) {
    const { error: pkErr } = await adminClient.from('org_signing_keys').insert({
      org_id: job.org_id,
      key_version: job.new_osk_key_version,
      public_key_b64: batch.public_key_b64,
      algorithm: 'ml-dsa-65',
      created_by: job.org_id, // service-role insert; created_by NOT NULL — use org_id as a placeholder the real row isn't sensitive
    });
    if (pkErr) {
      // created_by must reference auth.users(id); fall back to the
      // job's started_by. Re-read the job row for the bynre value.
      const { data: freshJob } = await adminClient
        .from('key_rotation_jobs')
        .select('started_by')
        .eq('id', job.id)
        .maybeSingle();
      const startedBy = (freshJob as { started_by: string } | null)?.started_by;
      if (startedBy) {
        const { error: retryErr } = await adminClient.from('org_signing_keys').insert({
          org_id: job.org_id,
          key_version: job.new_osk_key_version,
          public_key_b64: batch.public_key_b64,
          algorithm: 'ml-dsa-65',
          created_by: startedBy,
        });
        if (retryErr) {
          console.error('rekey-batch org_signing_keys insert retry failed:', safeErr(retryErr));
          return jsonResponse({ error: 'Could not save the new signing key.' }, 500, cors);
        }
      } else {
        console.error('rekey-batch org_signing_keys insert failed:', safeErr(pkErr));
        return jsonResponse({ error: 'Could not save the new signing key.' }, 500, cors);
      }
    }
  }

  const { error: wrapErr } = await adminClient
    .from('org_member_signing_key_wraps')
    .upsert(oskRows, { onConflict: 'user_id,org_id,key_version' });
  if (wrapErr) {
    console.error('rekey-batch osk wrap upsert failed:', safeErr(wrapErr));
    return jsonResponse({ error: 'Could not save the new signing-key wraps.' }, 500, cors);
  }

  try {
    await adminClient.from('vault_security_events').insert({
      user_id: job.org_id,
      event: 'rekey.batch_completed',
      metadata: { job_id: job.id, stage: 'wrap_members', kind: 'osk', count: oskRows.length },
    });
  } catch {
    /* non-fatal */
  }

  return jsonResponse({ ok: true, inserted: oskRows.length }, 200, cors);
}

/* ═══════════════════════════════════════════════════════════════════ */
/* rekey_rows                                                           */
/* ═══════════════════════════════════════════════════════════════════ */

async function handleRekeyRows(
  batchRaw: unknown,
  job: RekeyJob,
  cors: Record<string, string>,
): Promise<Response> {
  if (!batchRaw || typeof batchRaw !== 'object') {
    return jsonResponse({ error: 'batch must be an object' }, 400, cors);
  }
  const batch = batchRaw as { rows?: unknown[] };
  if (!Array.isArray(batch.rows)) {
    return jsonResponse({ error: 'batch.rows must be an array' }, 400, cors);
  }
  if (batch.rows.length > MAX_BATCH_SIZE_ROWS) {
    return jsonResponse(
      { error: `Too many rows in one batch (max ${MAX_BATCH_SIZE_ROWS})` },
      400,
      cors,
    );
  }

  // Validate every row before running any UPDATE so a malformed row
  // doesn't leave the batch half-applied.
  interface RekeyRowUpdate {
    table: string;
    row_id: string;
    new_dek_key_version: number;
    new_ciphertext_fields: Record<string, string>;
  }
  const updates: RekeyRowUpdate[] = [];
  for (let i = 0; i < batch.rows.length; i++) {
    const r = batch.rows[i] as Record<string, unknown>;
    if (typeof r.table !== 'string' || !ALLOWED_REKEY_TABLES.has(r.table)) {
      return jsonResponse({ error: `rows[${i}].table not allowed` }, 400, cors);
    }
    if (typeof r.row_id !== 'string' || !UUID_RE.test(r.row_id)) {
      return jsonResponse({ error: `rows[${i}].row_id invalid` }, 400, cors);
    }
    if (
      typeof r.new_dek_key_version !== 'number' ||
      r.new_dek_key_version !== job.new_dek_key_version
    ) {
      return jsonResponse(
        { error: `rows[${i}].new_dek_key_version must be ${job.new_dek_key_version}` },
        400,
        cors,
      );
    }
    const fields = r.new_ciphertext_fields ?? {};
    if (typeof fields !== 'object' || fields === null) {
      return jsonResponse(
        { error: `rows[${i}].new_ciphertext_fields must be an object` },
        400,
        cors,
      );
    }
    const allowedCols = ALLOWED_CIPHERTEXT_COLUMNS[r.table] ?? new Set<string>();
    const safeFields: Record<string, string> = {};
    for (const [col, val] of Object.entries(fields as Record<string, unknown>)) {
      if (!allowedCols.has(col)) {
        return jsonResponse(
          {
            error: `rows[${i}].new_ciphertext_fields.${col} is not an allowed column for ${r.table}`,
          },
          400,
          cors,
        );
      }
      if (typeof val !== 'string' || val.length > 65536) {
        return jsonResponse(
          { error: `rows[${i}].new_ciphertext_fields.${col} must be a string under 64KB` },
          400,
          cors,
        );
      }
      safeFields[col] = val;
    }
    updates.push({
      table: r.table,
      row_id: r.row_id,
      new_dek_key_version: job.new_dek_key_version,
      new_ciphertext_fields: safeFields,
    });
  }

  const failedRows: Array<{ table: string; row_id: string; error: string }> = [];
  let applied = 0;
  for (const u of updates) {
    const update: Record<string, unknown> = {
      dek_key_version: u.new_dek_key_version,
      ...u.new_ciphertext_fields,
    };
    // Use org_id filter where the table supports it for defense-in-depth.
    const orgColumn = u.table === 'organizations' ? 'id' : 'org_id';
    let query = adminClient.from(u.table).update(update).eq('id', u.row_id);
    // Table-specific: org_settings keys on org_id as PK. The update still
    // works because PK lookup succeeds with id eq. Leave as-is.
    if (u.table !== 'organizations' && u.table !== 'org_settings') {
      query = query.eq(orgColumn, job.org_id);
    } else if (u.table === 'organizations') {
      query = adminClient.from(u.table).update(update).eq('id', u.row_id);
    } else if (u.table === 'org_settings') {
      query = adminClient.from(u.table).update(update).eq('org_id', u.row_id);
    }
    const { error } = await query;
    if (error) {
      failedRows.push({ table: u.table, row_id: u.row_id, error: error.message });
    } else {
      applied += 1;
    }
  }

  // Update job counters + error log.
  const newErrorLog =
    failedRows.length > 0
      ? [...(Array.isArray(job.error_log) ? job.error_log : []), ...failedRows.slice(0, 50)]
      : job.error_log;
  await adminClient
    .from('key_rotation_jobs')
    .update({
      rows_processed: job.rows_processed + applied,
      rows_failed: job.rows_failed + failedRows.length,
      error_log: newErrorLog,
    })
    .eq('id', job.id);

  if (failedRows.length > 0) {
    return jsonResponse({ ok: false, applied, failed_rows: failedRows }, 200, cors);
  }

  try {
    await adminClient.from('vault_security_events').insert({
      user_id: job.org_id,
      event: 'rekey.batch_completed',
      metadata: { job_id: job.id, stage: 'rekey_rows', count: applied },
    });
  } catch {
    /* non-fatal */
  }

  return jsonResponse({ ok: true, applied }, 200, cors);
}
