/**
 * Orange Way Books takeout file format.
 *
 * ZKA note: plaintext mode decrypts rows client-side before writing to disk.
 * Import re-encrypts under the current vault before insert, so the server
 * never sees plaintext. The file itself IS plaintext, treat like a secret.
 */

export const TAKEOUT_VERSION = 1;
export type TakeoutEncryption = 'none' | 'aes-gcm-pbkdf2-v1';

export interface TakeoutMeta {
  readonly version: number;
  readonly exportedAt: string;
  readonly encryption: TakeoutEncryption;
  readonly sourceOrgName: string;
  readonly sourceOrgId: string;
  readonly tables: readonly string[];
}

/** All fields are plaintext when encryption === 'none'. */
export interface TakeoutFile {
  readonly _meta: TakeoutMeta;
  readonly data: TakeoutData;
}

export interface TakeoutData {
  readonly organizations: readonly TakeoutOrg[];
  readonly org_settings: readonly TakeoutOrgSettings[];
  readonly wallets: readonly TakeoutWallet[];
  readonly chart_of_accounts: readonly TakeoutLegacyAccount[];
  readonly contacts: readonly TakeoutContact[];
  readonly transactions: readonly TakeoutTransaction[];
  readonly journal_entries: readonly TakeoutJournalEntry[];
  readonly journal_entry_lines: readonly TakeoutJournalEntryLine[];
  readonly payment_requests: readonly TakeoutPaymentRequest[];
  readonly attachments: readonly TakeoutAttachment[];
}

export interface TakeoutOrg {
  readonly id: string;
  readonly name: string;
  readonly external_journal_id?: string | null;
}

export interface TakeoutOrgSettings {
  readonly bitcoin_display: string | null;
  readonly primary_currency: string | null;
  readonly secondary_currency: string | null;
}

export interface TakeoutWallet {
  readonly id: string;
  readonly name: string;
  readonly asset: string;
  readonly account_type: string | null;
  readonly initial_balance: number;
  readonly legacy_account_id: string | null;
  readonly connection_type?: string | null;
  readonly legacy_account_code?: string | null;
}

export interface TakeoutLegacyAccount {
  readonly id: string;
  readonly legacy_account_id: string;
  readonly account_name: string;
  readonly account_code: string | null;
  readonly account_type: string;
  readonly account_group: string;
  readonly account_category: string | null;
  readonly is_archived?: boolean;
  readonly parent_legacy_account_id?: string | null;
  /** Optional, if absent, inferred from account_type on import. */
  readonly normal_balance?: 'DEBIT' | 'CREDIT' | null;
}

export interface TakeoutAttachment {
  readonly id: string;
  readonly entity_type: 'transaction' | 'payment_request';
  readonly entity_id: string;
  readonly file_name: string;
  readonly file_size: number;
  readonly mime_type: string | null;
  /** Decrypted file bytes, base64-encoded. Empty string if download failed. */
  readonly content_base64: string;
}

export interface TakeoutContact {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly type: string | null;
  readonly street: string | null;
  readonly city: string | null;
  readonly state: string | null;
  readonly zip: string | null;
  readonly country: string | null;
}

export interface TakeoutTransaction {
  readonly id: string;
  readonly account_id: string | null;
  readonly date: string;
  readonly type: string;
  readonly asset: string;
  readonly amount: number;
  readonly usd_value: number | null;
  readonly exchange_rate: number | null;
  readonly memo: string | null;
  readonly status: string | null;
  readonly cleared_status: string | null;
}

export interface TakeoutJournalEntry {
  readonly id: string;
  readonly date: string;
  readonly memo: string | null;
  readonly ref_number: string | null;
  readonly currency: string;
  readonly exchange_rate: number | null;
  readonly status: string;
  readonly source_type: string | null;
  readonly period_locked: boolean;
}

export interface TakeoutJournalEntryLine {
  readonly id: string;
  readonly journal_entry_id: string;
  readonly account_id: string | null; // chart_of_accounts.id
  readonly account_name: string | null;
  readonly account_code: string | null;
  readonly debit: number;
  readonly credit: number;
  readonly description: string | null;
  // Dual-currency fields. Optional for backward compatibility with pre-dual
  // takeout files; when present, import marks the line dual_amounts_backfilled=true.
  readonly amount_native?: number | null;
  readonly amount_primary?: number | null;
  readonly posted_rate?: number | null;
  readonly wallet_currency?: string | null;
  readonly primary_currency_at_posting?: string | null;
}

export interface TakeoutPaymentRequest {
  readonly id: string;
  readonly payee: string | null;
  readonly description: string | null;
  readonly rejection_reason: string | null;
  readonly amount: number;
  readonly currency: string;
  readonly status: string;
  readonly request_type: string;
  readonly vendor_ref: string | null;
  readonly payment_address: string | null;
  // Lifecycle timestamps, plaintext on the server (same privacy
  // baseline as JE `date`). Optional for backward compatibility with
  // pre-lifecycle takeout files.
  readonly document_date?: string | null;
  readonly due_date?: string | null;
  readonly paid_at?: string | null;
}

export interface TakeoutTransactionExtra {
  readonly exchange_rate: number | null;
}
