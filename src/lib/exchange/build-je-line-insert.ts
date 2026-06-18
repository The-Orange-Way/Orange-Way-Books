import { resolvePinnedRate } from './rate-resolver';
import { encryptJournalEntryLine, type JournalEntryLineEncrypted } from '@/lib/crypto-fields';

type EncryptFn = (plaintext: string) => Promise<string>;

// ── Input types ───────────────────────────────────────────────────────────────

export interface ManualRate {
  rate: number;
  /** Free-text explanation of where the rate came from. Minimum 40 characters. */
  reason: string;
  /** Structured source label (e.g. "OANDA.com", "CPA-quoted", "Spot rate from bank", "Other"). */
  source: string;
}

export interface BuildJeLineInsertParams {
  /** Wallet currency of this line (e.g. "MXN"). */
  wallet_currency: string;
  /** Org's current primary (functional) currency (e.g. "BTC"). */
  primary_currency: string;
  /** Journal entry date — used to pin the rate bucket (YYYY-MM-DD or ISO). */
  date: string;
  /** Positive debit amount in wallet currency (0 if this is a credit line). */
  debit: number;
  /** Positive credit amount in wallet currency (0 if this is a debit line). */
  credit: number;
  /** Optional account fields passed through to encryptJournalEntryLine. */
  account_name?: string | null;
  account_code?: string | null;
  description?: string | null;
  book_value?: number | null;
  /** If provided, skip the resolver and use this rate instead. */
  manualRate?: ManualRate;
  /** Vault encryption function from VaultContext. */
  encrypt: EncryptFn;
}

// ── Result ────────────────────────────────────────────────────────────────────

export interface BuildJeLineInsertResult {
  /** Ready-to-insert row for the journal_entry_lines table. */
  insert: JournalEntryLineEncrypted;
  /** True when the exchange rate could not be resolved — line is stored but
   *  excluded from formal reports until the rate is resolved manually. */
  pending: boolean;
  /** The resolved rate (primary per wallet unit), or 0 when pending. */
  rate: number;
  /** Bucket timestamp of the pinned rate. */
  rateBucketTs: string | null;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build an encrypted JE line insert row with full dual-currency amounts.
 *
 * Responsibilities:
 *  1. Resolve the exchange rate (manual > resolver > pending fallback).
 *  2. Compute amount_native (signed wallet amount) and amount_primary.
 *  3. Encrypt all fields via encryptJournalEntryLine.
 *  4. Attach plaintext metadata (pinned_rate_id, rate_pending, etc.).
 *
 * The caller inserts the returned `insert` object directly into
 * `journal_entry_lines` — no further transformation needed.
 */
export async function buildJournalEntryLineInsert(
  params: BuildJeLineInsertParams,
): Promise<BuildJeLineInsertResult> {
  const {
    wallet_currency, primary_currency, date,
    debit, credit, account_name, account_code, description, book_value,
    manualRate, encrypt,
  } = params;

  // Validate manual rate reason length at the boundary
  if (manualRate && manualRate.reason.length < 40) {
    throw new Error(
      `Manual rate reason must be at least 40 characters (got ${manualRate.reason.length}). ` +
      'This is required for audit compliance.',
    );
  }

  // Signed native amount: debit = positive, credit = negative.
  // This matches standard accounting sign convention for a single amount field.
  const amount_native = debit > 0 ? debit : -credit;

  let rate = 0;
  let rateId: string | null = null;
  let rateBucketTs: string | null = null;
  let pending = false;
  let manualRateReason: string | null = null;
  let manualRateSource: string | null = null;

  if (manualRate) {
    // Manual rate path — skip the resolver entirely
    rate = manualRate.rate;
    manualRateReason = manualRate.reason;
    manualRateSource = manualRate.source;
    pending = false;
    // bucketTs for manual = the DAY bucket of the JE date
    rateBucketTs = new Date(
      Date.UTC(
        new Date(date).getUTCFullYear(),
        new Date(date).getUTCMonth(),
        new Date(date).getUTCDate(),
      ),
    ).toISOString();
  } else {
    // Automatic path — call the resolver
    const resolved = await resolvePinnedRate({
      source: wallet_currency,
      target: primary_currency,
      at: date,
    });
    rate = resolved.rate;
    rateId = resolved.rateId;
    rateBucketTs = resolved.bucketTs;
    pending = resolved.pending;
  }

  // amount_primary = amount_native × rate (null when pending — rate unknown)
  const amount_primary = pending ? null : amount_native * rate;

  // Build the fields object for the base encrypt function
  const fields = {
    account_name: account_name ?? null,
    account_code: account_code ?? null,
    description: description ?? null,
    debit,
    credit,
    book_value: book_value ?? null,
    amount_native,
    amount_primary,
    posted_rate: pending ? null : rate,
    wallet_currency,
  };

  const meta = {
    primary_currency_at_posting: primary_currency,
    rate_pending: pending,
    rate_asof: rateBucketTs,
    pinned_rate_id: rateId,
    manual_rate_reason: manualRateReason,
    manual_rate_source: manualRateSource,
  };

  const insert = await encryptJournalEntryLine(fields, encrypt, meta);

  return { insert, pending, rate, rateBucketTs };
}
