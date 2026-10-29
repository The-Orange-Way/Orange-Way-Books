import { resolvePinnedRate } from './rate-resolver';
import { encryptJournalEntryLine, type JournalEntryLineEncrypted } from '@/lib/crypto-fields';

type EncryptFn = (plaintext: string) => Promise<string>;

// -- Input types ---------------------------------------------------------------

export interface ManualRate {
  rate: number;
  /** Free-text explanation of where the rate came from. Minimum 40 characters. */
  reason: string;
  /** Structured source label (e.g. "OANDA.com", "CPA-quoted", "Spot rate from bank", "Other"). */
  source: string;
}

/**
 * A pinned rate captured verbatim from an existing journal entry line.
 * Used by void/reverse to replay the original rate without calling the resolver.
 * amount_primary is already sign-flipped by the caller to match the new direction.
 */
export interface PinnedRateInput {
  /** The rate originally posted (primary per wallet unit). Null when rate_pending. */
  posted_rate: number | null;
  /** UUID of the pinned rate row. Null for manual or pending rates. */
  pinned_rate_id: string | null;
  /** Bucket timestamp of the pinned rate. */
  rate_asof: string | null;
  /** Free-text explanation for a manually supplied rate. */
  manual_rate_reason: string | null;
  /** Structured source label for a manually supplied rate. */
  manual_rate_source: string | null;
  /**
   * Pre-computed primary-currency amount, already sign-flipped by the caller
   * to match the reversing direction. Null when rate_pending is true.
   */
  amount_primary: number | null;
  /** True when the original rate could not be resolved. */
  rate_pending: boolean;
}

export interface BuildJeLineInsertParams {
  /** Wallet currency of this line (e.g. "MXN"). */
  wallet_currency: string;
  /** Org's current primary (functional) currency (e.g. "BTC"). */
  primary_currency: string;
  /** Journal entry date -- used to pin the rate bucket (YYYY-MM-DD or ISO). */
  date: string;
  /** Positive debit amount in wallet currency (0 if this is a credit line). */
  debit: number;
  /** Positive credit amount in wallet currency (0 if this is a debit line). */
  credit: number;
  /** chart_of_accounts.id the line posts to. journal_entry_lines.account_id is
   *  NOT NULL, so a line without it is refused by the database. */
  account_id: string;
  /** Optional account fields passed through to encryptJournalEntryLine. */
  account_name?: string | null;
  account_code?: string | null;
  description?: string | null;
  book_value?: number | null;
  /** If provided, skip the resolver and use this rate instead. */
  manualRate?: ManualRate;
  /**
   * If provided, replay the original rate from a prior JE line verbatim.
   * Takes precedence over manualRate and skips the resolver entirely (0 calls).
   * The caller supplies amount_primary already sign-flipped for the new direction.
   */
  pinnedRate?: PinnedRateInput;
  /** Vault encryption function from VaultContext. */
  encrypt: EncryptFn;
}

// -- Result -------------------------------------------------------------------

export interface BuildJeLineInsertResult {
  /** Ready-to-insert row for the journal_entry_lines table. */
  insert: JournalEntryLineEncrypted & { account_id: string };
  /** True when the exchange rate could not be resolved -- line is stored but
   *  excluded from formal reports until the rate is resolved manually. */
  pending: boolean;
  /** The resolved rate (primary per wallet unit), or 0 when pending. */
  rate: number;
  /** Bucket timestamp of the pinned rate. */
  rateBucketTs: string | null;
}

// -- Builder ------------------------------------------------------------------

/**
 * Build an encrypted JE line insert row with full dual-currency amounts.
 *
 * Responsibilities:
 *  1. Resolve the exchange rate (pinnedRate > manualRate > resolver > pending fallback).
 *  2. Compute amount_native (signed wallet amount) and amount_primary.
 *  3. Encrypt all fields via encryptJournalEntryLine.
 *  4. Attach plaintext metadata (pinned_rate_id, rate_pending, etc.).
 *
 * The caller inserts the returned `insert` object directly into
 * `journal_entry_lines` -- no further transformation needed.
 */
export async function buildJournalEntryLineInsert(
  params: BuildJeLineInsertParams,
): Promise<BuildJeLineInsertResult> {
  const {
    wallet_currency,
    primary_currency,
    date,
    debit,
    credit,
    account_id,
    account_name,
    account_code,
    description,
    book_value,
    manualRate,
    pinnedRate,
    encrypt,
  } = params;

  if (!account_id) {
    throw new Error('Every journal entry line needs an account.');
  }

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
  // When pinnedRate is supplied the caller pre-computes amount_primary (already
  // sign-flipped); use it verbatim instead of recomputing from amount_native * rate.
  // undefined = pinnedRate not supplied; null = supplied but amount is null (pending).
  let overrideAmountPrimary: number | null | undefined = undefined;

  if (pinnedRate) {
    // Pinned-rate path -- replay original rate fields verbatim, zero resolver calls.
    if (pinnedRate.rate_pending) {
      pending = true;
      overrideAmountPrimary = null;
    } else {
      rate = pinnedRate.posted_rate ?? 0;
      rateId = pinnedRate.pinned_rate_id;
      rateBucketTs = pinnedRate.rate_asof;
      manualRateReason = pinnedRate.manual_rate_reason;
      manualRateSource = pinnedRate.manual_rate_source;
      overrideAmountPrimary = pinnedRate.amount_primary;
    }
  } else if (manualRate) {
    // Manual rate path -- skip the resolver entirely
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
    // Automatic path -- call the resolver
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

  // amount_primary: use the caller-supplied value when pinnedRate was given
  // (it is already sign-correct for the new direction); otherwise compute from
  // amount_native * rate as usual.
  const amount_primary =
    overrideAmountPrimary !== undefined
      ? overrideAmountPrimary
      : pending
        ? null
        : amount_native * rate;

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

  const insert = { account_id, ...(await encryptJournalEntryLine(fields, encrypt, meta)) };

  return { insert, pending, rate, rateBucketTs };
}
