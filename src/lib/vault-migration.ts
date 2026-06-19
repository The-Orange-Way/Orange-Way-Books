/**
 * vault-migration — orchestrates opt-in vault KDF upgrades (v2 → v3).
 *
 * This module is the orchestration layer. It does NOT contain crypto
 * primitives (those live in `@/lib/vault`) and it does NOT contain field
 * layouts (those live in `@/lib/crypto-fields`). Its job is:
 *
 *   1. Re-verify the current password with the old MEK.
 *   2. Generate a fresh vault salt and derive the new v3 MEK.
 *   3. For every encrypted table in the org, decrypt under the old MEK
 *      and re-encrypt under the new MEK, holding everything in memory.
 *   4. Produce a fresh verifier under the new MEK.
 *   5. Call the `rpc_upgrade_vault_to_v3` pg function with the full
 *      pre-encrypted payload; the RPC writes every row plus the new
 *      verifier/salt/version inside a single transaction. Any raised
 *      exception rolls back the entire upgrade.
 *
 * The function is strictly opt-in (Settings surface), never automatic.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  deriveKeyForVersion,
  encryptText as cryptoEncrypt,
  decryptText as cryptoDecrypt,
  encryptBlob as cryptoEncryptBlob,
  decryptBlob as cryptoDecryptBlob,
  generateVaultSalt,
  createVaultVerifier,
  verifyVaultPassword,
  LATEST_VAULT_KEY_VERSION,
} from '@/lib/vault';
import {
  encryptOrganization, decryptOrganization,
  encryptContact, decryptContact,
  encryptWallet, decryptWallet,
  encryptTransaction, decryptTransaction,
  encryptJournalEntry, decryptJournalEntry,
  encryptJournalEntryLine, decryptJournalEntryLine,
  encryptChartOfAccount, decryptChartOfAccount,
  encryptPaymentRequest, decryptPaymentRequest,
  encryptAuditLog, decryptAuditLog,
  encryptOrgSettings, decryptOrgSettings,
  encryptAttachment, decryptAttachment,
} from '@/lib/crypto-fields';

export interface UpgradeProgressEvent {
  /** What stage the orchestrator is in. `table:read` / `table:rewrite` carry a `table` field. */
  phase:
    | 'verify'
    | 'precheck'
    | 'keygen'
    | 'table:read'
    | 'table:rewrite'
    | 'blob:download'
    | 'blob:rewrite'
    | 'commit'
    | 'cleanup'
    | 'done';
  /** Name of the table currently being processed, when applicable. */
  table?: string;
  /** Rows processed so far in this phase. */
  done: number;
  /** Expected total for this phase. */
  total: number;
}

export type UpgradeProgressCallback = (evt: UpgradeProgressEvent) => void;

export interface UpgradeVaultToV3Args {
  password: string;
  userId: string;
  orgId: string;
  supabase: SupabaseClient;
  onProgress?: UpgradeProgressCallback;
}

/** Tables handled by the upgrade, in the order the orchestrator processes them. */
const ENCRYPTED_TABLES = [
  'organizations',
  'contacts',
  'wallets',
  'transactions',
  'journal_entries',
  'journal_entry_lines',
  'chart_of_accounts',
  'payment_requests',
  'audit_logs',
  'org_settings',
] as const;

type PayloadUpdates = Record<string, Array<Record<string, unknown>>>;

/**
 * Upgrade an org's vault from v2 (PBKDF2) to v3 (Argon2id).
 *
 * Throws a descriptive error on any failure. On the server side the RPC
 * runs in a transaction so either every row moves to v3 or none do. On
 * the client side this function is re-entrant: if it fails mid-rewrite
 * the old ciphertext is untouched, so the user can retry.
 */
export async function upgradeVaultToV3(args: UpgradeVaultToV3Args): Promise<void> {
  const { password, userId, orgId, supabase } = args;
  const emit = args.onProgress ?? (() => {});

  // ── 1. Load current settings and verify the password under the OLD MEK ─
  emit({ phase: 'verify', done: 0, total: 1 });
  const { data: settings, error: settingsErr } = await supabase
    .from('org_settings')
    .select('*')
    .eq('org_id', orgId)
    .maybeSingle();
  if (settingsErr) throw settingsErr;
  if (!settings) throw new Error('Vault settings not found for this organization');
  const currentVersion: number = (settings as Record<string, unknown>).vault_key_version as number ?? 1;
  const currentSalt: string | null = ((settings as Record<string, unknown>).vault_salt as string | null) ?? null;
  const currentVerifier: string | null = ((settings as Record<string, unknown>).vault_verifier as string | null) ?? null;
  if (currentVersion >= LATEST_VAULT_KEY_VERSION) {
    throw new Error(`Vault is already at v${currentVersion}; no upgrade needed`);
  }
  if (currentVersion !== 2) {
    throw new Error(
      `Unsupported upgrade source version: v${currentVersion}. ` +
      'Only v2 → v3 is supported in this release.',
    );
  }
  if (!currentVerifier || !currentSalt) {
    throw new Error('Vault is not fully set up (missing verifier or salt)');
  }
  const oldPasswordOk = await verifyVaultPassword(password, userId, currentVerifier, currentSalt, currentVersion);
  if (!oldPasswordOk) throw new Error('Incorrect vault password');
  emit({ phase: 'verify', done: 1, total: 1 });

  // ── 2. Pre-flight ──────────────────────────────────────────────────────
  // No blocking checks remain — blob re-encryption is handled in step 4.5.
  emit({ phase: 'precheck', done: 0, total: 1 });
  emit({ phase: 'precheck', done: 1, total: 1 });

  // ── 3. Derive old and new MEKs + closures for encrypt/decrypt ──────────
  emit({ phase: 'keygen', done: 0, total: 1 });
  const oldMek = await deriveKeyForVersion(password, userId, currentSalt, currentVersion);
  const newSalt = generateVaultSalt();
  const newMek = await deriveKeyForVersion(password, userId, newSalt, LATEST_VAULT_KEY_VERSION);
  const oldDecrypt = (ct: string) => cryptoDecrypt(ct, oldMek);
  const newEncrypt = (pt: string) => cryptoEncrypt(pt, newMek);
  emit({ phase: 'keygen', done: 1, total: 1 });

  const updates: PayloadUpdates = Object.fromEntries(
    ENCRYPTED_TABLES.map((t) => [t, []]),
  );

  // ── 4. Per-table rewrite loop ──────────────────────────────────────────
  // The loop is straightforward: fetch → decrypt → re-encrypt → stage.
  // All row counts come from the server so we can emit meaningful progress.

  // organizations: exactly one row — the org itself
  {
    emit({ phase: 'table:read', table: 'organizations', done: 0, total: 1 });
    const { data: row, error } = await supabase
      .from('organizations')
      .select('id, name, key_version')
      .eq('id', orgId)
      .maybeSingle();
    if (error) throw error;
    if (row) {
      emit({ phase: 'table:rewrite', table: 'organizations', done: 0, total: 1 });
      const plain = await decryptOrganization(row as any, oldDecrypt);
      const ciph = await encryptOrganization(plain, newEncrypt);
      updates.organizations.push({ id: row.id, name: ciph.name });
      emit({ phase: 'table:rewrite', table: 'organizations', done: 1, total: 1 });
    }
  }

  // contacts
  await rewriteTable({
    supabase,
    table: 'contacts',
    select: 'id, name, street, city, state, zip, country, email, phone, type, key_version',
    eq: ['org_id', orgId],
    decrypt: (row) => decryptContact(row as any, oldDecrypt),
    encrypt: async (plain) => {
      const c = await encryptContact(plain as any, newEncrypt);
      return {
        name: c.name, street: c.street, city: c.city, state: c.state, zip: c.zip,
        country: c.country, email: c.email, phone: c.phone, type: c.type,
      };
    },
    updates,
    emit,
  });

  // wallets
  await rewriteTable({
    supabase,
    table: 'wallets',
    select: 'id, encrypted_name, encrypted_balance, initial_balance, asset, account_type, connection_type, external_account_code, key_version',
    eq: ['org_id', orgId],
    decrypt: (row) => decryptWallet(row, oldDecrypt),
    encrypt: async (plain) => {
      const c = await encryptWallet(plain as any, newEncrypt);
      return {
        encrypted_name: c.encrypted_name,
        encrypted_balance: c.encrypted_balance,
        asset: c.asset,
        account_type: c.account_type,
        connection_type: c.connection_type,
        external_account_code: c.external_account_code,
      };
    },
    updates,
    emit,
  });

  // transactions
  await rewriteTable({
    supabase,
    table: 'transactions',
    select: 'id, memo, encrypted_amount, encrypted_usd_value, encrypted_exchange_rate, amount, usd_value, exchange_rate, asset, type, status, cleared_status, key_version',
    eq: ['org_id', orgId],
    decrypt: (row) => decryptTransaction(row, oldDecrypt),
    encrypt: async (plain) => {
      const c = await encryptTransaction(plain as any, newEncrypt);
      return {
        memo: c.memo,
        encrypted_amount: c.encrypted_amount,
        encrypted_usd_value: c.encrypted_usd_value,
        encrypted_exchange_rate: c.encrypted_exchange_rate,
        asset: c.asset,
        type: c.type,
        status: c.status,
        cleared_status: c.cleared_status,
      };
    },
    updates,
    emit,
  });

  // journal_entries — gather ids as we go for the child lines query
  const journalEntryIds: string[] = [];
  await rewriteTable({
    supabase,
    table: 'journal_entries',
    select: 'id, memo, ref_number, currency, encrypted_exchange_rate, exchange_rate, status, source_type, period_locked, encrypted_period_locked, key_version',
    eq: ['org_id', orgId],
    decrypt: (row) => decryptJournalEntry(row, oldDecrypt),
    encrypt: async (plain) => {
      const c = await encryptJournalEntry(plain as any, newEncrypt);
      // Post-Phase 1 schema: encrypted_memo / encrypted_ref_number /
      // encrypted_currency replace the old plaintext column names.
      // status + source_type are plaintext.
      return {
        encrypted_memo: c.encrypted_memo,
        encrypted_ref_number: c.encrypted_ref_number,
        encrypted_currency: c.encrypted_currency,
        encrypted_exchange_rate: c.encrypted_exchange_rate,
        status: c.status,
        source_type: c.source_type,
        encrypted_period_locked: c.encrypted_period_locked,
      } as any;
    },
    updates,
    emit,
    onRow: (row) => { journalEntryIds.push((row as { id: string }).id); },
  });

  // journal_entry_lines — filtered by the parent JE ids we just gathered
  if (journalEntryIds.length > 0) {
    emit({ phase: 'table:read', table: 'journal_entry_lines', done: 0, total: journalEntryIds.length });
    const { data: lines, error } = await supabase
      .from('journal_entry_lines')
      .select('id, account_name, account_code, description, encrypted_debit, encrypted_credit, encrypted_book_value, debit, credit, book_value, encrypted_amount_native, encrypted_amount_primary, encrypted_posted_rate, encrypted_wallet_currency, key_version')
      .in('journal_entry_id', journalEntryIds);
    if (error) throw error;
    const lineRows = lines ?? [];
    emit({ phase: 'table:rewrite', table: 'journal_entry_lines', done: 0, total: lineRows.length });
    for (let i = 0; i < lineRows.length; i++) {
      const row = lineRows[i];
      const plain = await decryptJournalEntryLine(row, oldDecrypt);
      const c = await encryptJournalEntryLine(plain, newEncrypt);
      updates.journal_entry_lines.push({
        id: (row as { id: string }).id,
        account_name: c.account_name,
        account_code: c.account_code,
        description: c.description,
        encrypted_debit: c.encrypted_debit,
        encrypted_credit: c.encrypted_credit,
        encrypted_book_value: c.encrypted_book_value,
        encrypted_amount_native: c.encrypted_amount_native,
        encrypted_amount_primary: c.encrypted_amount_primary,
        encrypted_posted_rate: c.encrypted_posted_rate,
        encrypted_wallet_currency: c.encrypted_wallet_currency,
      });
      emit({ phase: 'table:rewrite', table: 'journal_entry_lines', done: i + 1, total: lineRows.length });
    }
  }

  // chart_of_accounts
  await rewriteTable({
    supabase,
    table: 'chart_of_accounts',
    select: 'id, encrypted_name, account_name, account_code, account_type, account_group, account_category, is_archived, encrypted_is_archived, parent_id, key_version',
    eq: ['org_id', orgId],
    decrypt: (row) => decryptChartOfAccount(row, oldDecrypt),
    encrypt: async (plain) => {
      const c = await encryptChartOfAccount(plain as any, newEncrypt);
      // Post-Phase 1 schema: fully-encrypted chart_of_accounts shape.
      return {
        encrypted_name: c.encrypted_name,
        encrypted_code: c.encrypted_code,
        encrypted_description: c.encrypted_description,
        encrypted_account_type: c.encrypted_account_type,
        encrypted_account_sub_type: c.encrypted_account_sub_type,
        encrypted_is_group: c.encrypted_is_group,
        encrypted_is_system: c.encrypted_is_system,
        encrypted_is_archived: c.encrypted_is_archived,
        encrypted_allowed_currencies: c.encrypted_allowed_currencies,
      } as any;
    },
    updates,
    emit,
  });

  // payment_requests
  await rewriteTable({
    supabase,
    table: 'payment_requests',
    select: 'id, encrypted_payee, encrypted_description, encrypted_rejection_reason, encrypted_amount, amount, currency, status, request_type, vendor_ref, payment_address, key_version',
    eq: ['org_id', orgId],
    decrypt: (row) => decryptPaymentRequest(row, oldDecrypt),
    encrypt: async (plain) => {
      const c = await encryptPaymentRequest(plain as any, newEncrypt);
      return {
        encrypted_payee: c.encrypted_payee,
        encrypted_description: c.encrypted_description,
        encrypted_rejection_reason: c.encrypted_rejection_reason,
        encrypted_amount: c.encrypted_amount,
        currency: c.currency,
        status: c.status,
        request_type: c.request_type,
        vendor_ref: c.vendor_ref,
        payment_address: c.payment_address,
      };
    },
    updates,
    emit,
  });

  // audit_logs
  await rewriteTable({
    supabase,
    table: 'audit_logs',
    select: 'id, summary, before_snapshot, after_snapshot, key_version',
    eq: ['org_id', orgId],
    decrypt: (row) => decryptAuditLog(row as any, oldDecrypt),
    encrypt: async (plain) => {
      const c = await encryptAuditLog(plain as any, newEncrypt);
      return {
        summary: c.summary,
        before_snapshot: c.before_snapshot,
        after_snapshot: c.after_snapshot,
      };
    },
    updates,
    emit,
  });

  // org_settings encrypted fields (single row)
  {
    emit({ phase: 'table:read', table: 'org_settings', done: 0, total: 1 });
    const plain = await decryptOrgSettings(settings as any, oldDecrypt);
    const ciph = await encryptOrgSettings(plain, newEncrypt);
    updates.org_settings.push({
      primary_currency: ciph.primary_currency,
      secondary_currency: ciph.secondary_currency,
      bitcoin_display: ciph.bitcoin_display,
      fiscal_year_type: ciph.fiscal_year_type,
      encrypted_fiscal_month: ciph.encrypted_fiscal_month,
      date_format: ciph.date_format,
      time_format: ciph.time_format,
      number_format: ciph.number_format,
      timezone: (plain as { timezone?: string | null }).timezone ?? null,
    });
    emit({ phase: 'table:rewrite', table: 'org_settings', done: 1, total: 1 });
  }

  // Include the primary org row id so the RPC can update organizations.name
  updates.organizations = updates.organizations.map((row) => ({ id: orgId, ...row }));

  // ── 4.5. Attachment blob re-encryption ────────────────────────────────
  // Strategy: upload new blobs FIRST, then commit the RPC (which atomically
  // flips every storage_path). On RPC failure we delete the new blobs; on
  // success we delete the old ones. The DB is never in a mixed state.
  updates['attachments'] = [];
  const newBlobPaths: string[] = [];
  const oldBlobPaths: string[] = [];

  try {
    const { data: attRows, error: attErr } = await supabase
      .from('attachments')
      .select('id, file_name, mime_type, storage_path, key_version')
      .eq('org_id', orgId);
    if (attErr) throw attErr;
    const attachments = (attRows ?? []) as Array<Record<string, unknown>>;

    emit({ phase: 'blob:download', done: 0, total: attachments.length });

    for (let i = 0; i < attachments.length; i++) {
      const row = attachments[i];
      const oldPath = row.storage_path as string;

      // Download encrypted blob
      emit({ phase: 'blob:download', done: i, total: attachments.length });
      const { data: blobData, error: dlErr } = await supabase.storage
        .from('attachments')
        .download(oldPath);
      if (dlErr) throw new Error(`Failed to download blob at ${oldPath}: ${dlErr.message}`);
      const encryptedBuf = await blobData!.arrayBuffer();

      // Decrypt → re-encrypt → upload to versioned path
      emit({ phase: 'blob:rewrite', done: i, total: attachments.length });
      const plainBuf = await cryptoDecryptBlob(encryptedBuf, oldMek);
      const newBlob = await cryptoEncryptBlob(plainBuf, newMek);
      const newPath = `${orgId}/v3/${row.id as string}`;
      const { error: ulErr } = await supabase.storage
        .from('attachments')
        .upload(newPath, newBlob, { contentType: 'application/octet-stream', upsert: true });
      if (ulErr) throw new Error(`Failed to upload blob to ${newPath}: ${ulErr.message}`);

      newBlobPaths.push(newPath);
      oldBlobPaths.push(oldPath);

      // Re-encrypt attachment metadata fields
      const plain = await decryptAttachment(row, oldDecrypt);
      const ciph = await encryptAttachment(plain, newEncrypt);
      updates['attachments'].push({
        id: row.id,
        file_name: ciph.file_name,
        mime_type: ciph.mime_type,
        storage_path: newPath,
        key_version: ciph.key_version,
      });

      emit({ phase: 'blob:rewrite', done: i + 1, total: attachments.length });
    }
  } catch (err) {
    // Upload failed mid-way — delete any blobs we already uploaded so Storage
    // and DB stay consistent (old DB rows still point to old paths).
    if (newBlobPaths.length > 0) {
      try { await supabase.storage.from('attachments').remove(newBlobPaths); } catch { /* best-effort */ }
    }
    throw err;
  }

  // ── 5. Build new verifier under the new MEK and commit the RPC ─────────
  emit({ phase: 'commit', done: 0, total: 1 });
  const newVerifier = await createVaultVerifier(password, userId, newSalt, LATEST_VAULT_KEY_VERSION);
  const { error: rpcErr } = await supabase.rpc('rpc_upgrade_vault_to_v3', {
    p_org_id: orgId,
    p_new_verifier: newVerifier,
    p_new_salt: newSalt,
    p_updates: updates,
  });
  if (rpcErr) {
    // RPC failed — DB is unchanged. Delete new blobs to keep Storage clean.
    if (newBlobPaths.length > 0) {
      try { await supabase.storage.from('attachments').remove(newBlobPaths); } catch { /* best-effort */ }
    }
    throw rpcErr;
  }
  emit({ phase: 'commit', done: 1, total: 1 });

  // ── 6. Cleanup: delete old blobs now that the RPC committed ───────────
  // Best-effort. Orphaned old blobs are harmless (inaccessible under the new
  // MEK) but waste storage. Any failure here is logged silently.
  if (oldBlobPaths.length > 0) {
    emit({ phase: 'cleanup', done: 0, total: oldBlobPaths.length });
    try {
      await supabase.storage.from('attachments').remove(oldBlobPaths);
    } catch { /* best-effort */ }
    emit({ phase: 'cleanup', done: oldBlobPaths.length, total: oldBlobPaths.length });
  }

  emit({ phase: 'done', done: 1, total: 1 });
}

interface RewriteTableArgs {
  supabase: SupabaseClient;
  table: string;
  select: string;
  eq: [string, string];
  decrypt: (row: unknown) => Promise<unknown>;
  encrypt: (plain: unknown) => Promise<Record<string, unknown>>;
  updates: PayloadUpdates;
  emit: UpgradeProgressCallback;
  onRow?: (row: unknown) => void;
}

async function rewriteTable(args: RewriteTableArgs): Promise<void> {
  const { supabase, table, select, eq, decrypt, encrypt, updates, emit, onRow } = args;
  emit({ phase: 'table:read', table, done: 0, total: 0 });
  const { data, error } = await supabase.from(table).select(select).eq(eq[0], eq[1]);
  if (error) throw error;
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  emit({ phase: 'table:rewrite', table, done: 0, total: rows.length });
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    onRow?.(row);
    const plain = await decrypt(row);
    const ciph = await encrypt(plain);
    updates[table].push({ id: row.id, ...ciph });
    emit({ phase: 'table:rewrite', table, done: i + 1, total: rows.length });
  }
}
