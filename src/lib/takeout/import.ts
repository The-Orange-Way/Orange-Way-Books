import { supabase } from '@/lib/supabase';
import {
  encryptWallet,
  encryptChartOfAccount,
  encryptContact,
  encryptTransaction,
  encryptJournalEntry,
  encryptJournalEntryLine,
  encryptPaymentRequest,
  encryptOrgSettings,
  encryptOrganization,
  encryptAttachment,
} from '@/lib/crypto-fields';
// Phase 2 removal: takeout/import no longer provisions legacy ledger backend. Data restore
// writes Postgres-only. The replayLegacyTemplates and legacy ledger backend-account creation
// blocks below are stubbed; chart_of_accounts insert path needs follow-up
// rewiring for the new schema (tracked as Phase 2.5 cleanup).
import { TAKEOUT_VERSION, type TakeoutFile, type TakeoutLegacyAccount } from './schema';

type EncryptFn = (plaintext: string) => Promise<string>;
type EncryptBlobFn = (plaintext: ArrayBuffer | Uint8Array) => Promise<Blob>;

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function inferNormalBalance(acct: TakeoutLegacyAccount): 'DEBIT' | 'CREDIT' {
  if (acct.normal_balance === 'DEBIT' | acct.normal_balance === 'CREDIT') return acct.normal_balance;
  const t = acct.account_type.toUpperCase();
  if (t === 'ASSET' | t === 'EXPENSE') return 'DEBIT';
  return 'CREDIT';
}

/**
 * Delete every org-scoped row (and Storage blob) for a given org, in
 * FK-respecting order. Used by force-mode import and the standalone
 * "Wipe all data" button in Admin.
 *
 * Does NOT delete the organization row itself (you keep the target org
 * to import into). legacy ledger backend ledger state on the server is not touched —
 * the legacy ledger accounts / journal become unreferenced and a subsequent
 * import will create fresh ones.
 */
export async function wipeOrgData(orgId: string): Promise<void> {
  // Storage blobs first (so we don't orphan them when we delete metadata).
  const { data: atts } = await supabase
    .from('attachments')
    .select('storage_path')
    .eq('org_id', orgId);
  const paths = (atts ?? []).map((a: any) => a.storage_path).filter(Boolean);
  if (paths.length > 0) {
    await supabase.storage.from('attachments').remove(paths);
  }

  const check = (label: string, error: { message: string } | null | undefined) => {
    if (error) throw new Error(`Wipe ${label} failed: ${error.message}`);
  };

  check('attachments', (await supabase.from('attachments').delete().eq('org_id', orgId)).error);
  check('payment_requests', (await supabase.from('payment_requests').delete().eq('org_id', orgId)).error);
  const { data: jes, error: jesQueryErr } = await supabase
    .from('journal_entries')
    .select('id')
    .eq('org_id', orgId);
  check('journal_entries lookup', jesQueryErr);
  const jeIds = (jes ?? []).map((r: any) => r.id);
  // PostgREST URLs with .in(...) over many UUIDs blow past the server's
  // URL-length limit (~8KB) and return 400 Bad Request. Chunk the delete
  // so each URL stays well below the limit.
  const JE_WIPE_BATCH = 80;
  for (let i = 0; i < jeIds.length; i += JE_WIPE_BATCH) {
    const batch = jeIds.slice(i, i + JE_WIPE_BATCH);
    check(
      'journal_entry_lines',
      (await supabase.from('journal_entry_lines').delete().in('journal_entry_id', batch)).error,
    );
  }
  check('journal_entries', (await supabase.from('journal_entries').delete().eq('org_id', orgId)).error);
  check('transactions', (await supabase.from('transactions').delete().eq('org_id', orgId)).error);
  check('wallets', (await supabase.from('accounts').delete().eq('org_id', orgId)).error);
  check('contacts', (await supabase.from('contacts').delete().eq('org_id', orgId)).error);
  check('chart_of_accounts', (await supabase.from('chart_of_accounts' as any).delete().eq('org_id', orgId)).error);
  // Clear the journal link on the org (it'll be re-set on next import).
  check(
    'organization journal link',
    (await supabase.from('organizations').update({ external_journal_id: null } as any).eq('id', orgId)).error,
  );
}

const ZKA_TEMPLATE_CODES = [
  'ZKA_SALE',
  'ZKA_EXPENSE',
  'ZKA_PAYMENT_RECEIVED',
  'ZKA_PAYMENT_SENT',
  'ZKA_BTC_PURCHASE',
  'ZKA_BTC_SALE',
  'ZKA_MANUAL_JE',
  'ZKA_TRANSFER',
  'ZKA_LIGHTNING_IN',
  'ZKA_LIGHTNING_OUT',
];

// Phase 2 (legacy-ledger removal): replayLegacyTemplates is a no-op. No server-side
// legacy ledger backend templates exist anymore. The ZKA_TEMPLATE_CODES list is kept for
// reference but unused.
async function replayLegacyTemplates(): Promise<void> {
  // intentionally empty
}

export interface ImportOptions {
  readonly force?: boolean;
  readonly onProgress?: (phase: string, done: number, total: number) => void;
  readonly encryptBlob?: EncryptBlobFn;
}

export interface ImportResult {
  readonly wallets: number;
  readonly contacts: number;
  readonly legacyAccounts: number;
  readonly transactions: number;
  readonly journalEntries: number;
  readonly journalEntryLines: number;
  readonly paymentRequests: number;
  readonly attachments: number;
  readonly attachmentsFailed: number;
}

/**
 * Import a plaintext takeout file into the given target org.
 *
 * ZKA note: every row is re-encrypted with the current vault before insert.
 * The plaintext file is held in memory only; no plaintext hits the database.
 *
 * legacy ledger backend: the blind legacy ledger backend ledger is re-created during import so that new
 * transactions work immediately after restore. We create:
 *   1. A fresh blind journal, stored on organizations.external_journal_id
 *   2. One legacy ledger account per chart_of_accounts row (with new UUID ids,
 *      remapped via legacyAccountIdMap)
 *   3. The 10 ZKA_* templates (idempotent — global in legacy ledger backend)
 * Historical transactions are NOT replayed as legacy ledger backend postings; the journal
 * lines in Supabase are the source of truth for reports. New transactions
 * made after the import get posted to legacy ledger backend as normal.
 */
export async function importTakeoutFile(
  file: TakeoutFile,
  targetOrgId: string,
  encryptText: EncryptFn,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  if (file._meta.version !== TAKEOUT_VERSION) {
    throw new Error(`Unsupported takeout version: ${file._meta.version}`);
  }
  if (file._meta.encryption !== 'none') {
    throw new Error(`Encrypted-mode takeouts are not yet supported. Got: ${file._meta.encryption}`);
  }

  const progress = opts.onProgress ?? (() => {});

  // Pre-flight: refuse if org already has data, unless force = true.
  if (!opts.force) {
    const [w, t, j] = await Promise.all([
      supabase.from('accounts').select('id', { count: 'exact', head: true }).eq('org_id', targetOrgId),
      supabase.from('transactions').select('id', { count: 'exact', head: true }).eq('org_id', targetOrgId),
      supabase.from('journal_entries').select('id', { count: 'exact', head: true }).eq('org_id', targetOrgId),
    ]);
    const total = (w.count ?? 0) + (t.count ?? 0) + (j.count ?? 0);
    if (total > 0) {
      throw new Error(
        `Target org already has ${total} rows (wallets + transactions + journal entries). Use force mode to wipe and replace.`,
      );
    }
  } else {
    progress('Wiping target org', 0, 1);
    await wipeOrgData(targetOrgId);
    progress('Wiping target org', 1, 1);
  }

  const data = file.data;

  // ── ID maps ─────────────────────────────────────────────────────────
  const walletIdMap = new Map<string, string>();
  data.wallets.forEach((w) => walletIdMap.set(w.id, crypto.randomUUID()));

  const contactIdMap = new Map<string, string>();
  data.contacts.forEach((c) => contactIdMap.set(c.id, crypto.randomUUID()));

  const legacyAccountPkMap = new Map<string, string>();
  const legacyAccountIdMap = new Map<string, string>(); // old legacy_account_id -> new legacy_account_id
  data.chart_of_accounts.forEach((a) => {
    legacyAccountPkMap.set(a.id, crypto.randomUUID());
    legacyAccountIdMap.set(a.legacy_account_id, crypto.randomUUID());
  });

  const jeIdMap = new Map<string, string>();
  data.journal_entries.forEach((je) => jeIdMap.set(je.id, crypto.randomUUID()));

  // Transactions and payments are auto-ID'd today, but attachments reference
  // entity_id. Pre-generate IDs so the attachment upload phase can remap.
  const txIdMap = new Map<string, string>();
  data.transactions.forEach((t) => txIdMap.set(t.id, crypto.randomUUID()));
  const paymentIdMap = new Map<string, string>();
  data.payment_requests.forEach((p) => paymentIdMap.set(p.id, crypto.randomUUID()));

  // Phase 2 (legacy-ledger removal): legacy ledger backend journal provisioning + template replay
  // both deleted. Data restore is Postgres-only.

  // ── Organization name ───────────────────────────────────────────────
  // Rename the target org to match the takeout. Import is always INTO an
  // existing org (by id), but the user expects the sidebar label to track
  // the seed / imported dataset.
  const takeoutOrgName = data.organizations?.[0]?.name;
  if (takeoutOrgName) {
    progress('Organization', 0, 1);
    const encOrg = await encryptOrganization({ name: takeoutOrgName }, encryptText);
    await supabase
      .from('organizations')
      .update({ ...encOrg } as any)
      .eq('id', targetOrgId);
    progress('Organization', 1, 1);
  }

  // ── Org settings ────────────────────────────────────────────────────
  if (data.org_settings.length > 0) {
    progress('Org settings', 0, 1);
    const s = data.org_settings[0];
    const enc = await encryptOrgSettings(
      {
        bitcoin_display: s.bitcoin_display,
        primary_currency: s.primary_currency,
        secondary_currency: s.secondary_currency,
      } as any,
      encryptText,
    );
    await supabase.from('org_settings').upsert({ ...enc, org_id: targetOrgId } as any);
    progress('Org settings', 1, 1);
  }

  // ── Accounts ─────────────────────────────────────────────────────────
  let walletsInserted = 0;
  for (let i = 0; i < data.wallets.length; i++) {
    const w = data.wallets[i];
    const enc = await encryptWallet(
      {
        encrypted_name: w.name,
        initial_balance: w.initial_balance,
        asset: w.asset,
        account_type: w.account_type,
        connection_type: w.connection_type ?? null,
        legacy_account_code: w.legacy_account_code ?? null,
      },
      encryptText,
    );
    const newLegacyAccountId = w.legacy_account_id ? legacyAccountIdMap.get(w.legacy_account_id) ?? null : null;
    const { error } = await supabase.from('accounts').insert({
      id: walletIdMap.get(w.id),
      org_id: targetOrgId,
      external_account_id: newLegacyAccountId,
      ...enc,
    } as any);
    if (error) throw new Error(`Insert wallet failed: ${error.message}`);
    walletsInserted++;
    progress('Wallets', walletsInserted, data.wallets.length);
  }

  // ── legacy ledger account map (legacy ledger backend createAccount + Supabase row) ────────────
  let accountsInserted = 0;
  for (let i = 0; i < data.chart_of_accounts.length; i++) {
    const a = data.chart_of_accounts[i];
    const newLegacyId = legacyAccountIdMap.get(a.legacy_account_id)!;
    const normalBalance = inferNormalBalance(a);
    // Phase 2 (legacy-ledger removal): legacy ledger backend createAccount deleted. Account row inserted
    // directly into chart_of_accounts below (TODO follow-up: rewire this
    // block to use the new encryptChartOfAccount shape).
    const enc = await encryptChartOfAccount(
      {
        account_name: a.account_name,
        account_code: a.account_code,
        account_type: a.account_type,
        account_group: a.account_group,
        account_category: a.account_category,
        is_archived: a.is_archived ?? false,
        // Takeout schema still uses legacy parent_legacy_account_id field name
        // on the JSON file format. Read it then map to new parent_id.
        parent_id: (a as any).parent_legacy_account_id
          ? legacyAccountIdMap.get((a as any).parent_legacy_account_id) ?? null
          : null,
      },
      encryptText,
    );
    const { error } = await supabase.from('chart_of_accounts' as any).insert({
      id: legacyAccountPkMap.get(a.id),
      org_id: targetOrgId,
      ...enc,
    } as any);
    if (error) throw new Error(`Insert chart_of_accounts failed: ${error.message}`);
    accountsInserted++;
    progress('Chart of accounts', accountsInserted, data.chart_of_accounts.length);
  }

  // ── Contacts ────────────────────────────────────────────────────────
  let contactsInserted = 0;
  for (let i = 0; i < data.contacts.length; i++) {
    const c = data.contacts[i];
    const enc = await encryptContact(
      {
        name: c.name,
        email: c.email, phone: c.phone, type: c.type,
        street: c.street, city: c.city, state: c.state, zip: c.zip, country: c.country,
      },
      encryptText,
    );
    const { error } = await supabase.from('contacts').insert({
      id: contactIdMap.get(c.id),
      org_id: targetOrgId,
      ...enc,
    } as any);
    if (error) throw new Error(`Insert contact failed: ${error.message}`);
    contactsInserted++;
    progress('Contacts', contactsInserted, data.contacts.length);
  }

  // ── Transactions ────────────────────────────────────────────────────
  let txsInserted = 0;
  for (let i = 0; i < data.transactions.length; i++) {
    const t = data.transactions[i];
    const enc = await encryptTransaction(
      {
        memo: t.memo,
        amount: t.amount,
        usd_value: t.usd_value,
        exchange_rate: t.exchange_rate ?? null,
        asset: t.asset,
        type: t.type,
        status: t.status,
        cleared_status: t.cleared_status,
      } as any,
      encryptText,
    );
    const { error } = await supabase.from('transactions').insert({
      id: txIdMap.get(t.id),
      org_id: targetOrgId,
      account_id: t.account_id ? walletIdMap.get(t.account_id) ?? null : null,
      date: t.date,
      ...enc,
    } as any);
    if (error) throw new Error(`Insert transaction failed: ${error.message}`);
    txsInserted++;
    progress('Transactions', txsInserted, data.transactions.length);
  }

  // ── Journal entries ─────────────────────────────────────────────────
  let jesInserted = 0;
  for (let i = 0; i < data.journal_entries.length; i++) {
    const je = data.journal_entries[i];
    const enc = await encryptJournalEntry(
      {
        memo: je.memo,
        ref_number: je.ref_number,
        currency: je.currency,
        exchange_rate: je.exchange_rate,
        status: je.status,
        source_type: je.source_type,
        period_locked: je.period_locked,
      },
      encryptText,
    );
    const { error } = await supabase.from('journal_entries').insert({
      id: jeIdMap.get(je.id),
      org_id: targetOrgId,
      date: je.date,
      ...enc,
    } as any);
    if (error) throw new Error(`Insert journal entry failed: ${error.message}`);
    jesInserted++;
    progress('Journal entries', jesInserted, data.journal_entries.length);
  }

  // ── Journal entry lines ─────────────────────────────────────────────
  let linesInserted = 0;
  const BATCH = 50;
  for (let i = 0; i < data.journal_entry_lines.length; i += BATCH) {
    const batch = data.journal_entry_lines.slice(i, i + BATCH);
    const rows = await Promise.all(
      batch.map(async (l) => {
        const enc = await encryptJournalEntryLine(
          {
            account_name: l.account_name,
            account_code: l.account_code,
            description: l.description,
            debit: l.debit,
            credit: l.credit,
            book_value: null,
            amount_native: l.amount_native ?? null,
            amount_primary: l.amount_primary ?? null,
            posted_rate: l.posted_rate ?? null,
            wallet_currency: l.wallet_currency ?? null,
          },
          encryptText,
          {
            primary_currency_at_posting: l.primary_currency_at_posting ?? null,
            rate_pending: false,
          },
        );
        const newJeId = jeIdMap.get(l.journal_entry_id);
        if (!newJeId) throw new Error(`JE line references missing parent ${l.journal_entry_id}`);
        const newAccountId = l.account_id ? legacyAccountIdMap.get(l.account_id) ?? null : null;
        return {
          journal_entry_id: newJeId,
          account_id: newAccountId,
          ...enc,
        };
      }),
    );
    const { error } = await supabase.from('journal_entry_lines').insert(rows as any);
    if (error) throw new Error(`Insert journal_entry_lines failed: ${error.message}`);
    linesInserted += rows.length;
    progress('Journal entry lines', linesInserted, data.journal_entry_lines.length);
  }

  // ── Payment requests ────────────────────────────────────────────────
  let paymentsInserted = 0;
  for (let i = 0; i < data.payment_requests.length; i++) {
    const p = data.payment_requests[i];
    const enc = await encryptPaymentRequest(
      {
        payee: p.payee,
        description: p.description,
        rejection_reason: p.rejection_reason,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        request_type: p.request_type,
        vendor_ref: p.vendor_ref,
        payment_address: p.payment_address,
      },
      encryptText,
    );
    const { error } = await supabase.from('payment_requests').insert({
      id: paymentIdMap.get(p.id),
      org_id: targetOrgId,
      document_date: p.document_date ?? null,
      due_date: p.due_date ?? null,
      paid_at: p.paid_at ?? null,
      ...enc,
    } as any);
    if (error) throw new Error(`Insert payment_request failed: ${error.message}`);
    paymentsInserted++;
    progress('Payment requests', paymentsInserted, data.payment_requests.length);
  }

  // ── Attachments (receipts) ──────────────────────────────────────────
  let attachmentsInserted = 0;
  let attachmentsFailed = 0;
  const attachments = data.attachments ?? [];
  for (let i = 0; i < attachments.length; i++) {
    const att = attachments[i];
    progress('Receipts', i, attachments.length);
    if (!att.content_base64 | !opts.encryptBlob) {
      // No bytes captured, or no blob-encrypt available — skip without failing the whole import.
      attachmentsFailed++;
      continue;
    }
    const newEntityId =
      att.entity_type === 'transaction'
        ? txIdMap.get(att.entity_id)
        : paymentIdMap.get(att.entity_id);
    if (!newEntityId) {
      attachmentsFailed++;
      continue;
    }
    try {
      const plaintextBuf = base64ToArrayBuffer(att.content_base64);
      const encryptedBlob = await opts.encryptBlob(plaintextBuf);
      const storagePath = `${targetOrgId}/${newEntityId}/${crypto.randomUUID()}`;
      const up = await supabase.storage
        .from('attachments')
        .upload(storagePath, encryptedBlob, { contentType: 'application/octet-stream' });
      if (up.error) throw up.error;

      const encMeta = await encryptAttachment(
        { file_name: att.file_name, mime_type: att.mime_type },
        encryptText,
      );
      const { error } = await supabase.from('attachments').insert({
        org_id: targetOrgId,
        entity_type: att.entity_type,
        entity_id: newEntityId,
        storage_path: storagePath,
        file_size: att.file_size,
        ...encMeta,
      } as any);
      if (error) throw error;
      attachmentsInserted++;
    } catch (err) {
      console.warn('Attachment import failed', att.id, err);
      attachmentsFailed++;
    }
  }
  progress('Receipts', attachments.length, attachments.length);

  return {
    wallets: walletsInserted,
    contacts: contactsInserted,
    legacyAccounts: accountsInserted,
    transactions: txsInserted,
    journalEntries: jesInserted,
    journalEntryLines: linesInserted,
    paymentRequests: paymentsInserted,
    attachments: attachmentsInserted,
    attachmentsFailed,
  };
}
