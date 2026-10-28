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
// Phase 2 removal: takeout/import no longer provisions any separate ledger
// or posting templates. Data restore is Postgres-only. The chart_of_accounts
// insert path still needs follow-up rewiring for the new encrypted schema
// (tracked as Phase 2.5 cleanup).
import { TAKEOUT_VERSION, type TakeoutFile, type TakeoutLegacyAccount } from './schema';

type EncryptFn = (plaintext: string) => Promise<string>;
type EncryptBlobFn = (plaintext: ArrayBuffer | Uint8Array) => Promise<Blob>;

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/** journal_entries.status values that lock an entry against delete. */
const FINALIZED_JE_STATUSES = ['POSTED', 'VOID', 'VOID_REVERSAL'] as const;
/** journal_entries.status CHECK constraint. */
const JE_STATUSES = new Set(['DRAFT', ...FINALIZED_JE_STATUSES]);
/** journal_entries.source_type CHECK constraint. */
const JE_SOURCE_TYPES = new Set([
  'manual',
  'or_import',
  'invoice',
  'payment',
  'void_reversal',
  'fx_revaluation',
  'opening_balance',
  'takeout_import',
]);

/** Restored entries keep their source type when the database accepts it
 *  (matched without regard to case, so older upper-case values survive).
 *  null stays null: the app treats a null source as a hand-entered entry and
 *  offers reversal on it. A value the database would refuse (for example the
 *  'seed' label of the generated samples) is stored as null. */
function normalizeSourceType(sourceType: string | null): string | null {
  if (!sourceType) return null;
  const lower = sourceType.toLowerCase();
  return JE_SOURCE_TYPES.has(lower) ? lower : null;
}

const isText = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isNumber = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
/** A real calendar date (YYYY-MM-DD, optionally followed by a time).
 *  Date.parse alone accepts 2026-02-30; PostgreSQL does not. */
const isDate = (v: unknown): boolean => {
  if (typeof v !== 'string') return false;
  // Anchored at both ends: a date, optionally with a time and zone, and
  // nothing else (trailing characters such as NUL are refused by PostgreSQL).
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?(?:Z|[+-](?:0\d|1[0-5])(?::?[0-5]\d)?)?)?$/.exec(
      v,
    );
  if (!m || Number.isNaN(Date.parse(v))) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
};
const isOptionalDate = (v: unknown): boolean => v == null || isDate(v);
const isOptionalNumber = (v: unknown): boolean => v == null || isNumber(v);
const isOptionalText = (v: unknown): boolean => v == null || typeof v === 'string';
const isObject = (v: unknown): boolean => typeof v === 'object' && v !== null;

function inferNormalBalance(acct: TakeoutLegacyAccount): 'DEBIT' | 'CREDIT' {
  if (acct.normal_balance === 'DEBIT' || acct.normal_balance === 'CREDIT')
    return acct.normal_balance;
  const t = acct.account_type.toUpperCase();
  if (t === 'ASSET' || t === 'EXPENSE') return 'DEBIT';
  return 'CREDIT';
}

/**
 * Delete every org-scoped row (and Storage blob) for a given org, in
 * FK-respecting order. Used by force-mode import and the standalone
 * "Wipe all data" button in Admin.
 *
 * Does NOT delete the organization row itself (you keep the target org
 * to import into). Nothing outside Postgres is touched.
 */
export async function wipeOrgData(orgId: string): Promise<void> {
  // Posted, voided and reversal entries are immutable in the database
  // (trg_protect_finalized_je / _jel refuse DELETE). Check before deleting
  // anything, so the wipe cannot stop halfway and leave a partial company.
  const { count: finalizedCount, error: finalizedErr } = await supabase
    .from('journal_entries')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', orgId)
    .in('status', FINALIZED_JE_STATUSES as unknown as string[]);
  if (finalizedErr) throw new Error(`Wipe check failed: ${finalizedErr.message}`);
  if ((finalizedCount ?? 0) > 0) {
    throw new Error(
      `This company has ${finalizedCount} finalized journal entries, which cannot be deleted. Nothing was changed. Restore into a new company instead.`,
    );
  }

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
  check(
    'payment_requests',
    (await supabase.from('payment_requests').delete().eq('org_id', orgId)).error,
  );
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
  check(
    'journal_entries',
    (await supabase.from('journal_entries').delete().eq('org_id', orgId)).error,
  );
  check('transactions', (await supabase.from('transactions').delete().eq('org_id', orgId)).error);
  check('wallets', (await supabase.from('wallets').delete().eq('org_id', orgId)).error);
  check('contacts', (await supabase.from('contacts').delete().eq('org_id', orgId)).error);
  check(
    'chart_of_accounts',
    (
      await supabase
        .from('chart_of_accounts' as any)
        .delete()
        .eq('org_id', orgId)
    ).error,
  );
  // Clear the journal link on the org. Post-Phase-2 nothing re-sets it on
  // import, so the column stays null; the field is kept for backward
  // compatibility with older rows.
  check(
    'organization journal link',
    (
      await supabase
        .from('organizations')
        .update({ external_journal_id: null } as any)
        .eq('id', orgId)
    ).error,
  );
}

/**
 * Check that every reference inside a takeout file resolves inside the same
 * file, before anything is written. A restore that fails halfway in force
 * mode would leave the target company emptied, so this runs before the wipe.
 *
 * Chart rows can be referenced by either their `id` (exports) or their
 * `legacy_account_id` (generated seed files); both resolve to the same row.
 * Returns a list of human-readable problems; empty means the file is sound.
 */
export function validateTakeoutFile(file: TakeoutFile): string[] {
  const data = (file as { data?: Partial<TakeoutFile['data']> }).data;
  const arrays = [
    'organizations',
    'org_settings',
    'wallets',
    'chart_of_accounts',
    'contacts',
    'transactions',
    'journal_entries',
    'journal_entry_lines',
    'payment_requests',
  ] as const;
  const missing = arrays.filter((k) => !Array.isArray(data?.[k]));
  if (!data || missing.length > 0) {
    return [`The file is missing these sections: ${missing.join(', ') || 'data'}`];
  }
  if (data.attachments !== undefined && !Array.isArray(data.attachments)) {
    return ['The attachments section is not a list'];
  }
  return validateTakeoutData(data as TakeoutFile['data']);
}

function validateTakeoutData(data: TakeoutFile['data']): string[] {
  const problems: string[] = [];

  // PostgreSQL text columns refuse the NUL character, so a backup carrying
  // one anywhere would fail part way through, after the wipe.
  const hasNul = (v: unknown): boolean =>
    typeof v === 'string'
      ? v.includes('\u0000')
      : Array.isArray(v)
        ? v.some(hasNul)
        : v !== null && typeof v === 'object'
          ? Object.entries(v).some(([k, x]) => hasNul(k) || hasNul(x))
          : false;
  if (hasNul(data)) return ['The file contains an invalid character (NUL)'];

  // Every element must be an object before any field is read.
  for (const key of [
    'organizations',
    'org_settings',
    'wallets',
    'chart_of_accounts',
    'contacts',
    'transactions',
    'journal_entries',
    'journal_entry_lines',
    'payment_requests',
    'attachments',
  ] as const) {
    if (((data[key] ?? []) as readonly unknown[]).some((row) => !isObject(row))) {
      problems.push(`The ${key} section has an empty or invalid item`);
    }
  }
  if (problems.length > 0) return problems;

  // Every backup row is flat: each field is text, a number, true/false or
  // empty. Anything else would make encryption or the insert fail after the
  // wipe, so refuse it here.
  const isFlatValue = (v: unknown): boolean =>
    v == null || typeof v === 'string' || typeof v === 'boolean' || isNumber(v);
  for (const [key, rows] of Object.entries(data)) {
    if (!Array.isArray(rows)) continue;
    if (rows.some((row) => !Object.values(row as object).every(isFlatValue))) {
      problems.push(`The ${key} section has a field that is not text, a number or empty`);
    }
  }
  if (problems.length > 0) return problems;

  // Field shapes the inserts depend on.
  for (const a of data.chart_of_accounts) {
    if (!isText(a.id) || !isText(a.account_name) || !isText(a.account_type)) {
      problems.push(`An account is missing its id, name or type`);
    }
  }
  for (const w of data.wallets) {
    if (!isText(w.id) || !isText(w.name) || !isText(w.asset) || !isNumber(w.initial_balance)) {
      problems.push(`A wallet is missing its id, name, asset or opening balance`);
    }
  }
  for (const c of data.contacts) {
    if (!isText(c.id) || !isText(c.name)) problems.push(`A contact is missing its id or name`);
  }
  for (const t of data.transactions) {
    if (
      !isText(t.id) ||
      !isDate(t.date) ||
      !isNumber(t.amount) ||
      !isText(t.asset) ||
      !isText(t.type) ||
      !isOptionalNumber(t.usd_value) ||
      !isOptionalNumber(t.exchange_rate)
    ) {
      problems.push(`Transaction ${t.id} is missing a valid date, amount, asset or type`);
    }
  }
  for (const je of data.journal_entries) {
    if (!isText(je.id) || !isDate(je.date) || !isText(je.currency)) {
      problems.push(`Journal entry ${je.id} is missing a valid date or currency`);
    }
    if (typeof je.status !== 'string' || !JE_STATUSES.has(je.status.toUpperCase())) {
      problems.push(`Journal entry ${je.id} has an unknown status "${je.status}"`);
    }
    if (!isOptionalText(je.source_type) || !isOptionalNumber(je.exchange_rate)) {
      problems.push(`Journal entry ${je.id} has an invalid source type or exchange rate`);
    }
  }
  for (const l of data.journal_entry_lines) {
    if (
      !isText(l.id) ||
      !isNumber(l.debit) ||
      !isNumber(l.credit) ||
      !isOptionalNumber(l.amount_native) ||
      !isOptionalNumber(l.amount_primary) ||
      !isOptionalNumber(l.posted_rate)
    ) {
      problems.push(`Journal line ${l.id} has an amount that is not a number`);
    }
  }
  for (const p of data.payment_requests) {
    if (
      !isText(p.id) ||
      !isNumber(p.amount) ||
      !isText(p.currency) ||
      !isText(p.status) ||
      !isText(p.request_type)
    ) {
      problems.push(`Payment request ${p.id} is missing its amount, currency, status or type`);
    }
    if (
      !isOptionalDate(p.document_date) ||
      !isOptionalDate(p.due_date) ||
      !isOptionalDate(p.paid_at)
    ) {
      problems.push(`Payment request ${p.id} has a date that is not a real calendar date`);
    }
  }
  if (problems.length > 0) return problems;

  // Ids are reused as keys for the new rows, so they must be unique.
  const dupes = (label: string, ids: readonly string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) problems.push(`Two ${label} share the id ${id}`);
      seen.add(id);
    }
  };
  dupes(
    'wallets',
    data.wallets.map((w) => w.id),
  );
  dupes(
    'contacts',
    data.contacts.map((c) => c.id),
  );
  dupes(
    'transactions',
    data.transactions.map((t) => t.id),
  );
  dupes(
    'journal entries',
    data.journal_entries.map((je) => je.id),
  );
  dupes(
    'payment requests',
    data.payment_requests.map((p) => p.id),
  );
  dupes(
    'accounts',
    data.chart_of_accounts.map((a) => a.id),
  );
  dupes(
    'journal lines',
    data.journal_entry_lines.map((l) => l.id),
  );

  // Receipts: the size column is a 32-bit integer and the link must name a
  // known kind, or the receipt would be lost after the wipe.
  for (const [i, att] of (data.attachments ?? []).entries()) {
    const label = isText(att.id) ? att.id : `#${i + 1}`;
    if (
      (att.entity_type !== 'transaction' && att.entity_type !== 'payment_request') ||
      !isText(att.entity_id) ||
      !isText(att.file_name) ||
      !Number.isInteger(att.file_size) ||
      att.file_size < 0 ||
      att.file_size > 2147483647 ||
      !isOptionalText(att.mime_type) ||
      typeof att.content_base64 !== 'string'
    ) {
      problems.push(`Receipt ${label} has an invalid kind, name or size`);
      continue;
    }
    const targets = att.entity_type === 'transaction' ? data.transactions : data.payment_requests;
    if (!targets.some((t) => t.id === att.entity_id)) {
      problems.push(`Receipt ${label} points at a record that is not in the file`);
    }
    // An empty string means the export could not read the file; it is skipped.
    if (
      att.content_base64 !== '' &&
      (att.content_base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(att.content_base64))
    ) {
      problems.push(`Receipt ${label} has unreadable contents`);
    }
  }

  // An account can be referenced by its id or its legacy_account_id; each of
  // those keys must belong to exactly one account.
  const accountKeys = new Map<string, TakeoutLegacyAccount>();
  for (const a of data.chart_of_accounts) {
    for (const key of [a.id, a.legacy_account_id]) {
      if (!key) continue;
      const owner = accountKeys.get(key);
      if (owner && owner !== a) problems.push(`Two accounts share the reference ${key}`);
      else accountKeys.set(key, a);
    }
  }
  if (problems.length > 0) return problems;
  for (const a of data.chart_of_accounts) {
    const parent = a.parent_legacy_account_id;
    if (parent && !accountKeys.has(parent)) {
      problems.push(`Account "${a.account_name}" has a parent that is not in the file`);
    }
  }
  if (problems.length === 0 && orderParentsFirst(data.chart_of_accounts) === null) {
    problems.push('The chart of accounts has a parent loop');
  }
  const walletIds = new Set(data.wallets.map((w) => w.id));
  for (const w of data.wallets) {
    if (w.legacy_account_id && !accountKeys.has(w.legacy_account_id)) {
      problems.push(`Wallet "${w.name}" links to an account that is not in the file`);
    }
  }
  for (const t of data.transactions) {
    if (t.account_id && !walletIds.has(t.account_id)) {
      problems.push(`Transaction ${t.id} links to a wallet that is not in the file`);
    }
  }
  const jeIds = new Set(data.journal_entries.map((je) => je.id));
  for (const l of data.journal_entry_lines) {
    if (!jeIds.has(l.journal_entry_id)) {
      problems.push(`Journal line ${l.id} belongs to an entry that is not in the file`);
    }
    if (!l.account_id) {
      problems.push(`Journal line ${l.id} has no account`);
    } else if (!accountKeys.has(l.account_id)) {
      problems.push(`Journal line ${l.id} links to an account that is not in the file`);
    }
  }
  return problems;
}

/** Chart rows ordered so every parent comes before its children (the
 *  parent_id foreign key requires it). Returns null on a parent loop. */
function orderParentsFirst(
  accounts: readonly TakeoutLegacyAccount[],
): TakeoutLegacyAccount[] | null {
  const byKey = new Map<string, TakeoutLegacyAccount>();
  for (const a of accounts) {
    byKey.set(a.id, a);
    if (a.legacy_account_id) byKey.set(a.legacy_account_id, a);
  }
  const ordered: TakeoutLegacyAccount[] = [];
  const state = new Map<TakeoutLegacyAccount, 'visiting' | 'done'>();
  const visit = (a: TakeoutLegacyAccount): boolean => {
    const s = state.get(a);
    if (s === 'done') return true;
    if (s === 'visiting') return false;
    state.set(a, 'visiting');
    const parent = a.parent_legacy_account_id ? byKey.get(a.parent_legacy_account_id) : undefined;
    if (parent && !visit(parent)) return false;
    state.set(a, 'done');
    ordered.push(a);
    return true;
  };
  for (const a of accounts) if (!visit(a)) return null;
  return ordered;
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
 * Post-Phase-2 behaviour: the import inserts the takeout's rows directly
 * into the target org's encrypted Postgres tables, with `account_id` and
 * related foreign keys remapped to fresh UUIDs. Nothing else is provisioned
 * server-side; reports read straight from the imported `journal_entry_lines`
 * (the source of truth) and new transactions post correctly afterwards.
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

  // Validate the whole file before touching the target org, so a bad file
  // can never wipe a company and then fail.
  const problems = validateTakeoutFile(file);
  if (problems.length > 0) {
    const shown = problems.slice(0, 5).join('; ');
    const more = problems.length > 5 ? ` (and ${problems.length - 5} more)` : '';
    throw new Error(`This backup file cannot be restored: ${shown}${more}. Nothing was changed.`);
  }

  // Closed periods: the database refuses entries and transactions dated on or
  // before the company's locked-through date, and a wipe does not remove the
  // lock. Refuse up front rather than fail after deleting.
  const { data: closes, error: closesErr } = await (supabase as any)
    .from('org_period_closes')
    .select('locked_through_date')
    .eq('org_id', targetOrgId)
    .order('closed_at', { ascending: false })
    .limit(1);
  if (closesErr) throw new Error(`Could not check closed periods: ${closesErr.message}`);
  const lockedThrough: string | null = closes?.[0]?.locked_through_date ?? null;
  if (lockedThrough) {
    const dated = [
      ...file.data.journal_entries.map((je) => je.date),
      ...file.data.transactions.map((t) => t.date),
    ];
    const blocked = dated.filter((d) => d.slice(0, 10) <= lockedThrough).length;
    if (blocked > 0) {
      throw new Error(
        `This company's books are closed through ${lockedThrough}, and ${blocked} entries in the backup fall in that period. Nothing was changed. Restore into a new company instead.`,
      );
    }
  }

  // Pre-flight: refuse if org already has data, unless force = true.
  if (!opts.force) {
    const [w, t, j, c] = await Promise.all([
      supabase
        .from('wallets')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', targetOrgId),
      supabase
        .from('transactions')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', targetOrgId),
      supabase
        .from('journal_entries')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', targetOrgId),
      supabase
        .from('chart_of_accounts' as any)
        .select('id', { count: 'exact', head: true })
        .eq('org_id', targetOrgId),
    ]);
    const failed = [w, t, j, c].find((r) => r.error);
    if (failed?.error) {
      throw new Error(`Could not check the target company: ${failed.error.message}`);
    }
    const total = (w.count ?? 0) + (t.count ?? 0) + (j.count ?? 0);
    if (total > 0) {
      throw new Error(
        `Target org already has ${total} rows (wallets + transactions + journal entries). Use force mode to wipe and replace.`,
      );
    }
    // A new company starts with a default chart of accounts. Restoring a
    // backup's chart on top of it would leave two copies of every account.
    const chartRows = c.count ?? 0;
    if (chartRows > 0 && file.data.chart_of_accounts.length > 0) {
      throw new Error(
        `Target org already has ${chartRows} chart of accounts rows (a new company starts with a default chart). Use force mode to replace them with the backup's chart.`,
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

  // One new id per chart row, reachable from both of the row's old keys:
  // exports reference accounts by `id`, generated seed files by
  // `legacy_account_id`. Every reference (parent, wallet link, journal line)
  // must land on the id the row is actually inserted with.
  const accountIdMap = new Map<string, string>();
  data.chart_of_accounts.forEach((a) => {
    const newId = crypto.randomUUID();
    accountIdMap.set(a.id, newId);
    if (a.legacy_account_id) accountIdMap.set(a.legacy_account_id, newId);
  });

  const jeIdMap = new Map<string, string>();
  data.journal_entries.forEach((je) => jeIdMap.set(je.id, crypto.randomUUID()));

  // Transactions and payments are auto-ID'd today, but attachments reference
  // entity_id. Pre-generate IDs so the attachment upload phase can remap.
  const txIdMap = new Map<string, string>();
  data.transactions.forEach((t) => txIdMap.set(t.id, crypto.randomUUID()));
  const paymentIdMap = new Map<string, string>();
  data.payment_requests.forEach((p) => paymentIdMap.set(p.id, crypto.randomUUID()));

  // Phase 2 (external-ledger removal): the ledger journal provisioning + template replay
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
        external_account_code: w.legacy_account_code ?? null,
      },
      encryptText,
    );
    const newLegacyAccountId = w.legacy_account_id
      ? (accountIdMap.get(w.legacy_account_id) ?? null)
      : null;
    const { error } = await supabase.from('wallets').insert({
      id: walletIdMap.get(w.id),
      org_id: targetOrgId,
      external_account_id: newLegacyAccountId,
      ...enc,
    } as any);
    if (error) throw new Error(`Insert wallet failed: ${error.message}`);
    walletsInserted++;
    progress('Wallets', walletsInserted, data.wallets.length);
  }

  // ── Chart of accounts insert (Postgres-only after Phase 2) ─────────────
  let accountsInserted = 0;
  // validateTakeoutFile already rejected parent loops, so this is non-null.
  const accountsInOrder = orderParentsFirst(data.chart_of_accounts)!;
  for (let i = 0; i < accountsInOrder.length; i++) {
    const a = accountsInOrder[i];
    const normalBalance = inferNormalBalance(a);
    // Post-Phase-2: the row is encrypted with the current vault and inserted
    // straight into chart_of_accounts. No separate external-ledger call.
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
        parent_id: a.parent_legacy_account_id
          ? (accountIdMap.get(a.parent_legacy_account_id) ?? null)
          : null,
      },
      encryptText,
    );
    const { error } = await supabase.from('chart_of_accounts' as any).insert({
      id: accountIdMap.get(a.id),
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
        email: c.email,
        phone: c.phone,
        type: c.type,
        street: c.street,
        city: c.city,
        state: c.state,
        zip: c.zip,
        country: c.country,
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
      account_id: t.account_id ? (walletIdMap.get(t.account_id) ?? null) : null,
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
        status: je.status.toUpperCase(),
        source_type: normalizeSourceType(je.source_type),
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
        const newAccountId = l.account_id ? accountIdMap.get(l.account_id) : undefined;
        if (!newAccountId) throw new Error(`JE line ${l.id} references a missing account`);
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
    if (!att.content_base64 || !opts.encryptBlob) {
      // No bytes captured, or no blob-encrypt available, skip without failing the whole import.
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
