export type EncryptFn = (plaintext: string) => Promise<string>;
export type DecryptFn = (ciphertext: string) => Promise<string>;

const L2 = 2;

/**
 * Active field-level encryption key version stamped on every row our
 * encrypt helpers write. This is NOT the vault MEK / KEK version
 * (which lives in `vault.ts` as LATEST_VAULT_KEY_VERSION). That's
 * the password-derived KEK, which is one layer above the symmetric DEK
 * applied at the row/column level here. Callers that write encrypted
 * columns directly (status flips, key_version migrations) should import
 * this constant rather than hard-coding a literal so a future bump to
 * L3 only touches one file.
 */
export const FIELD_KEY_VERSION = L2;

/**
 * Heuristic: does this value look like AES-GCM base64 ciphertext?
 * A legitimate short plaintext (e.g. a 3-letter currency code "USD") is
 * never >20 chars and doesn't match the base64 char class here.
 * AES-GCM output of even a short string is at least 12-byte IV + 16-byte
 * auth tag = 28 bytes → ~40 base64 chars.
 *
 * Used as a safety net when key_version is missing/0 but the value was
 * clearly written by the encrypt helpers (e.g. migration-limbo rows
 * where the row was inserted before the key_version column existed and
 * defaulted to 0 after the column was added).
 */
function looksEncrypted(value: string | null | undefined): boolean {
  if (!value || typeof value !== 'string') return false;
  if (value.length < 24) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

async function encryptNullable(value: string | null, encrypt: EncryptFn): Promise<string | null> {
  if (!value) return null;
  return encrypt(value);
}

async function decryptNullable(
  value: string | null,
  decrypt: DecryptFn,
  kv?: number | null,
): Promise<string | null> {
  if (!value) return null;
  if (kv && kv >= L2) return decrypt(value);
  // Limbo fallback: row has no key_version but the value itself looks
  // like AES-GCM ciphertext. Attempt to decrypt; if it fails, return the
  // original so callers don't crash (they'll see ciphertext rather than
  // undefined/null).
  if (looksEncrypted(value)) {
    try {
      return await decrypt(value);
    } catch {
      return value;
    }
  }
  return value;
}

export async function encryptNumber(
  value: number | null | undefined,
  encrypt: EncryptFn,
): Promise<string | null> {
  if (value == null) return null;
  return encrypt(String(value));
}

async function decryptNumber(
  cipher: string | null,
  decrypt: DecryptFn,
  kv?: number | null,
  fallback?: number | null,
): Promise<number | null> {
  if (kv && kv >= L2 && cipher) return parseFloat(await decrypt(cipher));
  return fallback ?? null;
}

async function encryptBoolean(
  value: boolean | null | undefined,
  encrypt: EncryptFn,
): Promise<string | null> {
  if (value == null) return null;
  return encrypt(value ? 'true' : 'false');
}

async function decryptBoolean(
  cipher: string | null,
  decrypt: DecryptFn,
  kv?: number | null,
  fallback?: boolean | null,
): Promise<boolean> {
  if (kv && kv >= L2 && cipher) return (await decrypt(cipher)) === 'true';
  return fallback ?? false;
}

// ── Organizations ──

export interface OrganizationFields {
  name: string;
}

export async function encryptOrganization(
  fields: OrganizationFields,
  encrypt: EncryptFn,
): Promise<OrganizationFields & { key_version: number }> {
  return {
    name: await encrypt(fields.name),
    key_version: L2,
  };
}

export async function decryptOrganization(
  row: OrganizationFields & { key_version?: number | null },
  decrypt: DecryptFn,
): Promise<OrganizationFields> {
  if (!row.key_version) return { name: row.name };
  return { name: await decrypt(row.name) };
}

// ── Contacts ──

export interface ContactFields {
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  country: string | null;
  // Additional PII, also encrypted at rest under the same ZKA L2 scheme.
  email: string | null;
  phone: string | null;
  type: string | null;
}

export async function encryptContact(
  fields: ContactFields,
  encrypt: EncryptFn,
): Promise<ContactFields & { key_version: number }> {
  const [name, street, city, state, zip, country, email, phone, type] = await Promise.all([
    encrypt(fields.name),
    encryptNullable(fields.street, encrypt),
    encryptNullable(fields.city, encrypt),
    encryptNullable(fields.state, encrypt),
    encryptNullable(fields.zip, encrypt),
    encryptNullable(fields.country, encrypt),
    encryptNullable(fields.email, encrypt),
    encryptNullable(fields.phone, encrypt),
    encryptNullable(fields.type, encrypt),
  ]);
  return { name, street, city, state, zip, country, email, phone, type, key_version: L2 };
}

export async function decryptContact(
  row: ContactFields & { key_version?: number | null },
  decrypt: DecryptFn,
): Promise<ContactFields> {
  if (!row.key_version)
    return {
      name: row.name,
      street: row.street,
      city: row.city,
      state: row.state,
      zip: row.zip,
      country: row.country,
      email: row.email ?? null,
      phone: row.phone ?? null,
      type: row.type ?? null,
    };
  const [name, street, city, state, zip, country, email, phone, type] = await Promise.all([
    decrypt(row.name),
    decryptNullable(row.street, decrypt, row.key_version),
    decryptNullable(row.city, decrypt, row.key_version),
    decryptNullable(row.state, decrypt, row.key_version),
    decryptNullable(row.zip, decrypt, row.key_version),
    decryptNullable(row.country, decrypt, row.key_version),
    decryptNullable(row.email ?? null, decrypt, row.key_version),
    decryptNullable(row.phone ?? null, decrypt, row.key_version),
    decryptNullable(row.type ?? null, decrypt, row.key_version),
  ]);
  return { name, street, city, state, zip, country, email, phone, type };
}

// ── Accounts ──

export interface WalletFields {
  encrypted_name: string;
  initial_balance: number | null;
  asset: string;
  account_type: string | null;
  connection_type: string | null;
  external_account_code: string | null;
}

export interface WalletEncrypted {
  encrypted_name: string;
  encrypted_balance: string | null;
  asset: string;
  account_type: string | null;
  connection_type: string | null;
  external_account_code: string | null;
  initial_balance: number;
  key_version: number;
}

export async function encryptWallet(
  fields: WalletFields,
  encrypt: EncryptFn,
): Promise<WalletEncrypted> {
  const [
    encrypted_name,
    encrypted_balance,
    asset,
    account_type,
    connection_type,
    external_account_code,
  ] = await Promise.all([
    encrypt(fields.encrypted_name),
    encryptNumber(fields.initial_balance, encrypt),
    encrypt(fields.asset),
    encryptNullable(fields.account_type, encrypt),
    encryptNullable(fields.connection_type, encrypt),
    encryptNullable(fields.external_account_code, encrypt),
  ]);
  return {
    encrypted_name,
    encrypted_balance,
    asset,
    account_type,
    connection_type,
    external_account_code,
    initial_balance: 0,
    key_version: L2,
  };
}

export async function decryptWallet(row: any, decrypt: DecryptFn): Promise<WalletFields> {
  const kv = row.key_version;
  if (!kv)
    return {
      encrypted_name: row.encrypted_name,
      initial_balance: row.initial_balance,
      asset: row.asset,
      account_type: row.account_type,
      connection_type: row.connection_type,
      external_account_code: row.external_account_code,
    };
  const [
    encrypted_name,
    initial_balance,
    asset,
    account_type,
    connection_type,
    external_account_code,
  ] = await Promise.all([
    decrypt(row.encrypted_name),
    decryptNumber(row.encrypted_balance, decrypt, kv, row.initial_balance),
    kv >= L2 ? decrypt(row.asset) : Promise.resolve(row.asset),
    decryptNullable(row.account_type, decrypt, kv >= L2 ? kv : null),
    decryptNullable(row.connection_type, decrypt, kv >= L2 ? kv : null),
    decryptNullable(row.external_account_code, decrypt, kv >= L2 ? kv : null),
  ]);
  return {
    encrypted_name,
    initial_balance,
    asset,
    account_type,
    connection_type,
    external_account_code,
  };
}

// ── Transactions ──

export interface TransactionFields {
  memo: string | null;
  amount: number;
  usd_value: number | null;
  exchange_rate: number | null;
  asset: string;
  type: string;
  status: string | null;
  cleared_status: string | null;
}

export interface TransactionEncrypted {
  memo: string | null;
  encrypted_amount: string | null;
  encrypted_usd_value: string | null;
  encrypted_exchange_rate: string | null;
  asset: string;
  type: string;
  status: string | null;
  cleared_status: string | null;
  amount: number;
  usd_value: null;
  exchange_rate: null;
  key_version: number;
}

export async function encryptTransaction(
  fields: TransactionFields,
  encrypt: EncryptFn,
): Promise<TransactionEncrypted> {
  const [
    memo,
    encrypted_amount,
    encrypted_usd_value,
    encrypted_exchange_rate,
    asset,
    type,
    status,
    cleared_status,
  ] = await Promise.all([
    encryptNullable(fields.memo, encrypt),
    encryptNumber(fields.amount, encrypt),
    encryptNumber(fields.usd_value, encrypt),
    encryptNumber(fields.exchange_rate, encrypt),
    encrypt(fields.asset),
    encrypt(fields.type),
    encryptNullable(fields.status, encrypt),
    encryptNullable(fields.cleared_status, encrypt),
  ]);
  return {
    memo,
    encrypted_amount,
    encrypted_usd_value,
    encrypted_exchange_rate,
    asset,
    type,
    status,
    cleared_status,
    amount: 0,
    usd_value: null,
    exchange_rate: null,
    key_version: L2,
  };
}

export async function decryptTransaction(row: any, decrypt: DecryptFn): Promise<TransactionFields> {
  const kv = row.key_version;
  if (!kv)
    return {
      memo: row.memo,
      amount: row.amount,
      usd_value: row.usd_value,
      exchange_rate: row.exchange_rate,
      asset: row.asset,
      type: row.type,
      status: row.status,
      cleared_status: row.cleared_status,
    };
  const isL2 = kv >= L2;
  const [memo, amount, usd_value, exchange_rate, asset, type, status, cleared_status] =
    await Promise.all([
      decryptNullable(row.memo, decrypt, kv),
      decryptNumber(row.encrypted_amount, decrypt, kv, row.amount),
      decryptNumber(row.encrypted_usd_value, decrypt, kv, row.usd_value),
      decryptNumber(row.encrypted_exchange_rate, decrypt, kv, row.exchange_rate),
      isL2 ? decrypt(row.asset) : Promise.resolve(row.asset),
      isL2 ? decrypt(row.type) : Promise.resolve(row.type),
      isL2 ? decryptNullable(row.status, decrypt, kv) : Promise.resolve(row.status),
      isL2 ? decryptNullable(row.cleared_status, decrypt, kv) : Promise.resolve(row.cleared_status),
    ]);
  return {
    memo,
    amount: amount ?? 0,
    usd_value,
    exchange_rate,
    asset,
    type,
    status,
    cleared_status,
  };
}

// ── Journal Entries ──

export interface JournalEntryFields {
  memo: string | null;
  ref_number: string | null;
  currency: string;
  exchange_rate: number | null;
  status: string;
  source_type: string | null;
  period_locked: boolean;
}

/**
 * Post-Phase 1: the column NAMES are now
 * encrypted_memo / encrypted_ref_number / encrypted_currency. `status`
 * and `source_type` are PLAINTEXT (server needs to read them to
 * enforce immutability via the trigger pair).
 *
 * Migration plan tracked in commit history.
 */
export interface JournalEntryEncrypted {
  encrypted_memo: string | null;
  encrypted_ref_number: string | null;
  encrypted_currency: string;
  encrypted_exchange_rate: string | null;
  encrypted_period_locked: string | null;
  status: string; // PLAINTEXT
  source_type: string | null; // PLAINTEXT
  key_version: number;
}

export async function encryptJournalEntry(
  fields: JournalEntryFields,
  encrypt: EncryptFn,
): Promise<JournalEntryEncrypted> {
  const [
    encrypted_memo,
    encrypted_ref_number,
    encrypted_currency,
    encrypted_exchange_rate,
    encrypted_period_locked,
  ] = await Promise.all([
    encryptNullable(fields.memo, encrypt),
    encryptNullable(fields.ref_number, encrypt),
    encrypt(fields.currency),
    encryptNumber(fields.exchange_rate, encrypt),
    encryptBoolean(fields.period_locked, encrypt),
  ]);
  // status + source_type are plaintext, server reads them to gate
  // the immutability trigger. Validated against the DB CHECK constraint.
  return {
    encrypted_memo,
    encrypted_ref_number,
    encrypted_currency,
    encrypted_exchange_rate,
    encrypted_period_locked,
    status: fields.status,
    source_type: fields.source_type,
    key_version: L2,
  };
}

export async function decryptJournalEntry(
  row: any,
  decrypt: DecryptFn,
): Promise<JournalEntryFields> {
  // status + source_type are now plaintext columns post-Phase 1. No decrypt.
  const [memo, ref_number, currency, exchange_rate, period_locked] = await Promise.all([
    decryptNullable(row.encrypted_memo, decrypt, row.key_version ?? L2),
    decryptNullable(row.encrypted_ref_number, decrypt, row.key_version ?? L2),
    row.encrypted_currency ? decrypt(row.encrypted_currency) : Promise.resolve('USD'),
    decryptNumber(row.encrypted_exchange_rate, decrypt, row.key_version ?? L2, null),
    decryptBoolean(row.encrypted_period_locked, decrypt, row.key_version ?? L2, false),
  ]);
  return {
    memo,
    ref_number,
    currency,
    exchange_rate,
    status: row.status, // plaintext
    source_type: row.source_type, // plaintext
    period_locked,
  };
}

// ── Journal Entry Lines ──

export interface JournalEntryLineFields {
  account_name: string | null;
  account_code: string | null;
  description: string | null;
  debit: number;
  credit: number;
  book_value: number | null;
  // Dual-currency fields (null for pre-dual rows; populated by Part 4 builder)
  amount_native?: number | null;
  amount_primary?: number | null;
  posted_rate?: number | null;
  wallet_currency?: string | null;
}

/**
 * Post-Phase 1: the schema no longer has plaintext debit/credit/book_value
 * placeholder columns (they were always zeroed). Encrypted amounts are the
 * only source of truth. manual_rate_reason / manual_rate_source /
 * primary_currency_at_posting are now encrypted too, they were plaintext
 * customer-typed content on the old schema, which violated the ZKA bar.
 */
export interface JournalEntryLineEncrypted {
  account_name: string | null;
  account_code: string | null;
  description: string | null;
  encrypted_debit: string | null;
  encrypted_credit: string | null;
  encrypted_book_value: string | null;
  key_version: number;
  // Dual-currency encrypted columns
  encrypted_amount_native: string | null;
  encrypted_amount_primary: string | null;
  encrypted_posted_rate: string | null;
  encrypted_wallet_currency: string | null;
  // Encrypted (previously plaintext), corrects ZKA leak per redesign
  encrypted_primary_currency_at_posting: string | null;
  encrypted_manual_rate_reason: string | null;
  encrypted_manual_rate_source: string | null;
  // Plaintext structural metadata
  rate_pending: boolean;
  rate_asof: string | null;
  pinned_rate_id: string | null;
  dual_amounts_backfilled: boolean;
}

export async function encryptJournalEntryLine(
  fields: JournalEntryLineFields,
  encrypt: EncryptFn,
  meta?: {
    primary_currency_at_posting?: string | null;
    rate_pending?: boolean;
    rate_asof?: string | null;
    pinned_rate_id?: string | null;
    manual_rate_reason?: string | null;
    manual_rate_source?: string | null;
  },
): Promise<JournalEntryLineEncrypted> {
  const [
    account_name,
    account_code,
    description,
    encrypted_debit,
    encrypted_credit,
    encrypted_book_value,
    encrypted_amount_native,
    encrypted_amount_primary,
    encrypted_posted_rate,
    encrypted_wallet_currency,
    encrypted_primary_currency_at_posting,
    encrypted_manual_rate_reason,
    encrypted_manual_rate_source,
  ] = await Promise.all([
    encryptNullable(fields.account_name, encrypt),
    encryptNullable(fields.account_code, encrypt),
    encryptNullable(fields.description, encrypt),
    encryptNumber(fields.debit, encrypt),
    encryptNumber(fields.credit, encrypt),
    encryptNumber(fields.book_value, encrypt),
    encryptNumber(fields.amount_native ?? null, encrypt),
    encryptNumber(fields.amount_primary ?? null, encrypt),
    encryptNumber(fields.posted_rate ?? null, encrypt),
    encryptNullable(fields.wallet_currency ?? null, encrypt),
    encryptNullable(meta?.primary_currency_at_posting ?? null, encrypt),
    encryptNullable(meta?.manual_rate_reason ?? null, encrypt),
    encryptNullable(meta?.manual_rate_source ?? null, encrypt),
  ]);
  const hasDual = fields.amount_native != null && fields.amount_primary != null;
  return {
    account_name,
    account_code,
    description,
    encrypted_debit,
    encrypted_credit,
    encrypted_book_value,
    key_version: L2,
    encrypted_amount_native,
    encrypted_amount_primary,
    encrypted_posted_rate,
    encrypted_wallet_currency,
    encrypted_primary_currency_at_posting,
    encrypted_manual_rate_reason,
    encrypted_manual_rate_source,
    rate_pending: meta?.rate_pending ?? false,
    rate_asof: meta?.rate_asof ?? null,
    pinned_rate_id: meta?.pinned_rate_id ?? null,
    dual_amounts_backfilled: hasDual,
  };
}

export async function decryptJournalEntryLine(
  row: any,
  decrypt: DecryptFn,
): Promise<JournalEntryLineFields> {
  const kv = row.key_version;
  if (!kv)
    return {
      account_name: row.account_name,
      account_code: row.account_code,
      description: row.description,
      debit: 0,
      credit: 0,
      book_value: null,
    };
  // Post-Phase 1: plaintext debit/credit/book_value columns no longer exist.
  // The null fallbacks pass through unchanged when encrypted_* is null.
  const [
    account_name,
    account_code,
    description,
    debit,
    credit,
    book_value,
    amount_native,
    amount_primary,
    posted_rate,
    wallet_currency,
  ] = await Promise.all([
    decryptNullable(row.account_name, decrypt, kv),
    decryptNullable(row.account_code, decrypt, kv),
    decryptNullable(row.description, decrypt, kv),
    decryptNumber(row.encrypted_debit, decrypt, kv, null),
    decryptNumber(row.encrypted_credit, decrypt, kv, null),
    decryptNumber(row.encrypted_book_value, decrypt, kv, null),
    decryptNumber(row.encrypted_amount_native, decrypt, kv, null),
    decryptNumber(row.encrypted_amount_primary, decrypt, kv, null),
    decryptNumber(row.encrypted_posted_rate, decrypt, kv, null),
    decryptNullable(row.encrypted_wallet_currency, decrypt, kv),
  ]);
  return {
    account_name,
    account_code,
    description,
    debit: debit ?? 0,
    credit: credit ?? 0,
    book_value,
    amount_native: amount_native ?? null,
    amount_primary: amount_primary ?? null,
    posted_rate: posted_rate ?? null,
    wallet_currency: wallet_currency ?? null,
  };
}

// ── the ledger Account Map ──

export interface LegacyAccountFields {
  account_name: string;
  account_code: string | null;
  account_type: string;
  account_group: string | null;
  account_category: string | null;
  is_archived: boolean;
  /** Plaintext structural parent link (optional). */
  parent_id?: string | null;
  /** New ZKA fields per Phase 1 redesign. */
  account_sub_type?: string | null;
  is_group?: boolean;
  is_system?: boolean;
  allowed_currencies?: string[] | null;
  description?: string | null;
}

/**
 * Post-Phase 1: replaces encryptChartOfAccount. Writes to `chart_of_accounts`
 * (no longer chart_of_accounts). Encrypts all customer-meaningful columns:
 * name, code, description, account_type, account_sub_type, is_group,
 * is_system, allowed_currencies. The `is_archived` column was already
 * encrypted; preserved.
 *
 * Plaintext structural: id, org_id, parent_id, opened_at, closed_at,
 * key_version, timestamps.
 */
export async function encryptChartOfAccount(
  fields: LegacyAccountFields,
  encrypt: EncryptFn,
): Promise<{
  encrypted_name: string;
  encrypted_code: string | null;
  encrypted_description: string | null;
  encrypted_account_type: string;
  encrypted_account_sub_type: string | null;
  encrypted_is_group: string;
  encrypted_is_system: string;
  encrypted_is_archived: string | null;
  encrypted_allowed_currencies: string | null;
  key_version: number;
  parent_id: string | null;
}> {
  const allowedJson = fields.allowed_currencies ? JSON.stringify(fields.allowed_currencies) : null;
  const [
    encrypted_name,
    encrypted_code,
    encrypted_description,
    encrypted_account_type,
    encrypted_account_sub_type,
    encrypted_is_group,
    encrypted_is_system,
    encrypted_is_archived,
    encrypted_allowed_currencies,
  ] = await Promise.all([
    encrypt(fields.account_name),
    encryptNullable(fields.account_code, encrypt),
    encryptNullable(fields.description ?? null, encrypt),
    encrypt(fields.account_type),
    encryptNullable(fields.account_sub_type ?? null, encrypt),
    encryptBoolean(fields.is_group ?? false, encrypt),
    encryptBoolean(fields.is_system ?? false, encrypt),
    encryptBoolean(fields.is_archived, encrypt),
    encryptNullable(allowedJson, encrypt),
  ]);
  return {
    encrypted_name,
    encrypted_code,
    encrypted_description,
    encrypted_account_type,
    encrypted_account_sub_type,
    encrypted_is_group: encrypted_is_group!,
    encrypted_is_system: encrypted_is_system!,
    encrypted_is_archived,
    encrypted_allowed_currencies,
    key_version: L2,
    parent_id: fields.parent_id ?? null,
  };
}

export async function decryptChartOfAccount(
  row: any,
  decrypt: DecryptFn,
): Promise<LegacyAccountFields> {
  const [
    account_name,
    account_code,
    description,
    account_type,
    account_sub_type,
    is_group,
    is_system,
    is_archived,
    allowed_currencies_json,
  ] = await Promise.all([
    decrypt(row.encrypted_name),
    decryptNullable(row.encrypted_code, decrypt, row.key_version ?? L2),
    decryptNullable(row.encrypted_description, decrypt, row.key_version ?? L2),
    decrypt(row.encrypted_account_type),
    decryptNullable(row.encrypted_account_sub_type, decrypt, row.key_version ?? L2),
    decryptBoolean(row.encrypted_is_group, decrypt, row.key_version ?? L2, false),
    decryptBoolean(row.encrypted_is_system, decrypt, row.key_version ?? L2, false),
    decryptBoolean(row.encrypted_is_archived, decrypt, row.key_version ?? L2, false),
    decryptNullable(row.encrypted_allowed_currencies, decrypt, row.key_version ?? L2),
  ]);
  return {
    account_name,
    account_code,
    description,
    account_type,
    account_group: null, // legacy field; new schema folds into encrypted_metadata if needed
    account_category: null, // legacy field
    account_sub_type,
    is_group,
    is_system,
    is_archived,
    allowed_currencies: allowed_currencies_json ? JSON.parse(allowed_currencies_json) : null,
    parent_id: row.parent_id ?? null,
  };
}

// ── Payment Requests ──

export interface PaymentRequestFields {
  payee: string | null;
  description: string | null;
  rejection_reason: string | null;
  amount: number;
  currency: string;
  status: string;
  request_type: string;
  vendor_ref: string | null;
  payment_address: string | null;
}

export async function encryptPaymentRequest(
  fields: PaymentRequestFields,
  encrypt: EncryptFn,
): Promise<{
  encrypted_payee: string | null;
  encrypted_description: string | null;
  encrypted_rejection_reason: string | null;
  encrypted_amount: string | null;
  amount: number;
  currency: string;
  status: string;
  request_type: string;
  vendor_ref: string | null;
  payment_address: string | null;
  key_version: number;
}> {
  const [
    encrypted_payee,
    encrypted_description,
    encrypted_rejection_reason,
    encrypted_amount,
    currency,
    status,
    request_type,
    vendor_ref,
    payment_address,
  ] = await Promise.all([
    encryptNullable(fields.payee, encrypt),
    encryptNullable(fields.description, encrypt),
    encryptNullable(fields.rejection_reason, encrypt),
    encryptNumber(fields.amount, encrypt),
    encrypt(fields.currency),
    encrypt(fields.status),
    encrypt(fields.request_type),
    encryptNullable(fields.vendor_ref, encrypt),
    encryptNullable(fields.payment_address, encrypt),
  ]);
  return {
    encrypted_payee,
    encrypted_description,
    encrypted_rejection_reason,
    encrypted_amount,
    amount: 0,
    currency,
    status,
    request_type,
    vendor_ref,
    payment_address,
    key_version: L2,
  };
}

export async function decryptPaymentRequest(
  row: any,
  decrypt: DecryptFn,
): Promise<PaymentRequestFields> {
  const kv = row.key_version;
  if (!kv)
    return {
      payee: row.encrypted_payee,
      description: row.encrypted_description,
      rejection_reason: row.encrypted_rejection_reason,
      amount: row.amount,
      currency: row.currency,
      status: row.status,
      request_type: row.request_type,
      vendor_ref: row.vendor_ref,
      payment_address: row.payment_address,
    };
  const isL2 = kv >= L2;
  // Fail closed. If a row claims a key_version but decryption of any field
  // fails (key mismatch, tampered ciphertext, wrong MEK) we must NOT return
  // the raw ciphertext, that turns a cryptographic failure into silent bad
  // data in the UI. Wrap each field so we can attach which field failed,
  // then let the error bubble up to the page-level try/catch.
  const failingField = async <T>(field: string, work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to decrypt payment_request.${field}: ${msg}`);
    }
  };
  const decryptTextField = async (
    cipher: string | null | undefined,
    active: boolean,
    field: string,
  ): Promise<string> => {
    if (cipher == null || cipher === '') return '';
    if (!active) return String(cipher);
    return failingField(field, decrypt(cipher));
  };
  const decryptNullableField = async (
    cipher: string | null | undefined,
    active: boolean,
    field: string,
  ): Promise<string | null> => {
    if (cipher == null || cipher === '') return null;
    if (!active) return cipher;
    return failingField(field, decrypt(cipher));
  };
  const amount = await failingField(
    'encrypted_amount',
    decryptNumber(row.encrypted_amount, decrypt, kv, row.amount),
  );
  const [
    payee,
    description,
    rejection_reason,
    currency,
    status,
    request_type,
    vendor_ref,
    payment_address,
  ] = await Promise.all([
    decryptNullableField(row.encrypted_payee, !!kv, 'encrypted_payee'),
    decryptNullableField(row.encrypted_description, !!kv, 'encrypted_description'),
    decryptNullableField(row.encrypted_rejection_reason, !!kv, 'encrypted_rejection_reason'),
    decryptTextField(row.currency, isL2, 'currency'),
    decryptTextField(row.status, isL2, 'status'),
    decryptTextField(row.request_type, isL2, 'request_type'),
    decryptNullableField(row.vendor_ref, isL2, 'vendor_ref'),
    decryptNullableField(row.payment_address, isL2, 'payment_address'),
  ]);
  return {
    payee,
    description,
    rejection_reason,
    amount: amount ?? 0,
    currency,
    status,
    request_type,
    vendor_ref,
    payment_address,
  };
}

// ── Payment Request Line Items (T4 PR D) ──

export interface PaymentRequestLineItemFields {
  description: string | null;
  amount: number;
  /** chart_of_accounts FK (chart of accounts row), null for uncategorized. */
  chart_of_accounts_id: string | null;
  /** Display order in the form. */
  sort_order: number;
}

export interface PaymentRequestLineItemEncrypted {
  encrypted_description: string | null;
  description: null;
  encrypted_amount: string | null;
  amount: number;
  chart_of_accounts_id: string | null;
  sort_order: number;
  key_version: number;
}

export async function encryptPaymentRequestLineItem(
  fields: PaymentRequestLineItemFields,
  encrypt: EncryptFn,
): Promise<PaymentRequestLineItemEncrypted> {
  const [encrypted_description, encrypted_amount] = await Promise.all([
    encryptNullable(fields.description, encrypt),
    encryptNumber(fields.amount, encrypt),
  ]);
  return {
    encrypted_description,
    description: null,
    encrypted_amount,
    amount: 0,
    chart_of_accounts_id: fields.chart_of_accounts_id,
    sort_order: fields.sort_order,
    key_version: L2,
  };
}

export async function decryptPaymentRequestLineItem(
  row: any,
  decrypt: DecryptFn,
): Promise<PaymentRequestLineItemFields> {
  const kv = row.key_version;
  const [description, amount] = await Promise.all([
    decryptNullable(row.encrypted_description, decrypt, kv),
    decryptNumber(row.encrypted_amount, decrypt, kv, row.amount),
  ]);
  return {
    description,
    amount: amount ?? 0,
    chart_of_accounts_id: row.chart_of_accounts_id ?? null,
    sort_order: row.sort_order ?? 0,
  };
}

// ── Invoices (AR, the Invoicing module) ──
//
// Mirrors PaymentRequest crypto helpers above. Invoices are the AR primitive
// (customer billing); payment_requests are the AP primitive (vendor pay).
// Same encryption strategy: server stores ciphertext for business content,
// plaintext for filter/sort/aging.

export interface InvoiceFields {
  customer_name: string | null;
  customer_email_snapshot: string | null;
  customer_phone_snapshot: string | null;
  customer_address: string | null;
  memo: string | null; // customer-facing
  internal_notes: string | null; // org-only
  payment_instructions: string | null; // BTC address / Lightning / bank
  void_reason: string | null;
  write_off_reason: string | null;
  amount: number;
}

export async function encryptInvoice(
  fields: InvoiceFields,
  encrypt: EncryptFn,
): Promise<{
  encrypted_customer_name: string | null;
  encrypted_customer_email_snapshot: string | null;
  encrypted_customer_phone_snapshot: string | null;
  encrypted_customer_address: string | null;
  encrypted_memo: string | null;
  encrypted_internal_notes: string | null;
  encrypted_payment_instructions: string | null;
  encrypted_void_reason: string | null;
  encrypted_write_off_reason: string | null;
  encrypted_amount: string | null;
  amount: number;
  key_version: number;
}> {
  const [
    encrypted_customer_name,
    encrypted_customer_email_snapshot,
    encrypted_customer_phone_snapshot,
    encrypted_customer_address,
    encrypted_memo,
    encrypted_internal_notes,
    encrypted_payment_instructions,
    encrypted_void_reason,
    encrypted_write_off_reason,
    encrypted_amount,
  ] = await Promise.all([
    encryptNullable(fields.customer_name, encrypt),
    encryptNullable(fields.customer_email_snapshot, encrypt),
    encryptNullable(fields.customer_phone_snapshot, encrypt),
    encryptNullable(fields.customer_address, encrypt),
    encryptNullable(fields.memo, encrypt),
    encryptNullable(fields.internal_notes, encrypt),
    encryptNullable(fields.payment_instructions, encrypt),
    encryptNullable(fields.void_reason, encrypt),
    encryptNullable(fields.write_off_reason, encrypt),
    encryptNumber(fields.amount, encrypt),
  ]);
  return {
    encrypted_customer_name,
    encrypted_customer_email_snapshot,
    encrypted_customer_phone_snapshot,
    encrypted_customer_address,
    encrypted_memo,
    encrypted_internal_notes,
    encrypted_payment_instructions,
    encrypted_void_reason,
    encrypted_write_off_reason,
    encrypted_amount,
    amount: 0,
    key_version: L2,
  };
}

export async function decryptInvoice(row: any, decrypt: DecryptFn): Promise<InvoiceFields> {
  const kv = row.key_version;
  if (!kv) {
    return {
      customer_name: row.encrypted_customer_name,
      customer_email_snapshot: row.encrypted_customer_email_snapshot,
      customer_phone_snapshot: row.encrypted_customer_phone_snapshot,
      customer_address: row.encrypted_customer_address,
      memo: row.encrypted_memo,
      internal_notes: row.encrypted_internal_notes,
      payment_instructions: row.encrypted_payment_instructions,
      void_reason: row.encrypted_void_reason,
      write_off_reason: row.encrypted_write_off_reason,
      amount: row.amount,
    };
  }

  // Fail-closed: surface field-level decryption failures rather than
  // returning raw ciphertext to the UI.
  const failingField = async <T>(field: string, work: Promise<T>): Promise<T> => {
    try {
      return await work;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to decrypt invoice.${field}: ${msg}`);
    }
  };
  const decryptNullableField = async (
    cipher: string | null | undefined,
    field: string,
  ): Promise<string | null> => {
    if (cipher == null || cipher === '') return null;
    return failingField(field, decrypt(cipher));
  };

  const amount = await failingField(
    'encrypted_amount',
    decryptNumber(row.encrypted_amount, decrypt, kv, row.amount),
  );
  const [
    customer_name,
    customer_email_snapshot,
    customer_phone_snapshot,
    customer_address,
    memo,
    internal_notes,
    payment_instructions,
    void_reason,
    write_off_reason,
  ] = await Promise.all([
    decryptNullableField(row.encrypted_customer_name, 'encrypted_customer_name'),
    decryptNullableField(
      row.encrypted_customer_email_snapshot,
      'encrypted_customer_email_snapshot',
    ),
    decryptNullableField(
      row.encrypted_customer_phone_snapshot,
      'encrypted_customer_phone_snapshot',
    ),
    decryptNullableField(row.encrypted_customer_address, 'encrypted_customer_address'),
    decryptNullableField(row.encrypted_memo, 'encrypted_memo'),
    decryptNullableField(row.encrypted_internal_notes, 'encrypted_internal_notes'),
    decryptNullableField(row.encrypted_payment_instructions, 'encrypted_payment_instructions'),
    decryptNullableField(row.encrypted_void_reason, 'encrypted_void_reason'),
    decryptNullableField(row.encrypted_write_off_reason, 'encrypted_write_off_reason'),
  ]);
  return {
    customer_name,
    customer_email_snapshot,
    customer_phone_snapshot,
    customer_address,
    memo,
    internal_notes,
    payment_instructions,
    void_reason,
    write_off_reason,
    amount: amount ?? 0,
  };
}

export interface InvoiceLineItemFields {
  description: string | null;
  amount: number;
  quantity: number | null;
  unit_price: number | null;
  chart_of_accounts_id: string | null;
  sort_order: number;
}

export async function encryptInvoiceLineItem(
  fields: InvoiceLineItemFields,
  encrypt: EncryptFn,
): Promise<{
  encrypted_description: string | null;
  encrypted_amount: string | null;
  encrypted_quantity: string | null;
  encrypted_unit_price: string | null;
  amount: number;
  chart_of_accounts_id: string | null;
  sort_order: number;
  key_version: number;
}> {
  const [encrypted_description, encrypted_amount, encrypted_quantity, encrypted_unit_price] =
    await Promise.all([
      encryptNullable(fields.description, encrypt),
      encryptNumber(fields.amount, encrypt),
      fields.quantity == null ? Promise.resolve(null) : encryptNumber(fields.quantity, encrypt),
      fields.unit_price == null ? Promise.resolve(null) : encryptNumber(fields.unit_price, encrypt),
    ]);
  return {
    encrypted_description,
    encrypted_amount,
    encrypted_quantity,
    encrypted_unit_price,
    amount: 0,
    chart_of_accounts_id: fields.chart_of_accounts_id,
    sort_order: fields.sort_order,
    key_version: L2,
  };
}

export async function decryptInvoiceLineItem(
  row: any,
  decrypt: DecryptFn,
): Promise<InvoiceLineItemFields> {
  const kv = row.key_version;
  const [description, amount, quantity, unit_price] = await Promise.all([
    decryptNullable(row.encrypted_description, decrypt, kv),
    decryptNumber(row.encrypted_amount, decrypt, kv, row.amount),
    row.encrypted_quantity == null
      ? Promise.resolve(null)
      : decryptNumber(row.encrypted_quantity, decrypt, kv, 0),
    row.encrypted_unit_price == null
      ? Promise.resolve(null)
      : decryptNumber(row.encrypted_unit_price, decrypt, kv, 0),
  ]);
  return {
    description,
    amount: amount ?? 0,
    quantity,
    unit_price,
    chart_of_accounts_id: row.chart_of_accounts_id ?? null,
    sort_order: row.sort_order ?? 0,
  };
}

// ── Audit Logs ──

export interface AuditLogFields {
  summary: string | null;
  before_snapshot: string | null;
  after_snapshot: string | null;
}

export async function encryptAuditLog(
  fields: AuditLogFields,
  encrypt: EncryptFn,
): Promise<AuditLogFields & { key_version: number }> {
  const [summary, before_snapshot, after_snapshot] = await Promise.all([
    encryptNullable(fields.summary, encrypt),
    encryptNullable(fields.before_snapshot, encrypt),
    encryptNullable(fields.after_snapshot, encrypt),
  ]);
  return { summary, before_snapshot, after_snapshot, key_version: L2 };
}

export async function decryptAuditLog(row: any, decrypt: DecryptFn): Promise<AuditLogFields> {
  const kv = row.key_version;
  if (!kv)
    return {
      summary: row.summary,
      before_snapshot: row.before_snapshot,
      after_snapshot: row.after_snapshot,
    };
  const [summary, before_snapshot, after_snapshot] = await Promise.all([
    decryptNullable(row.summary, decrypt, kv),
    decryptNullable(row.before_snapshot, decrypt, kv),
    decryptNullable(row.after_snapshot, decrypt, kv),
  ]);
  return { summary, before_snapshot, after_snapshot };
}

// ── Attachments ──

export interface AttachmentFields {
  file_name: string;
  mime_type: string | null;
}

export async function encryptAttachment(
  fields: AttachmentFields,
  encrypt: EncryptFn,
): Promise<AttachmentFields & { key_version: number }> {
  const [file_name, mime_type] = await Promise.all([
    encrypt(fields.file_name),
    encryptNullable(fields.mime_type, encrypt),
  ]);
  return { file_name, mime_type, key_version: L2 };
}

export async function decryptAttachment(row: any, decrypt: DecryptFn): Promise<AttachmentFields> {
  const kv = row.key_version;
  if (!kv) return { file_name: row.file_name, mime_type: row.mime_type };
  const [file_name, mime_type] = await Promise.all([
    decrypt(row.file_name),
    decryptNullable(row.mime_type, decrypt, kv),
  ]);
  return { file_name, mime_type };
}

// ── Org Settings ──

export interface OrgSettingsFields {
  primary_currency: string | null;
  secondary_currency: string | null;
  bitcoin_display: string | null;
  fiscal_year_type: string | null;
  fiscal_start_month: number | null;
  date_format: string | null;
  time_format: string | null;
  number_format: string | null;
  timezone: string | null;
  // T4 PR C, approval threshold for payment requests.
  // When approval_threshold_amount is non-null, any payment_request submitted
  // with amount > threshold is auto-flagged PENDING on submit. Pair both
  // fields together; either both null (no threshold) or both set.
  approval_threshold_amount?: number | null;
  approval_threshold_currency?: string | null;
}

export interface EncryptedOrgSettings {
  primary_currency: string | null;
  secondary_currency: string | null;
  bitcoin_display: string | null;
  fiscal_year_type: string | null;
  encrypted_fiscal_month: string | null;
  fiscal_start_month: null;
  date_format: string | null;
  time_format: string | null;
  number_format: string | null;
  encrypted_approval_threshold_amount: string | null;
  encrypted_approval_threshold_currency: string | null;
  key_version: number;
}

export async function encryptOrgSettings(
  fields: OrgSettingsFields,
  encrypt: EncryptFn,
): Promise<EncryptedOrgSettings> {
  const [
    primary_currency,
    secondary_currency,
    bitcoin_display,
    fiscal_year_type,
    encrypted_fiscal_month,
    date_format,
    time_format,
    number_format,
    encrypted_approval_threshold_amount,
    encrypted_approval_threshold_currency,
  ] = await Promise.all([
    encryptNullable(fields.primary_currency, encrypt),
    encryptNullable(fields.secondary_currency, encrypt),
    encryptNullable(fields.bitcoin_display, encrypt),
    encryptNullable(fields.fiscal_year_type, encrypt),
    encryptNumber(fields.fiscal_start_month, encrypt),
    encryptNullable(fields.date_format, encrypt),
    encryptNullable(fields.time_format, encrypt),
    encryptNullable(fields.number_format, encrypt),
    encryptNumber(fields.approval_threshold_amount ?? null, encrypt),
    encryptNullable(fields.approval_threshold_currency ?? null, encrypt),
  ]);
  return {
    primary_currency,
    secondary_currency,
    bitcoin_display,
    fiscal_year_type,
    encrypted_fiscal_month,
    fiscal_start_month: null,
    date_format,
    time_format,
    number_format,
    encrypted_approval_threshold_amount,
    encrypted_approval_threshold_currency,
    key_version: L2,
  };
}

export async function decryptOrgSettings(row: any, decrypt: DecryptFn): Promise<OrgSettingsFields> {
  const kv = row.key_version;
  if (!kv)
    return {
      primary_currency: row.primary_currency,
      secondary_currency: row.secondary_currency,
      bitcoin_display: row.bitcoin_display,
      fiscal_year_type: row.fiscal_year_type,
      fiscal_start_month: row.fiscal_start_month,
      date_format: row.date_format,
      time_format: row.time_format,
      number_format: row.number_format,
      timezone: row.timezone,
    };
  const isL2 = kv >= L2;
  const [
    primary_currency,
    secondary_currency,
    bitcoin_display,
    fiscal_year_type,
    fiscal_start_month,
    date_format,
    time_format,
    number_format,
    timezone,
    approval_threshold_amount,
    approval_threshold_currency,
  ] = await Promise.all([
    decryptNullable(row.primary_currency, decrypt, isL2 ? kv : null),
    decryptNullable(row.secondary_currency, decrypt, isL2 ? kv : null),
    decryptNullable(row.bitcoin_display, decrypt, isL2 ? kv : null),
    decryptNullable(row.fiscal_year_type, decrypt, isL2 ? kv : null),
    decryptNumber(row.encrypted_fiscal_month, decrypt, kv, row.fiscal_start_month),
    decryptNullable(row.date_format, decrypt, isL2 ? kv : null),
    decryptNullable(row.time_format, decrypt, isL2 ? kv : null),
    decryptNullable(row.number_format, decrypt, isL2 ? kv : null),
    decryptNullable(row.timezone, decrypt, isL2 ? kv : null),
    decryptNumber(row.encrypted_approval_threshold_amount, decrypt, kv, null),
    decryptNullable(row.encrypted_approval_threshold_currency, decrypt, isL2 ? kv : null),
  ]);
  return {
    primary_currency,
    secondary_currency,
    bitcoin_display,
    fiscal_year_type,
    fiscal_start_month,
    date_format,
    time_format,
    number_format,
    timezone,
    approval_threshold_amount: approval_threshold_amount ?? null,
    approval_threshold_currency: approval_threshold_currency ?? null,
  };
}

// ── Blind indexes ─────────────────────────────────────────────────────────────

/**
 * Compute a deterministic HMAC-SHA256 blind index for a plaintext value.
 *
 * The hmacKey must be derived via deriveV4Keys() from vault.ts, it is
 * separate from all AES-GCM encryption keys in the key hierarchy. Normalized
 * (trim + lowercase) before hashing so searches are case-insensitive.
 *
 * Returns null for absent or empty values, the DB column stays NULL and
 * WHERE hmac_col = $1 queries simply won't match those rows.
 */
export async function computeBlindIndex(
  value: string | null | undefined,
  hmacKey: CryptoKey,
): Promise<string | null> {
  if (value == null || value === '') return null;
  const normalized = value.trim().toLowerCase();
  const sig = await window.crypto.subtle.sign(
    'HMAC',
    hmacKey,
    new TextEncoder().encode(normalized),
  );
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
