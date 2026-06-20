/**
 * QuickBooks Import — Track B commit orchestrator.
 *
 * Takes parsed QB data (Track A) + user-approved classifications (Track C will
 * provide these via the wizard) and commits into OWB with ZKA guarantees:
 *
 *   1. Every amount, account name, contact PII is encrypted client-side BEFORE
 *      it leaves the browser. Supabase only sees ciphertext + structural ids.
 *   2. ledger blind-replay: each new chart_of_accounts row gets a random UUID as
 *      `external_account_id` and a random UUID placeholder as the plaintext
 *      `account_name` (the real name lives encrypted in `encrypted_name`).
 *      the ledger (when the ledger engine replays it) therefore sees opaque ids,
 *      never the user's actual book.
 *   3. Idempotency: every journal entry carries a plaintext
 *      `encrypted_metadata: { source: 'quickbooks', import_id, qb_ref_num }`.
 *      Re-running with the same parsed bundle is a no-op because the ref_num
 *      dedup query finds the previous imports.
 *
 * No new RPC / migration. Pure client-side batched inserts matching OWB's
 * existing orImportBridge pattern. Per-item errors are collected and do not
 * abort the batch.
 */

import { supabase } from '@/lib/supabase';
import {
  encryptChartOfAccount,
  encryptContact,
  encryptJournalEntry,
  decryptChartOfAccount,
  decryptContact,
  type EncryptFn,
  type DecryptFn,
} from '@/lib/crypto-fields';
import { buildJournalEntryLineInsert } from '@/lib/exchange/build-je-line-insert';
import type {
  AccountType,
  ContactKind,
  ParsedContact,
  ParsedJournalEntry,
  ParsedTrialBalanceAccount,
  QuickBooksClassification,
  QuickBooksClassificationResult,
  QuickBooksParsedData,
} from './types';

// Plaintext routing tag — never carries business content, only structural ids.
const SOURCE_TAG = 'quickbooks';

export type CommitStage =
  | 'preparing'
  | 'accounts'
  | 'contacts'
  | 'journal-entries'
  | 'finalizing';

export interface CommitProgress {
  stage: CommitStage;
  done: number;
  total: number;
}

export interface CommitQuickBooksImportParams {
  orgId: string;
  /** Org's primary (functional) currency — used for JE line dual-currency math. */
  primaryCurrency: string;
  parsed: QuickBooksParsedData;
  /** From Track A's classifyQuickBooksAccounts. */
  classifications: QuickBooksClassificationResult;
  /** Per-account user overrides (from the Track C wizard). Keyed by account
   *  name. These take precedence over `classifications.confident` — so the
   *  user can re-classify an auto-detected account. Names in
   *  `classifications.ambiguous` MUST have an override or they are skipped
   *  with an error. */
  accountOverrides?: Record<string, QuickBooksClassification>;
  encryptText: EncryptFn;
  decryptText: DecryptFn;
  onProgress?: (progress: CommitProgress) => void;
}

export interface CommitQuickBooksImportResult {
  /** Opaque id stamped into every journal entry — lets us audit or roll back. */
  importId: string;
  accountsCreated: number;
  accountsSkipped: number;
  /** TB accounts that the classifier could not bucket and the user did not
   *  override — their JE lines were redirected to "Uncategorized Expense" or
   *  "Uncategorized Revenue" by trial-balance polarity. The original QB name
   *  is preserved at the start of each redirected line's description. */
  accountsFallback: number;
  contactsCreated: number;
  contactsSkipped: number;
  journalEntriesCreated: number;
  journalEntriesSkipped: number;
  linesCreated: number;
  /** JE lines whose FX rate could not be resolved at commit time. They are
   *  written to the database but excluded from formal reports until the user
   *  enters a manual rate. Surfaced in the wizard's done view. */
  linesPending: number;
  errors: CommitError[];
}

export interface CommitError {
  phase: CommitStage;
  item: string;
  error: string;
}

/** Fallback bucket for ambiguous accounts with no user override. The original
 *  QB account name is rewritten on every JE line that referenced it; the user
 *  finds these lines under "Uncategorized Expense" / "Uncategorized Revenue"
 *  in the chart of accounts and re-classifies from there. */
type FallbackBucket = 'EXPENSE' | 'INCOME';
type FallbackMap = Map<string, FallbackBucket>;

const UNCATEGORIZED_EXPENSE_NAME = 'Uncategorized Expense';
const UNCATEGORIZED_REVENUE_NAME = 'Uncategorized Revenue';
const UNCATEGORIZED_EXPENSE_CODE = '5999';
const UNCATEGORIZED_REVENUE_CODE = '4999';

/** Map the AccountSubType enum to the friendly group label that the Admin
 *  Chart of Accounts tab renders against (IE_GROUPS / BS_GROUPS in
 *  Admin.tsx). Without this, QB-imported rows write
 *  "GENERAL_AND_ADMINISTRATIVE" and never appear under any of the configured
 *  groups. */
function subTypeToGroupName(subType: import('./types').AccountSubType): string {
  switch (subType) {
    case 'WALLETS': return 'Cash';
    case 'OTHER_CURRENT_ASSETS': return 'Other Current Assets';
    case 'FIXED_ASSETS': return 'Fixed Assets';
    case 'SUSPENSE': return 'Other Assets';
    case 'CURRENT_LIABILITIES': return 'Current Liabilities';
    case 'LONG_TERM_LIABILITIES': return 'Long-Term Liabilities';
    case 'OWNERS_EQUITY': return "Owner's Equity";
    case 'RETAINED_EARNINGS': return 'Retained Earnings';
    case 'SALES': return 'Sales';
    case 'COST_OF_SALES': return 'Cost of Sales';
    case 'SALES_AND_MARKETING': return 'Sales & Marketing';
    case 'LABOR': return 'Labor';
    case 'GENERAL_AND_ADMINISTRATIVE': return 'General & Administrative';
  }
}

/** Map AccountType to the casing the CoA tab filters by (BS_GROUPS uses
 *  "ASSETS" / "LIABILITIES" plural; IE_GROUPS uses "INCOME" / "EXPENSE"
 *  singular; "EQUITY" matches as-is). */
function accountTypeToTabType(type: AccountType): string {
  switch (type) {
    case 'ASSET': return 'ASSETS';
    case 'LIABILITY': return 'LIABILITIES';
    case 'EQUITY': return 'EQUITY';
    case 'INCOME': return 'INCOME';
    case 'EXPENSE': return 'EXPENSE';
  }
}

export async function commitQuickBooksImport(
  params: CommitQuickBooksImportParams,
): Promise<CommitQuickBooksImportResult> {
  const { orgId, parsed, encryptText, decryptText, onProgress } = params;
  const importId = crypto.randomUUID();
  const result: CommitQuickBooksImportResult = {
    importId,
    accountsCreated: 0,
    accountsSkipped: 0,
    accountsFallback: 0,
    contactsCreated: 0,
    contactsSkipped: 0,
    journalEntriesCreated: 0,
    journalEntriesSkipped: 0,
    linesCreated: 0,
    linesPending: 0,
    errors: [],
  };

  const { classifications, fallbacks } = resolveClassifications(
    parsed.trialBalanceAccounts,
    params.classifications,
    params.accountOverrides ?? {},
  );
  result.accountsFallback = fallbacks.size;

  emitProgress(onProgress, 'preparing', 0, parsed.trialBalanceAccounts.length);

  // ── Phase 1: Accounts ───────────────────────────────────────────────────
  await commitAccounts(
    orgId,
    parsed.trialBalanceAccounts,
    classifications,
    encryptText,
    decryptText,
    (done, total) => emitProgress(onProgress, 'accounts', done, total),
    result,
  );

  // ── Phase 1b: Uncategorized buckets (only if any fallback accounts exist) ─
  if (fallbacks.size > 0) {
    await ensureUncategorizedAccounts(orgId, encryptText, decryptText, result);
  }

  // ── Phase 2: Contacts ───────────────────────────────────────────────────
  await commitContacts(
    orgId,
    parsed.contacts,
    encryptText,
    decryptText,
    (done, total) => emitProgress(onProgress, 'contacts', done, total),
    result,
  );

  // ── Phase 3: Journal entries ────────────────────────────────────────────
  await commitJournalEntries(
    orgId,
    importId,
    parsed.journalEntries,
    fallbacks,
    params.primaryCurrency,
    encryptText,
    (done, total) => emitProgress(onProgress, 'journal-entries', done, total),
    result,
  );

  emitProgress(onProgress, 'finalizing', 1, 1);
  return result;
}

// ── Classification resolution ─────────────────────────────────────────────

function resolveClassifications(
  accounts: ParsedTrialBalanceAccount[],
  confidentResult: QuickBooksClassificationResult,
  overrides: Record<string, QuickBooksClassification>,
): { classifications: Map<string, QuickBooksClassification>; fallbacks: FallbackMap } {
  const classifications = new Map<string, QuickBooksClassification>();
  const fallbacks: FallbackMap = new Map();
  for (const account of accounts) {
    const override = overrides[account.name];
    if (override) {
      classifications.set(account.name, override);
      continue;
    }
    const confident = confidentResult.confident[account.name];
    if (confident) {
      classifications.set(account.name, confident);
      continue;
    }
    fallbacks.set(account.name, inferFallbackBucket(account));
  }
  return { classifications, fallbacks };
}

function inferFallbackBucket(account: ParsedTrialBalanceAccount): FallbackBucket {
  const debit = Number(account.debit) | 0;
  const credit = Number(account.credit) | 0;
  if (credit > debit) return 'INCOME';
  return 'EXPENSE';
}

async function ensureUncategorizedAccounts(
  orgId: string,
  encrypt: EncryptFn,
  decrypt: DecryptFn,
  result: CommitQuickBooksImportResult,
): Promise<void> {
  const existing = await loadExistingAccountIndex(orgId, decrypt);
  const existingNames = new Set<string>(existing.keys());

  if (!existingNames.has(UNCATEGORIZED_EXPENSE_NAME)) {
    try {
      await insertSimpleAccount(orgId, UNCATEGORIZED_EXPENSE_NAME, UNCATEGORIZED_EXPENSE_CODE, 'EXPENSE', 'Uncategorized Expenses', encrypt);
      result.accountsCreated += 1;
    } catch (err) {
      result.errors.push({
        phase: 'accounts',
        item: UNCATEGORIZED_EXPENSE_NAME,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (!existingNames.has(UNCATEGORIZED_REVENUE_NAME)) {
    try {
      await insertSimpleAccount(orgId, UNCATEGORIZED_REVENUE_NAME, UNCATEGORIZED_REVENUE_CODE, 'INCOME', 'Uncategorized Income', encrypt);
      result.accountsCreated += 1;
    } catch (err) {
      result.errors.push({
        phase: 'accounts',
        item: UNCATEGORIZED_REVENUE_NAME,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function insertSimpleAccount(
  orgId: string,
  name: string,
  code: string,
  type: 'INCOME' | 'EXPENSE',
  group: string,
  encrypt: EncryptFn,
): Promise<void> {
  const enc = await encryptChartOfAccount(
    {
      account_name: name,
      account_code: code,
      account_type: type,
      // Post-Phase-1: encrypted_account_sub_type is the friendly group label.
      account_sub_type: group,
      account_group: group,
      account_category: null,
      is_archived: false,
    },
    encrypt,
  );
  const { error } = await supabase
    .from('chart_of_accounts')
    .insert({
      org_id: orgId,
      ...enc,
    } as never);
  if (error) throw error;
}

// ── Phase 1 helpers ───────────────────────────────────────────────────────

async function commitAccounts(
  orgId: string,
  accounts: ParsedTrialBalanceAccount[],
  classifications: Map<string, QuickBooksClassification>,
  encrypt: EncryptFn,
  decrypt: DecryptFn,
  onStep: (done: number, total: number) => void,
  result: CommitQuickBooksImportResult,
): Promise<Map<string, string>> {
  const existingByName = await loadExistingAccountIndex(orgId, decrypt);
  const nameToRowId = new Map(existingByName);
  const total = accounts.length;
  let done = 0;

  for (const account of accounts) {
    done += 1;
    const classification = classifications.get(account.name);
    if (!classification) {
      // Ambiguous, no override — its lines will be redirected to Uncategorized
      // Expense / Revenue by commitJournalEntries. Skip the per-account row.
      onStep(done, total);
      continue;
    }
    const existingRowId = existingByName.get(account.name);
    if (existingRowId) {
      result.accountsSkipped += 1;
      nameToRowId.set(account.name, existingRowId);
      onStep(done, total);
      continue;
    }
    try {
      const enc = await encryptChartOfAccount(
        {
          account_name: account.name,
          account_code: account.code,
          account_type: accountTypeToTabType(classification.accountType),
          // Post-Phase-1: the friendly group label lives in
          // encrypted_account_sub_type. Passing account_group is a no-op
          // because encryptChartOfAccount only reads account_sub_type.
          account_sub_type: subTypeToGroupName(classification.accountSubType),
          account_group: subTypeToGroupName(classification.accountSubType),
          account_category: null,
          is_archived: false,
        },
        encrypt,
      );
      const { data, error } = await supabase
        .from('chart_of_accounts')
        .insert({
          org_id: orgId,
          ...enc,
        } as never)
        .select('id')
        .single();
      if (error) throw error;
      if (!data) throw new Error('No row returned after account insert');
      nameToRowId.set(account.name, (data as { id: string }).id);
      result.accountsCreated += 1;
    } catch (err) {
      result.errors.push({
        phase: 'accounts',
        item: account.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    onStep(done, total);
  }

  return nameToRowId;
}

async function loadExistingAccountIndex(
  orgId: string,
  decrypt: DecryptFn,
): Promise<Map<string, string>> {
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('*')
    .eq('org_id', orgId);
  if (error) throw error;
  const index = new Map<string, string>();
  for (const row of (data as Array<Record<string, unknown>>) ?? []) {
    try {
      const fields = await decryptChartOfAccount(row, decrypt);
      const name = fields.account_name?.trim();
      if (name) index.set(name, row.id as string);
    } catch {
      // Undecryptable rows are ignored — we never route imports into rows we
      // cannot read (key mismatch / pre-migration / L0).
    }
  }
  return index;
}

// ── Phase 2 helpers ───────────────────────────────────────────────────────

async function commitContacts(
  orgId: string,
  contacts: ParsedContact[],
  encrypt: EncryptFn,
  decrypt: DecryptFn,
  onStep: (done: number, total: number) => void,
  result: CommitQuickBooksImportResult,
): Promise<void> {
  const existingNames = await loadExistingContactNames(orgId, decrypt);
  const total = contacts.length;
  let done = 0;
  // Dedup within the same import bundle — QB occasionally lists the same
  // contact in Customers and Vendors. First write wins.
  const seenThisBatch = new Set<string>();

  for (const contact of contacts) {
    done += 1;
    const key = `${contact.kind}:${contact.name.trim().toLowerCase()}`;
    if (existingNames.has(key) || seenThisBatch.has(key)) {
      result.contactsSkipped += 1;
      onStep(done, total);
      continue;
    }
    seenThisBatch.add(key);
    try {
      const enc = await encryptContact(
        {
          name: contact.name,
          street: contact.street,
          city: contact.city,
          state: contact.state,
          zip: contact.zip,
          country: contact.country,
          email: contact.email,
          phone: contact.phone,
          type: contactKindToType(contact.kind),
        },
        encrypt,
      );
      const { error } = await supabase
        .from('contacts')
        .insert({ org_id: orgId, ...enc } as never);
      if (error) throw error;
      result.contactsCreated += 1;
    } catch (err) {
      result.errors.push({
        phase: 'contacts',
        item: contact.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    onStep(done, total);
  }
}

async function loadExistingContactNames(
  orgId: string,
  decrypt: DecryptFn,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('contacts')
    .select('*')
    .eq('org_id', orgId);
  if (error) throw error;
  const out = new Set<string>();
  for (const row of (data as Array<Record<string, unknown>>) ?? []) {
    try {
      const fields = await decryptContact(row as never, decrypt);
      const name = fields.name?.trim().toLowerCase();
      const type = (fields.type | '').toUpperCase();
      if (name && type) out.add(`${type}:${name}`);
    } catch {
      // Ignore undecryptable rows.
    }
  }
  return out;
}

function contactKindToType(kind: ContactKind): string {
  // Match the casing that existing OWB code expects (Admin / Contact list use
  // CUSTOMER / VENDOR / EMPLOYEE on the decrypted type column).
  return kind;
}

// ── Phase 3 helpers ───────────────────────────────────────────────────────

/** Hard cap on a single QB import. Anything bigger should be split into
 *  multiple smaller exports — even with batched inserts, a 200k+ import in a
 *  single browser session is a tab-close hazard with no resume today. */
export const QB_IMPORT_HARD_CAP = 100_000;

/** Number of journal entries to encrypt + insert in a single Supabase round
 *  trip. Keeps wall time on a 50k-entry import in the few-minute range
 *  instead of the hour range we'd see with one round trip per entry. */
const JE_BATCH_SIZE = 200;

async function commitJournalEntries(
  orgId: string,
  importId: string,
  entries: ParsedJournalEntry[],
  fallbacks: FallbackMap,
  primaryCurrency: string,
  encrypt: EncryptFn,
  onStep: (done: number, total: number) => void,
  result: CommitQuickBooksImportResult,
): Promise<void> {
  if (entries.length > QB_IMPORT_HARD_CAP) {
    throw new Error(
      `This QuickBooks export has ${entries.length.toLocaleString()} journal entries. ` +
      `The current import limit is ${QB_IMPORT_HARD_CAP.toLocaleString()}. ` +
      `Please split the export into smaller files (by year, quarter, or month) and import each one separately.`,
    );
  }

  const existingRefs = await loadExistingQbRefs(orgId);
  const total = entries.length;
  let done = 0;

  // Skip-already-imported pass first so the batch round-trips only carry fresh
  // entries.
  const fresh: ParsedJournalEntry[] = [];
  for (const entry of entries) {
    if (existingRefs.has(entry.refNum)) {
      result.journalEntriesSkipped += 1;
      done += 1;
    } else {
      fresh.push(entry);
    }
  }
  onStep(done, total);

  for (let offset = 0; offset < fresh.length; offset += JE_BATCH_SIZE) {
    const batch = fresh.slice(offset, offset + JE_BATCH_SIZE);
    await commitJournalEntryBatch(orgId, importId, batch, fallbacks, primaryCurrency, encrypt, result);
    done += batch.length;
    onStep(done, total);
  }
}

/** Commit one batch of fresh journal entries. Headers go in as a single
 *  insert; their generated ids come back; all lines for the batch go in as a
 *  second single insert. On any DB-level error the whole batch is replayed
 *  per-entry so a single bad row doesn't take 200 with it. */
async function commitJournalEntryBatch(
  orgId: string,
  importId: string,
  batch: ParsedJournalEntry[],
  fallbacks: FallbackMap,
  primaryCurrency: string,
  encrypt: EncryptFn,
  result: CommitQuickBooksImportResult,
): Promise<void> {
  // Encrypt all headers in parallel.
  let encHeaders: Array<{ entry: ParsedJournalEntry; row: Record<string, unknown> }>;
  try {
    encHeaders = await Promise.all(batch.map(async (entry) => {
      const enc = await encryptJournalEntry(
        {
          memo: entry.memo,
          ref_number: entry.refNum,
          currency: primaryCurrency,
          exchange_rate: null,
          status: 'POSTED',
          source_type: SOURCE_TAG,
          period_locked: false,
        },
        encrypt,
      );
      return {
        entry,
        row: {
          org_id: orgId,
          date: entry.date,
          encrypted_metadata: {
            source: SOURCE_TAG,
            import_id: importId,
            qb_ref_num: entry.refNum,
          },
          ...enc,
        },
      };
    }));
  } catch (err) {
    // Encryption error — record one error and bail; this is a vault-state issue,
    // not a per-row problem.
    result.errors.push({
      phase: 'journal-entries',
      item: `batch[${batch[0]?.refNum ?? '?'}…${batch[batch.length - 1]?.refNum ?? '?'}]`,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const { data: insertedHeaders, error: headerErr } = await supabase
    .from('journal_entries')
    .insert(encHeaders.map((h) => h.row) as never)
    .select('id, encrypted_metadata');

  if (headerErr || !insertedHeaders) {
    // Fall back to per-entry retries so one bad row doesn't kill the batch.
    await commitJournalEntriesPerEntry(orgId, importId, batch, fallbacks, primaryCurrency, encrypt, result);
    return;
  }

  const idByRef = new Map<string, string>();
  for (const r of insertedHeaders as Array<{ id: string; encrypted_metadata: { qb_ref_num?: string } | null }>) {
    const refNum = r.encrypted_metadata?.qb_ref_num;
    if (refNum) idByRef.set(refNum, r.id);
  }

  // Build all line inserts for this batch.
  const allLines: Array<Record<string, unknown>> = [];
  let pendingThisBatch = 0;
  for (const entry of batch) {
    const journalEntryId = idByRef.get(entry.refNum);
    if (!journalEntryId) {
      result.errors.push({
        phase: 'journal-entries',
        item: entry.refNum,
        error: 'Header insert succeeded but id missing from response.',
      });
      continue;
    }
    for (const line of entry.lines) {
      const routed = applyFallbackRouting(line, fallbacks);
      const built = await buildJournalEntryLineInsert({
        wallet_currency: line.nativeCurrency | primaryCurrency,
        primary_currency: primaryCurrency,
        date: entry.date,
        debit: Number(line.debit),
        credit: Number(line.credit),
        account_name: routed.accountName,
        account_code: routed.accountCode,
        description: routed.description,
        encrypt,
      });
      if (built.pending) pendingThisBatch += 1;
      allLines.push({ journal_entry_id: journalEntryId, ...built.insert });
    }
  }

  if (allLines.length > 0) {
    const { error: lineErr } = await supabase
      .from('journal_entry_lines')
      .insert(allLines as never);
    if (lineErr) {
      // Lines failed — the headers are already in. Per-entry retry is harder
      // here because dedup will skip the headers next time. Record an
      // aggregate error so the user sees the batch failed.
      result.errors.push({
        phase: 'journal-entries',
        item: `batch[${batch[0].refNum}…${batch[batch.length - 1].refNum}] lines`,
        error: lineErr.message,
      });
      return;
    }
  }

  result.journalEntriesCreated += idByRef.size;
  result.linesCreated += allLines.length;
  result.linesPending += pendingThisBatch;
}

/** Slow-path fallback used when a batch insert fails. Inserts one entry at a
 *  time so a single bad row only loses itself, not 199 siblings. */
async function commitJournalEntriesPerEntry(
  orgId: string,
  importId: string,
  batch: ParsedJournalEntry[],
  fallbacks: FallbackMap,
  primaryCurrency: string,
  encrypt: EncryptFn,
  result: CommitQuickBooksImportResult,
): Promise<void> {
  for (const entry of batch) {
    try {
      const encHeader = await encryptJournalEntry(
        {
          memo: entry.memo,
          ref_number: entry.refNum,
          currency: primaryCurrency,
          exchange_rate: null,
          status: 'POSTED',
          source_type: SOURCE_TAG,
          period_locked: false,
        },
        encrypt,
      );
      const { data: jeRow, error: headerErr } = await supabase
        .from('journal_entries')
        .insert({
          org_id: orgId,
          date: entry.date,
          encrypted_metadata: {
            source: SOURCE_TAG,
            import_id: importId,
            qb_ref_num: entry.refNum,
          } as never,
          ...encHeader,
        } as never)
        .select('id')
        .single();
      if (headerErr) throw headerErr;
      if (!jeRow) throw new Error('No journal_entry row returned');
      const journalEntryId = (jeRow as { id: string }).id;

      const lineInserts: Array<Record<string, unknown>> = [];
      let pending = 0;
      for (const line of entry.lines) {
        const routed = applyFallbackRouting(line, fallbacks);
        const built = await buildJournalEntryLineInsert({
          wallet_currency: line.nativeCurrency | primaryCurrency,
          primary_currency: primaryCurrency,
          date: entry.date,
          debit: Number(line.debit),
          credit: Number(line.credit),
          account_name: routed.accountName,
          account_code: routed.accountCode,
          description: routed.description,
          encrypt,
        });
        if (built.pending) pending += 1;
        lineInserts.push({ journal_entry_id: journalEntryId, ...built.insert });
      }
      if (lineInserts.length > 0) {
        const { error: lineErr } = await supabase
          .from('journal_entry_lines')
          .insert(lineInserts as never);
        if (lineErr) throw lineErr;
      }
      result.journalEntriesCreated += 1;
      result.linesCreated += lineInserts.length;
      result.linesPending += pending;
    } catch (err) {
      result.errors.push({
        phase: 'journal-entries',
        item: entry.refNum,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function applyFallbackRouting(
  line: ParsedJournalEntry['lines'][number],
  fallbacks: FallbackMap,
): { accountName: string; accountCode: string | null; description: string | null } {
  const bucket = fallbacks.get(line.accountName);
  if (!bucket) {
    return { accountName: line.accountName, accountCode: line.accountCode, description: line.memo };
  }
  const newName = bucket === 'INCOME' ? UNCATEGORIZED_REVENUE_NAME : UNCATEGORIZED_EXPENSE_NAME;
  const newCode = bucket === 'INCOME' ? UNCATEGORIZED_REVENUE_CODE : UNCATEGORIZED_EXPENSE_CODE;
  const tag = `[QB: ${line.accountName}]`;
  const description = line.memo ? `${tag} ${line.memo}` : tag;
  return { accountName: newName, accountCode: newCode, description };
}

async function loadExistingQbRefs(orgId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('journal_entries')
    .select('encrypted_metadata')
    .eq('org_id', orgId)
    .contains('encrypted_metadata', { source: SOURCE_TAG } as never);
  if (error) throw error;
  const out = new Set<string>();
  for (const row of (data as Array<{ encrypted_metadata: { qb_ref_num?: string } | null }>) ?? []) {
    const ref = row.encrypted_metadata?.qb_ref_num;
    if (typeof ref === 'string') out.add(ref);
  }
  return out;
}

// ── Utilities ─────────────────────────────────────────────────────────────

function emitProgress(
  onProgress: ((p: CommitProgress) => void) | undefined,
  stage: CommitStage,
  done: number,
  total: number,
): void {
  if (onProgress) onProgress({ stage, done, total });
}

// Re-exports for Track C consumers that want to type-check their inputs
// without reaching into types.ts directly.
export type { QuickBooksClassification, AccountType };
