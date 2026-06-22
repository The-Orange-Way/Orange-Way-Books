/**
 * Opening balances service (P4: opening-balance import flow).
 *
 * Goal: start books at a cut-off date (e.g., 2024-01-01) without
 * importing every prior year. The user enters per-account opening
 * balances; the service posts a single dated journal entry that
 * establishes the trial balance at that point.
 *
 * Pattern: borrows the existing wallet opening-balance flow
 * (src/pages/Accounts.tsx:325-370) extended to N accounts.
 *
 * ZKA + idempotency:
 *   - The ref_number "OPEN-BAL-<YYYY-MM-DD>" is encrypted into
 *     journal_entries.ref_number (standard ZKA L2 behavior).
 *   - For DB-level uniqueness, the browser computes an HMAC blind index
 *     of "open-bal-<YYYY-MM-DD>" and writes it to
 *     journal_entries.hmac_import_external_id (added by P5 migration
 *     20260522000000). The unique partial index there enforces "only one
 *     opening-balance JE per org per date" without server-side knowledge
 *     of the plaintext.
 *
 * Audit logging is the caller's responsibility (must encrypt summary
 * browser-side).
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { encryptJournalEntry } from './crypto-fields';
import { buildJournalEntryLineInsert } from './exchange/build-je-line-insert';
import {
  buildOpeningBalanceRefNumber,
  computeOpeningBalanceHmac,
} from './journal-entry-ref-numbers';

/** A single opening-balance line. Exactly one of debit/credit must be > 0. */
export interface OpeningBalanceEntry {
  /** UUID of the chart_of_accounts row this line debits or credits. */
  accountId: string;
  /** Display name for encryption + ledger lookup (account_name is encrypted). */
  accountName: string;
  /** Optional account code (e.g. "1110"). */
  accountCode?: string | null;
  /** Currency code of the account, e.g. 'CAD', 'USD'. */
  currency: string;
  /** Non-negative debit amount; 0 if this is a credit line. */
  debit: number;
  /** Non-negative credit amount; 0 if this is a debit line. */
  credit: number;
  /** Optional line description. Defaults to 'Opening balance'. */
  description?: string;
}

export interface PostOpeningBalanceParams {
  /** UTC YYYY-MM-DD. The effective date the books open at. */
  date: string;
  /** Org's primary accounting currency (used for FX conversion of non-primary lines). */
  primaryCurrency: string;
  /** One entry per non-zero account. Must balance: sum(debits) == sum(credits). */
  entries: OpeningBalanceEntry[];
  /** Optional memo. Defaults to 'Opening balance — bulk import'. */
  memo?: string;
}

export interface PostOpeningBalanceResult {
  journalEntryId: string;
  refNumber: string;
  hmacImportExternalId: string;
  lineCount: number;
  totalDebits: number;
  totalCredits: number;
}

// ── Errors ────────────────────────────────────────────────────────────────────

export class OpeningBalanceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpeningBalanceValidationError';
  }
}

export class DuplicateOpeningBalanceError extends Error {
  constructor(date: string) {
    super(
      `An opening balance journal already exists for ${date}. Delete it first or pick a different date.`,
    );
    this.name = 'DuplicateOpeningBalanceError';
  }
}

export class VaultLockedError extends Error {
  constructor() {
    super('Vault is locked. Unlock it before posting an opening balance.');
    this.name = 'VaultLockedError';
  }
}

// ── Validation ────────────────────────────────────────────────────────────────

/** Round to 2 decimal places to avoid floating-point sum drift. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Validate the entries pre-flight. Throws OpeningBalanceValidationError on issues. */
export function validateOpeningBalanceEntries(entries: OpeningBalanceEntry[]): {
  totalDebits: number;
  totalCredits: number;
} {
  if (!entries || entries.length === 0) {
    throw new OpeningBalanceValidationError('At least one opening balance entry is required.');
  }

  let totalDebits = 0;
  let totalCredits = 0;
  const seenAccounts = new Set<string>();

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!e.accountId) {
      throw new OpeningBalanceValidationError(`Entry ${i + 1}: accountId is required.`);
    }
    if (seenAccounts.has(e.accountId)) {
      throw new OpeningBalanceValidationError(`Account ${e.accountName} appears more than once.`);
    }
    seenAccounts.add(e.accountId);

    // `| 0` would truncate to int32 and lose every sub-dollar amount,
    // breaking the parity test and every real opening balance. Use ||.
    const dr = Number(e.debit) || 0;
    const cr = Number(e.credit) || 0;
    if (dr < 0 || cr < 0) {
      throw new OpeningBalanceValidationError(
        `Entry ${i + 1} (${e.accountName}): amounts must be non-negative.`,
      );
    }
    if (dr > 0 && cr > 0) {
      throw new OpeningBalanceValidationError(
        `Entry ${i + 1} (${e.accountName}): cannot have both debit and credit.`,
      );
    }
    if (dr === 0 && cr === 0) {
      throw new OpeningBalanceValidationError(
        `Entry ${i + 1} (${e.accountName}): zero amount; remove the line instead.`,
      );
    }
    if (!e.currency) {
      throw new OpeningBalanceValidationError(
        `Entry ${i + 1} (${e.accountName}): currency is required.`,
      );
    }
    totalDebits += dr;
    totalCredits += cr;
  }

  totalDebits = round2(totalDebits);
  totalCredits = round2(totalCredits);

  if (Math.abs(totalDebits - totalCredits) > 0.005) {
    throw new OpeningBalanceValidationError(
      `Opening balance does not balance. Debits ${totalDebits.toFixed(2)} vs Credits ${totalCredits.toFixed(2)} ` +
        `(difference ${(totalDebits - totalCredits).toFixed(2)}). ` +
        `Add an Owner's Equity / Retained Earnings line to balance.`,
    );
  }

  return { totalDebits, totalCredits };
}

// ── Post ──────────────────────────────────────────────────────────────────────

/**
 * Post a single opening-balance journal entry establishing the trial balance
 * at the given cut-off date.
 *
 * Throws OpeningBalanceValidationError if entries don't balance.
 * Throws VaultLockedError if blindIndex cannot compute a value.
 * Throws DuplicateOpeningBalanceError if an opening JE already exists for this date.
 *
 * @param supabase     authenticated client
 * @param encryptText  AES-GCM encryption fn (from useVault())
 * @param blindIndex   HMAC blind-index fn (from useVault())
 * @param orgId        target org
 * @param params       date + primary currency + entries
 */
export async function postOpeningBalanceJournal(
  supabase: SupabaseClient,
  encryptText: (plaintext: string) => Promise<string>,
  blindIndex: (value: string | null | undefined) => Promise<string | null>,
  orgId: string,
  params: PostOpeningBalanceParams,
): Promise<PostOpeningBalanceResult> {
  if (!orgId) throw new OpeningBalanceValidationError('orgId required');
  if (!params.date) throw new OpeningBalanceValidationError('date required');
  if (!params.primaryCurrency) throw new OpeningBalanceValidationError('primaryCurrency required');

  const { totalDebits, totalCredits } = validateOpeningBalanceEntries(params.entries);

  const refNumber = buildOpeningBalanceRefNumber(params.date);
  const memo = params.memo ?? 'Opening balance — bulk import';
  const status = 'POSTED';

  // Compute the HMAC blind index for ZKA-safe uniqueness.
  const hmacImportExternalId = await computeOpeningBalanceHmac(blindIndex, params.date);
  if (!hmacImportExternalId) {
    throw new VaultLockedError();
  }

  // Encrypt the JE header. Sensitive fields go in; orchestration fields stay plaintext.
  const encJe = await encryptJournalEntry(
    {
      memo,
      ref_number: refNumber,
      currency: params.primaryCurrency,
      exchange_rate: null,
      status,
      source_type: 'opening_balance',
      period_locked: false,
    },
    encryptText,
  );

  const { data: jeRow, error: jeErr } = await supabase
    .from('journal_entries')
    .insert({
      org_id: orgId,
      date: params.date,
      hmac_import_external_id: hmacImportExternalId,
      ...encJe,
    } as any)
    .select('id')
    .single();

  if (jeErr) {
    // 23505 = unique_violation. The unique partial index on
    // (org_id, hmac_import_external_id) catches duplicate dates.
    if (jeErr.code === '23505') {
      throw new DuplicateOpeningBalanceError(params.date);
    }
    throw new Error(`postOpeningBalanceJournal: JE insert failed: ${jeErr.message}`);
  }
  if (!jeRow) {
    throw new Error('postOpeningBalanceJournal: JE insert returned no row');
  }

  const journalEntryId = (jeRow as any).id as string;

  // Build + insert lines (one per entry)
  const lineInserts: any[] = [];
  for (const e of params.entries) {
    const built = await buildJournalEntryLineInsert({
      wallet_currency: e.currency,
      primary_currency: params.primaryCurrency,
      date: params.date,
      debit: e.debit,
      credit: e.credit,
      account_name: e.accountName,
      account_code: e.accountCode ?? null,
      description: e.description ?? 'Opening balance',
      encrypt: encryptText,
    });
    lineInserts.push({
      journal_entry_id: journalEntryId,
      account_id: e.accountId,
      ...built.insert,
    });
  }

  const { error: linesErr } = await supabase.from('journal_entry_lines').insert(lineInserts as any);

  if (linesErr) {
    // Best-effort cleanup of the JE header if lines fail. The unique HMAC
    // index would otherwise block a retry for the same date.
    await supabase.from('journal_entries').delete().eq('id', journalEntryId);
    throw new Error(`postOpeningBalanceJournal: lines insert failed: ${linesErr.message}`);
  }

  return {
    journalEntryId,
    refNumber,
    hmacImportExternalId,
    lineCount: lineInserts.length,
    totalDebits,
    totalCredits,
  };
}

// ── Re-export for convenience ────────────────────────────────────────────────

export { buildOpeningBalanceRefNumber };
