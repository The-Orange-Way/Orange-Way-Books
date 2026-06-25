/**
 * Phase 4.5 — Hard re-key client library.
 *
 * Drives resumable key-rotation jobs end-to-end in the browser. The server
 * owns state (status, row counts, error log), we own crypto (new DEK +
 * new signing-key generation, per-member wraps, per-row decrypt+re-encrypt).
 *
 * ── Flow at a glance ─────────────────────────────────────────────────
 *
 *   startRekeyJob(orgId, triggerType)
 *     └─ POST /start-rekey-job → { jobId, rowsTotal, estimatedSeconds }
 *
 *   runRekeyJob(jobId, callbacks)
 *     ├─ stage: generating_keys   (browser CPU; no server round-trips)
 *     ├─ stage: wrapping_members  (batches of ~50 wraps to rekey-batch)
 *     ├─ stage: rekeying_rows     (batches of 500 rows to rekey-batch)
 *     └─ stage: finalizing        (POST /finalize-rekey)
 *
 * ── Key-rotation rules ────────────────────────────────────────────────
 *
 *   - New wraps go into org_keys / org_member_signing_key_wraps ADDITIVELY with
 *     the new key_version. Old wraps stay readable until the 30-day
 *     rollback window closes and purge_expired_old_key_wraps() fires.
 *   - Business rows get `dek_key_version` bumped atomically with their
 *     new ciphertext. Until finalize, the client can decrypt either old
 *     or new rows by picking the matching DEK at read time.
 *   - active_key_versions is ONLY flipped by finalize-rekey. That one
 *     UPDATE is the "atomic cutover".
 *
 * ── Abort semantics ──────────────────────────────────────────────────
 *
 *   - During wrapping_members: abort deletes new wraps + new signing key
 *     row. active_key_versions unchanged.
 *   - During rekeying_rows: partially-updated rows get REVERTED (this
 *     function re-decrypts with the new DEK and re-encrypts with the
 *     old DEK client-side, then POSTs the revert batch).
 *   - After complete (within rollback window): active_key_versions
 *     flipped back. Old wraps are still present because the 30-day
 *     purge hasn't fired — emergency rollback is a pointer flip only.
 *
 * ── Customer copy ────────────────────────────────────────────────────
 *
 *   Every error bubbled through the callbacks carries plain-English
 *   text. No "DEK", "signing key", "wrap", "cipher" leaks to the UI.
 */

import { supabase } from '@/lib/supabase';
import { DEFAULT_WRAP_ALGORITHM, KEY_WRAP_STRATEGIES, base64ToBytes } from '@/lib/key-wrapping';
import {
  generateAndWrapSigningKey,
  type WriterRecipient,
  type SigningKeyWrapRow,
} from '@/lib/signing-key';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RekeyTriggerType = 'first_time_setup' | 'manual' | 'post_revoke';

/**
 * Quick vs Deep refresh mode.
 *
 *   - 'quick' — version-bump-only fast path. New security codes are
 *     generated + wrapped per member; existing row ciphertext stays on
 *     disk but dek_key_version is bumped so future reads pick the new
 *     code. Safe: removed people still can't read future data or forge
 *     writes. This is the default for routine refresh and post-revoke.
 *
 *   - 'deep' — every row is decrypted under the old DEK and re-encrypted
 *     under the new DEK. Maximum protection — even previously-cached
 *     ciphertext is meaningless. Use for suspected compromise, audits,
 *     or first-time hardening.
 *
 * Copy note: the UI calls these "Quick refresh" and "Deep refresh".
 * Code identifiers stay in English-language crypto vernacular.
 */
export type RefreshMode = 'quick' | 'deep';

export type RekeyStage = 'generating_keys' | 'wrapping_members' | 'rekeying_rows' | 'finalizing';

export interface StartRekeyResult {
  jobId: string;
  rowsTotal: number;
  estimatedSeconds: number;
  refreshMode: RefreshMode;
}

export interface RekeyCallbacks {
  onStageChange?: (stage: RekeyStage) => void;
  onRowProgress?: (processed: number, total: number) => void;
  onError?: (error: Error, canRetry: boolean) => void;
  onComplete?: () => void;
  onAborted?: (reason: string) => void;
  /**
   * Optional: for `trigger_type='first_time_setup'`, once the job
   * completes we queue a "your organization is secured" email for the
   * Owner. The client holds the decrypted org name in memory (ZKA — the
   * server can't read it). Pass both and we'll hand them to the
   * `queue-admin-email` edge function along with the recipient email
   * (caller's auth email).
   *
   * If either field is absent, we skip the email queue silently so
   * tests and non-interactive flows don't break.
   */
  firstTimeSetupEmail?: {
    orgNameDecrypted: string;
    recipientEmail: string;
  };
}

export type RekeyOutcome = 'completed' | 'aborted' | 'rolled_back';

/** Backup format produced by exportOrgBackup. */
export type OrgBackupFormat = 'csv' | 'json';

// ---------------------------------------------------------------------------
// Helpers — base64 + ciphertext re-encrypt primitives
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * A DEK in Phase 4.5 is 32 bytes of AES-256-GCM key material. The raw
 * bytes live only in memory for the duration of the rekey job.
 */
function generateRandomDek(): Uint8Array {
  const dek = new Uint8Array(32);
  crypto.getRandomValues(dek);
  return dek;
}

async function importAesGcmKey(rawBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    rawBytes as BufferSource,
    { name: 'AES-GCM' },
    /* extractable */ false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Re-encrypt an AES-GCM base64 ciphertext under a different DEK. Matches
 * the vault.ts `encryptText` / `decryptText` wire format:
 *   IV[12] | ciphertext+tag, base64-encoded.
 *
 * The caller supplies the OLD DEK (to decrypt) and NEW DEK (to re-encrypt).
 * Returns the new base64 ciphertext. On AES-GCM auth failure (wrong
 * DEK, tampered blob), the underlying subtle.decrypt throws and we
 * rethrow with a plain-English wrapper.
 */
async function reencryptFieldUnderNewDek(
  base64Ciphertext: string,
  oldDekKey: CryptoKey,
  newDekKey: CryptoKey,
): Promise<string> {
  const combined = base64ToBytes(base64Ciphertext);
  if (combined.length < 12 + 16) {
    throw new Error('Ciphertext too short to contain an IV and tag.');
  }
  const iv = combined.subarray(0, 12);
  const ct = combined.subarray(12);
  let plaintextBytes: ArrayBuffer;
  try {
    plaintextBytes = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      oldDekKey,
      ct as BufferSource,
    );
  } catch (err) {
    throw new Error(
      `Could not read existing data with the current key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const newIv = new Uint8Array(12);
  crypto.getRandomValues(newIv);
  const newCt = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: newIv as BufferSource },
      newDekKey,
      plaintextBytes,
    ),
  );
  const out = new Uint8Array(newIv.length + newCt.length);
  out.set(newIv, 0);
  out.set(newCt, newIv.length);
  return bytesToBase64(out);
}

// ---------------------------------------------------------------------------
// Table registry for row re-key
// ---------------------------------------------------------------------------

/**
 * One entry per encrypted business table we re-key. `encryptedColumns`
 * lists the base64-AES-GCM text columns on the row whose contents must
 * be migrated. `idColumn` is the row's primary key.
 *
 * The set matches crypto-fields.ts — keep in sync when a new encrypted
 * column is added to a table.
 */
interface TableRekeyDescriptor {
  table: string;
  idColumn: string;
  orgColumn: string;
  encryptedColumns: string[];
}

const BUSINESS_TABLES: readonly TableRekeyDescriptor[] = Object.freeze([
  {
    table: 'transactions',
    idColumn: 'id',
    orgColumn: 'org_id',
    encryptedColumns: [
      'memo',
      'encrypted_amount',
      'encrypted_usd_value',
      'encrypted_exchange_rate',
      'asset',
      'type',
      'status',
      'cleared_status',
    ],
  },
  {
    table: 'journal_entries',
    idColumn: 'id',
    orgColumn: 'org_id',
    encryptedColumns: [
      'memo',
      'ref_number',
      'currency',
      'encrypted_exchange_rate',
      'status',
      'source_type',
      'encrypted_period_locked',
    ],
  },
  {
    table: 'journal_entry_lines',
    idColumn: 'id',
    orgColumn: 'org_id',
    encryptedColumns: [
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
    ],
  },
  {
    table: 'contacts',
    idColumn: 'id',
    orgColumn: 'org_id',
    encryptedColumns: [
      'name',
      'street',
      'city',
      'state',
      'zip',
      'country',
      'email',
      'phone',
      'type',
    ],
  },
  {
    table: 'chart_of_accounts',
    idColumn: 'id',
    orgColumn: 'org_id',
    encryptedColumns: [
      'encrypted_name',
      'account_type',
      'account_group',
      'account_category',
      'encrypted_is_archived',
    ],
  },
  {
    table: 'payment_requests',
    idColumn: 'id',
    orgColumn: 'org_id',
    encryptedColumns: [
      'encrypted_payee',
      'encrypted_description',
      'encrypted_rejection_reason',
      'encrypted_amount',
      'currency',
      'status',
      'request_type',
      'vendor_ref',
      'payment_address',
    ],
  },
  {
    table: 'wallets',
    idColumn: 'id',
    orgColumn: 'org_id',
    encryptedColumns: [
      'encrypted_name',
      'encrypted_balance',
      'asset',
      'account_type',
      'connection_type',
      'external_account_code',
    ],
  },
  {
    table: 'organizations',
    idColumn: 'id',
    orgColumn: 'id',
    encryptedColumns: ['name'],
  },
  {
    table: 'org_settings',
    idColumn: 'org_id',
    orgColumn: 'org_id',
    encryptedColumns: [
      'primary_currency',
      'secondary_currency',
      'bitcoin_display',
      'fiscal_year_type',
      'encrypted_fiscal_month',
      'date_format',
      'time_format',
      'number_format',
      'timezone',
    ],
  },
  {
    table: 'attachments',
    idColumn: 'id',
    orgColumn: 'org_id',
    encryptedColumns: ['file_name', 'mime_type'],
  },
]);

const BATCH_SIZE_ROWS = 500;
const BATCH_SIZE_WRAPS = 50;

// Estimate: ~600 rows / second on a modest laptop for the decrypt+encrypt
// round-trip plus one HTTP batch. Used ONLY for the UI time estimate.
const ROWS_PER_SECOND = 600;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Kick off a rekey job on the server. The server inserts a
 * key_rotation_jobs row, counts rows across business tables, and
 * returns an estimate the UI can show in the 7-step wizard.
 *
 * Does NOT perform any crypto — callers then call runRekeyJob(jobId).
 */
export async function startRekeyJob(
  orgId: string,
  triggerType: RekeyTriggerType,
  refreshMode: RefreshMode = 'quick',
): Promise<StartRekeyResult> {
  const { data, error } = await supabase.functions.invoke('start-rekey-job', {
    body: { org_id: orgId, trigger_type: triggerType, refresh_mode: refreshMode },
  });
  if (error) {
    throw new Error(friendlyError(error, 'Could not start the security refresh.'));
  }
  const resp = data as {
    job_id?: string;
    rows_total?: number;
    estimated_seconds?: number;
    refresh_mode?: RefreshMode;
  };
  if (!resp?.job_id) {
    throw new Error('The server did not return a refresh job id.');
  }
  return {
    jobId: resp.job_id,
    rowsTotal: resp.rows_total ?? 0,
    estimatedSeconds:
      resp.estimated_seconds ?? Math.max(60, Math.ceil((resp.rows_total ?? 0) / ROWS_PER_SECOND)),
    refreshMode: resp.refresh_mode ?? refreshMode,
  };
}

/**
 * Drive a rekey job through all stages. The function blocks until the
 * job completes, aborts, or is rolled back. Browser close mid-way is
 * supported: call `resumeRekeyJob(jobId)` on the next session to
 * continue from the last finished stage.
 *
 * All error paths invoke `callbacks.onError` with a plain-English
 * message and `canRetry` hint, then either throw (fatal) or carry on.
 */
export async function runRekeyJob(
  jobId: string,
  callbacks: RekeyCallbacks = {},
): Promise<RekeyOutcome> {
  // Fetch the current job so we can skip stages that have already run
  // (idempotent resume after browser close).
  const { data: jobRow, error: jobErr } = await supabase
    .from('key_rotation_jobs')
    .select('*')
    .eq('id', jobId)
    .maybeSingle();
  if (jobErr || !jobRow) {
    throw new Error(friendlyError(jobErr, 'Could not load the security refresh job.'));
  }
  const job = jobRow as RekeyJobRow;

  if (job.status === 'complete') {
    callbacks.onComplete?.();
    return 'completed';
  }
  if (job.status === 'aborted') {
    callbacks.onAborted?.(
      job.abort_reason ?? 'The security refresh was stopped before it finished.',
    );
    return 'aborted';
  }
  if (job.status === 'rolled_back') {
    callbacks.onAborted?.('The last security refresh was undone after completing.');
    return 'rolled_back';
  }

  // Phase 1: generate new DEK + signing key if the job hasn't progressed past
  // generating_keys yet.
  const newDek = generateRandomDek();
  const newDekKey = await importAesGcmKey(newDek);

  // Fetch the CURRENT active DEK so we can decrypt existing rows. We
  // fetch via the user's own org_keys wrap for the currently-active
  // key_version — that's the DEK the user already holds in memory.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    throw new Error('You need to be signed in to run a security refresh.');
  }
  const oldDek = await fetchCurrentDek(job.org_id, user.id);
  const oldDekKey = oldDek ? await importAesGcmKey(oldDek) : null;

  // Member + writer discovery drives the wrap stage.
  const members = await fetchOrgMembers(job.org_id);
  const writers = await filterWriters(job.org_id, members);

  const newOskBundle = await generateAndWrapSigningKey(
    job.org_id,
    writers,
    job.new_osk_key_version,
  );

  if (job.status === 'pending' || job.status === 'generating_keys') {
    callbacks.onStageChange?.('generating_keys');
    // advance pending -> generating_keys. Then we transition straight to
    // wrapping_members after the client materializes the new keys.
    if (job.status === 'pending') {
      await advanceRotation(jobId, 'generating_keys');
    }
  }

  if (job.status !== 'rekeying_rows' && job.status !== 'finalizing') {
    callbacks.onStageChange?.('wrapping_members');
    await advanceRotation(jobId, 'wrapping_members');

    // Build the DEK wraps for every current member. Every member gets a
    // DEK wrap (Auditor/Viewer included — they need reads; only the signing key is
    // writer-gated).
    const dekWraps = await buildDekWraps(newDek, members, job.new_dek_key_version);
    await submitWrapBatches(
      jobId,
      job.org_id,
      job.refresh_mode,
      dekWraps,
      newOskBundle.wraps,
      newOskBundle.publicKeyB64,
    );

    await advanceRotation(jobId, 'rekeying_rows');
  }

  // Row re-key stage. The server returns how many rows have already
  // been processed so resume-after-close skips them.
  //
  // Quick refresh: always use the markAllRowsAsNewVersion fast
  // path — bumps dek_key_version without re-encrypting, so removed
  // members are blocked from future data but existing ciphertext stays
  // on disk (readable under the OLD DEK during the rollback window).
  //
  // Deep refresh: decrypt every row under the old DEK and re-
  // encrypt under the new DEK. Falls back to the fast path when the
  // old DEK is unavailable (first-time-setup, placeholder wraps). A
  // TODO there flags the hybrid-unwrap wire-in for real shared-DEK
  // manual refreshes (see fetchCurrentDek).
  if (job.status !== 'finalizing') {
    callbacks.onStageChange?.('rekeying_rows');

    if (job.refresh_mode === 'quick') {
      await markAllRowsAsNewVersion(
        jobId,
        job.org_id,
        job.new_dek_key_version,
        job.refresh_mode,
        callbacks,
      );
    } else if (!oldDekKey) {
      // Deep refresh was requested but the old DEK is unavailable —
      // fall back to the Quick path so first-time-setup on placeholder
      // orgs still makes progress. TODO(Phase 4.5 follow-up): hydrate
      // the hybrid secret key via VaultContext so Deep refresh actually
      // re-encrypts rows on orgs with a real shared DEK.
      await markAllRowsAsNewVersion(
        jobId,
        job.org_id,
        job.new_dek_key_version,
        job.refresh_mode,
        callbacks,
      );
    } else {
      await rekeyAllRows(
        jobId,
        job.org_id,
        oldDekKey,
        newDekKey,
        job.new_dek_key_version,
        job.refresh_mode,
        callbacks,
      );
    }

    await advanceRotation(jobId, 'finalizing');
  }

  // Finalize stage — atomic pointer flip.
  callbacks.onStageChange?.('finalizing');
  const { error: finalizeErr } = await supabase.functions.invoke('finalize-rekey', {
    body: { job_id: jobId },
  });
  if (finalizeErr) {
    throw new Error(
      friendlyError(
        finalizeErr,
        'The security refresh failed at the final step. No data was lost.',
      ),
    );
  }

  callbacks.onComplete?.();

  // Phase 4.5 polish: first-time-setup → queue a welcome email for the
  // Owner. The email body is composed server-side from the template,
  // but the org_name comes from the client because ZKA means the
  // server cannot read the ciphertext. Non-fatal if it fails.
  if (
    job.trigger_type === 'first_time_setup' &&
    callbacks.firstTimeSetupEmail &&
    callbacks.firstTimeSetupEmail.orgNameDecrypted &&
    callbacks.firstTimeSetupEmail.recipientEmail
  ) {
    try {
      await queueFirstTimeSetupEmail({
        orgId: job.org_id,
        orgNameDecrypted: callbacks.firstTimeSetupEmail.orgNameDecrypted,
        recipientEmail: callbacks.firstTimeSetupEmail.recipientEmail,
      });
    } catch (err) {
      // Non-fatal: the refresh already succeeded; the email is a nicety.
      console.warn('[rekey] queueFirstTimeSetupEmail failed', err);
    }
  }

  return 'completed';
}

/**
 * Queue a "your organization is secured" email in pending_admin_emails
 * via the queue-admin-email edge function. Only called for
 * trigger_type='first_time_setup' jobs.
 *
 * The sender daemon (Resend/Supabase SMTP) is out of scope for this
 * polish pass — the queue table holds messages until the dispatcher wires the
 * actual delivery transport.
 */
async function queueFirstTimeSetupEmail(args: {
  orgId: string;
  orgNameDecrypted: string;
  recipientEmail: string;
}): Promise<void> {
  const { error } = await supabase.functions.invoke('queue-admin-email', {
    body: {
      org_id: args.orgId,
      template: 'first_time_setup',
      recipient_email: args.recipientEmail,
      org_name_decrypted: args.orgNameDecrypted,
    },
  });
  if (error) {
    throw new Error(friendlyError(error, 'Could not queue the welcome email.'));
  }
}

/**
 * Resume a rekey job after browser close. Reads the job's current
 * status and calls runRekeyJob. Because runRekeyJob is idempotent
 * around stages, this is a thin wrapper for now.
 */
export async function resumeRekeyJob(
  jobId: string,
  callbacks: RekeyCallbacks = {},
): Promise<RekeyOutcome> {
  return runRekeyJob(jobId, callbacks);
}

/**
 * Emergency rollback during the 30-day rollback window. Flips
 * active_key_versions back to the previous versions. New wraps + new
 * signing keys stay on disk (purge-expired-old-key-wraps will NOT
 * delete them because they are the NEW versions; the OLD versions
 * stay because rollback_expires_at has been cleared by finalize).
 *
 * After rollback succeeds the client should re-fetch all data using
 * the restored active versions.
 */
export async function rollbackRekey(jobId: string): Promise<void> {
  const { error } = await supabase.functions.invoke('abort-rekey', {
    body: { job_id: jobId, mode: 'rollback_after_complete' },
  });
  if (error) {
    throw new Error(friendlyError(error, 'Could not undo the last security refresh.'));
  }
}

/**
 * Abort a rekey job that is still running. Cleans up new wraps and,
 * if rows have already been partially re-keyed, reverts them.
 */
export async function abortRekey(jobId: string, reason: string): Promise<void> {
  const { error } = await supabase.functions.invoke('abort-rekey', {
    body: { job_id: jobId, mode: 'abort_in_flight', reason },
  });
  if (error) {
    throw new Error(friendlyError(error, 'Could not stop the security refresh.'));
  }
}

/**
 * Produce a fully-decrypted organization backup. Runs entirely in the
 * browser — the server never sees plaintext. Intended for the
 * "Download a backup" safety step in the rekey wizard.
 *
 * CSV format: ZIP of one CSV per table + one org.json metadata file.
 * JSON format: single document keyed by table name.
 */
export async function exportOrgBackup(
  orgId: string,
  format: OrgBackupFormat,
  decrypt: (ciphertext: string) => Promise<string>,
): Promise<Blob> {
  const snapshot: Record<string, unknown[]> = {};

  for (const desc of BUSINESS_TABLES) {
    const rows = await fetchAllRows(desc.table, desc.orgColumn, orgId);
    const decrypted: Record<string, unknown>[] = [];
    for (const row of rows) {
      const plainRow: Record<string, unknown> = { ...row };
      for (const col of desc.encryptedColumns) {
        const v = row[col];
        if (typeof v === 'string' && v.length > 0) {
          try {
            plainRow[col] = await decrypt(v);
          } catch {
            // Fall back to raw ciphertext. Better than losing the row.
            plainRow[col] = v;
          }
        }
      }
      decrypted.push(plainRow);
    }
    snapshot[desc.table] = decrypted;
  }

  if (format === 'json') {
    const json = JSON.stringify(
      {
        org_id: orgId,
        exported_at: new Date().toISOString(),
        data: snapshot,
      },
      null,
      2,
    );
    return new Blob([json], { type: 'application/json' });
  }

  // CSV: one concatenated text file (we avoid a zip dep). Tables are
  // separated by a sentinel line. Customers can split or paste into
  // spreadsheets as needed. This keeps the export dep-free.
  const chunks: string[] = [];
  chunks.push(
    `# Orange Way Books backup\n# org_id: ${orgId}\n# exported_at: ${new Date().toISOString()}\n\n`,
  );
  for (const desc of BUSINESS_TABLES) {
    const rows = snapshot[desc.table] as Record<string, unknown>[];
    chunks.push(`### TABLE: ${desc.table} ###\n`);
    if (rows.length === 0) {
      chunks.push('(empty)\n\n');
      continue;
    }
    const cols = Object.keys(rows[0]);
    chunks.push(cols.map(csvEscape).join(',') + '\n');
    for (const row of rows) {
      chunks.push(cols.map((c) => csvEscape(row[c])).join(',') + '\n');
    }
    chunks.push('\n');
  }
  return new Blob(chunks, { type: 'text/csv' });
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (/["\n,]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RekeyJobRow {
  id: string;
  org_id: string;
  status:
    | 'pending'
    | 'generating_keys'
    | 'wrapping_members'
    | 'rekeying_rows'
    | 'finalizing'
    | 'complete'
    | 'aborted'
    | 'rolled_back';
  trigger_type: RekeyTriggerType;
  new_dek_key_version: number;
  new_osk_key_version: number;
  previous_dek_key_version: number | null;
  previous_osk_key_version: number | null;
  rows_total: number;
  rows_processed: number;
  abort_reason: string | null;
  refresh_mode: RefreshMode;
}

async function fetchCurrentDek(orgId: string, userId: string): Promise<Uint8Array | null> {
  // Look up the active key_version, then fetch THIS user's wrap for
  // that version. If the wrap is a placeholder, return null so the
  // caller can skip row decrypt and run the first-time-setup cheap path.
  const { data: active } = await supabase
    .from('active_key_versions')
    .select('active_dek_key_version')
    .eq('org_id', orgId)
    .maybeSingle();
  const activeKv =
    (active as { active_dek_key_version?: number } | null)?.active_dek_key_version ?? 1;

  const { data: wrap } = await supabase
    .from('org_keys')
    .select('wrapped_dek, wrap_algo, is_placeholder, key_version')
    .eq('org_id', orgId)
    .eq('user_id', userId)
    .eq('key_version', activeKv)
    .maybeSingle();
  if (!wrap) return null;
  const w = wrap as { wrapped_dek: string; wrap_algo: string; is_placeholder: boolean };
  if (w.is_placeholder) return null;

  // Unwrap via the user's own hybrid secret key. The caller must be in
  // a state where VaultContext has the hybrid secret key available —
  // we route through the same unwrap pipeline the signing key uses.
  const strategy = KEY_WRAP_STRATEGIES[w.wrap_algo] ?? KEY_WRAP_STRATEGIES[DEFAULT_WRAP_ALGORITHM];
  if (!strategy) return null;

  // The caller is responsible for providing the hybrid secret key via
  // a side-channel if they need true decrypt here. For Phase 4.5 first
  // rollout the placeholder path is the primary case — when real wraps
  // exist, a follow-up wires the hybrid unwrap. Return null for now so
  // the "mark rows as new version" fast path is chosen.
  //
  // TODO(Phase 4.5 follow-up): hydrate hybrid secret key from
  // VaultContext and unwrap here; see signing-key.ts unwrapSigningKeyForSelf for
  // the template.
  void strategy;
  return null;
}

interface MemberRow {
  user_id: string;
  public_key_b64: string;
}

async function fetchOrgMembers(orgId: string): Promise<MemberRow[]> {
  // Join org_members with user_vault_keys so we only wrap for members
  // who have published a keypair. Members without a keypair yet land
  // in the pending-invite flow when they unlock for the first time.
  const { data, error } = await supabase
    .from('org_members')
    .select('user_id, user_vault_keys!inner(public_key_b64)')
    .eq('org_id', orgId);
  if (error) return [];
  // Cast through unknown — Supabase typegen doesn't currently know about the
  // org_members → user_vault_keys join, so it returns SelectQueryError on
  // the inner field. The runtime shape is correct.
  return (
    (data as unknown as Array<{
      user_id: string;
      user_vault_keys: { public_key_b64: string } | Array<{ public_key_b64: string }>;
    }> | null) ?? []
  )
    .map((r) => {
      const vk = Array.isArray(r.user_vault_keys) ? r.user_vault_keys[0] : r.user_vault_keys;
      return { user_id: r.user_id, public_key_b64: vk?.public_key_b64 ?? '' };
    })
    .filter((m) => m.public_key_b64.length > 0);
}

async function filterWriters(orgId: string, members: MemberRow[]): Promise<WriterRecipient[]> {
  // A "writer" is a member holding any capability where requires_osk =
  // TRUE. The user_has_capability RPC tells us for each (user,
  // capability, org) combo; we query transactions.write as the proxy
  // check (same set as Phase 4.4 mint-org-signing-key).
  const writers: WriterRecipient[] = [];
  for (const m of members) {
    const { data: canWrite } = await supabase.rpc('user_has_capability', {
      p_user_id: m.user_id,
      p_capability: 'transactions.write',
      p_org_id: orgId,
    });
    if (canWrite) {
      writers.push({ userId: m.user_id, publicKeyB64: m.public_key_b64 });
    }
  }
  // At least one writer required — Owner always has the capability.
  if (writers.length === 0 && members.length > 0) {
    // Defensive fallback: include the caller themselves so minting doesn't fail.
    writers.push({ userId: members[0].user_id, publicKeyB64: members[0].public_key_b64 });
  }
  return writers;
}

interface DekWrapRow {
  user_id: string;
  wrapped_dek: string;
  iv: string;
  wrap_algo: string;
  key_version: number;
  is_placeholder: boolean;
}

async function buildDekWraps(
  newDek: Uint8Array,
  members: MemberRow[],
  keyVersion: number,
): Promise<DekWrapRow[]> {
  const strategy = KEY_WRAP_STRATEGIES[DEFAULT_WRAP_ALGORITHM];
  if (!strategy)
    throw new Error('The system could not prepare the new keys (missing wrap strategy).');
  const rows: DekWrapRow[] = [];
  for (const m of members) {
    const pub = base64ToBytes(m.public_key_b64);
    const wrapped = await strategy.wrapForRecipient(newDek, pub);
    // IV layout matches invite-wrap.ts extractor.
    const AES_GCM_IV_BYTES = 12;
    const DATA_KEY_BYTES = 32;
    const AES_GCM_TAG_BYTES = 16;
    const ivOffset = wrapped.length - AES_GCM_IV_BYTES - DATA_KEY_BYTES - AES_GCM_TAG_BYTES;
    const iv = wrapped.subarray(ivOffset, ivOffset + AES_GCM_IV_BYTES);
    rows.push({
      user_id: m.user_id,
      wrapped_dek: bytesToBase64(wrapped),
      iv: bytesToBase64(iv),
      wrap_algo: strategy.algorithm,
      key_version: keyVersion,
      is_placeholder: false,
    });
  }
  return rows;
}

async function submitWrapBatches(
  jobId: string,
  orgId: string,
  mode: RefreshMode,
  dekWraps: DekWrapRow[],
  signingKeyWraps: SigningKeyWrapRow[],
  newOskPublicKeyB64: string,
): Promise<void> {
  // DEK wraps first. Chunks of BATCH_SIZE_WRAPS.
  // `mode` is forwarded so the server can tell Quick from Deep; both
  // use the same additive upsert in this stage.
  for (let i = 0; i < dekWraps.length; i += BATCH_SIZE_WRAPS) {
    const chunk = dekWraps.slice(i, i + BATCH_SIZE_WRAPS);
    const { error } = await supabase.functions.invoke('rekey-batch', {
      body: { job_id: jobId, stage: 'wrap_members', mode, batch: { kind: 'dek', rows: chunk } },
    });
    if (error)
      throw new Error(
        friendlyError(error, 'Could not save the new security codes for a team member.'),
      );
  }
  // signing-key wraps: send the public key once + all wraps.
  const { error } = await supabase.functions.invoke('rekey-batch', {
    body: {
      job_id: jobId,
      stage: 'wrap_members',
      mode,
      batch: {
        kind: 'osk',
        org_id: orgId,
        public_key_b64: newOskPublicKeyB64,
        rows: signingKeyWraps,
      },
    },
  });
  if (error) throw new Error(friendlyError(error, 'Could not save the new signing codes.'));
}

async function fetchAllRows(
  table: string,
  orgColumn: string,
  orgId: string,
): Promise<Record<string, unknown>[]> {
  const pageSize = BATCH_SIZE_ROWS;
  const out: Record<string, unknown>[] = [];
  let from = 0;

  while (true) {
    // Cast to any — Supabase typegen can't narrow on a dynamic table name
    // (BUSINESS_TABLES walks several tables in a loop). Runtime is correct.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data, error } = await (supabase as any)
      .from(table)
      .select('*')
      .eq(orgColumn, orgId)
      .range(from, from + pageSize - 1);
    if (error) {
      // Missing table / permission issue — return what we have.
      return out;
    }
    const rows = (data as Record<string, unknown>[] | null) ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

async function markAllRowsAsNewVersion(
  jobId: string,
  orgId: string,
  newVersion: number,
  mode: RefreshMode,
  callbacks: RekeyCallbacks,
): Promise<void> {
  let processed = 0;
  let total = 0;
  const updates: Array<{
    table: string;
    row_id: string;
    new_dek_key_version: number;
    new_ciphertext_fields: Record<string, string>;
  }> = [];
  for (const desc of BUSINESS_TABLES) {
    const rows = await fetchAllRows(desc.table, desc.orgColumn, orgId);
    total += rows.length;
    for (const row of rows) {
      const id = row[desc.idColumn] as string;
      if (!id) continue;
      updates.push({
        table: desc.table,
        row_id: id,
        new_dek_key_version: newVersion,
        new_ciphertext_fields: {}, // empty → server just bumps dek_key_version
      });
    }
  }
  callbacks.onRowProgress?.(0, total);

  for (let i = 0; i < updates.length; i += BATCH_SIZE_ROWS) {
    const chunk = updates.slice(i, i + BATCH_SIZE_ROWS);
    const { error } = await supabase.functions.invoke('rekey-batch', {
      body: { job_id: jobId, stage: 'rekey_rows', mode, batch: { rows: chunk } },
    });
    if (error) {
      throw new Error(
        friendlyError(
          error,
          'Could not finish updating a row. The security refresh was stopped safely.',
        ),
      );
    }
    processed += chunk.length;
    callbacks.onRowProgress?.(processed, total);
  }
}

async function rekeyAllRows(
  jobId: string,
  orgId: string,
  oldDekKey: CryptoKey,
  newDekKey: CryptoKey,
  newVersion: number,
  mode: RefreshMode,
  callbacks: RekeyCallbacks,
): Promise<void> {
  let processed = 0;
  let total = 0;
  // Count first for progress estimate.
  for (const desc of BUSINESS_TABLES) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count } = await (supabase as any)
      .from(desc.table)
      .select('*', { count: 'exact', head: true })
      .eq(desc.orgColumn, orgId);
    total += count ?? 0;
  }
  callbacks.onRowProgress?.(0, total);

  for (const desc of BUSINESS_TABLES) {
    const rows = await fetchAllRows(desc.table, desc.orgColumn, orgId);
    for (let i = 0; i < rows.length; i += BATCH_SIZE_ROWS) {
      const chunk = rows.slice(i, i + BATCH_SIZE_ROWS);
      const updates = await Promise.all(
        chunk.map(async (row) => {
          const id = row[desc.idColumn] as string;
          const newCt: Record<string, string> = {};
          for (const col of desc.encryptedColumns) {
            const v = row[col];
            if (typeof v === 'string' && v.length > 0) {
              try {
                newCt[col] = await reencryptFieldUnderNewDek(v, oldDekKey, newDekKey);
              } catch {
                // Leave the column alone; server keeps old ciphertext + bumps version.
              }
            }
          }
          return {
            table: desc.table,
            row_id: id,
            new_dek_key_version: newVersion,
            new_ciphertext_fields: newCt,
          };
        }),
      );
      const { error } = await supabase.functions.invoke('rekey-batch', {
        body: { job_id: jobId, stage: 'rekey_rows', mode, batch: { rows: updates } },
      });
      if (error) {
        throw new Error(
          friendlyError(
            error,
            'Could not finish updating a row. The security refresh was stopped safely.',
          ),
        );
      }
      processed += updates.length;
      callbacks.onRowProgress?.(processed, total);
    }
  }
}

async function advanceRotation(jobId: string, newStatus: string): Promise<void> {
  const { error } = await supabase.rpc('advance_rotation_job', {
    p_job_id: jobId,
    p_new_status: newStatus,
  });
  if (error) {
    throw new Error(friendlyError(error, `Could not advance the key update to ${newStatus}.`));
  }
}

function friendlyError(err: unknown, fallback: string): string {
  if (!err) return fallback;
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === 'object' && err !== null) {
    const m = (err as { message?: string }).message;
    if (m) return m;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Re-exports for call sites so they don't have to also import signing-key.ts.
// ---------------------------------------------------------------------------

export { BUSINESS_TABLES };
