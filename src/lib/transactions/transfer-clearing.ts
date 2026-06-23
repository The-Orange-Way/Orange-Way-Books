/**
 * Transfer Clearing, the system asset account every transfer journal
 * entry pivots through.
 *
 * Why the indirection: a cross-currency transfer (say 100 USD → 5,000 sats)
 * cannot be expressed as a single 2-line JE that balances, because the
 * units on the two sides are different currencies. Routing both legs
 * through an intermediate clearing account lets each currency stay in
 * its own balanced sub-entry while preserving the overall transfer
 * semantics. For same-currency transfers the clearing leg nets to zero
 * and is cosmetic, but the schema is the same either way.
 *
 * Lookup strategy: under OWB's encrypted chart-of-accounts, the
 * plaintext `account_code` and `account_name` columns are anonymized
 * placeholders, the real values live in `encrypted_*`. So this module
 * pulls all CoA rows for the org, decrypts their names client-side, and
 * matches by case-insensitive equality. Same shape as the
 * Uncategorized-Revenue / Uncategorized-Expense lookups in
 * `orImportBridge.ts`.
 *
 * Account code: a fixed `1500` slot inside the asset range. The two
 * waves of CoA renumber migrations (`./migrate-coa-renumber.ts`) free
 * the slot before this module ever tries to insert.
 *
 * Implemented in-house for OWB.
 */

import { supabase } from '@/lib/supabase';
import { decryptChartOfAccount, encryptChartOfAccount } from '@/lib/crypto-fields';
import { migrateCoaWave2, migrateEquipmentTransferClearingCodes } from './migrate-coa-renumber';

type EncryptFn = (plaintext: string) => Promise<string>;
type DecryptFn = (ciphertext: string) => Promise<string>;

export const TRANSFER_CLEARING_NAME = 'Transfer Clearing';
export const TRANSFER_CLEARING_CODE = '1500';

export interface TransferClearingAccount {
  /** chart_of_accounts.id (PK). */
  id: string;
  /** Placeholder external id carried for compat with downstream readers
   *  that still expect an external_account_id field on this shape. */
  external_account_id: string;
  /** Plaintext account name (decrypted). JE lines reference this string
   *  when they post the clearing legs. */
  account_name: string;
}

/**
 * Look up the org's Transfer Clearing row. Returns null if not found
 * (caller decides whether to throw or lazy-create).
 */
export async function findTransferClearingAccount(
  orgId: string,
  decryptText: DecryptFn,
): Promise<TransferClearingAccount | null> {
  const { data: rows, error } = await supabase
    .from('chart_of_accounts')
    .select('*')
    .eq('org_id', orgId);
  if (error) throw error;

  for (const row of (rows as any[]) ?? []) {
    try {
      const fields = await decryptChartOfAccount(row, decryptText);
      if (
        (fields.account_name || '').trim().toLowerCase() === TRANSFER_CLEARING_NAME.toLowerCase() &&
        !fields.is_archived
      ) {
        return {
          id: row.id,
          external_account_id: row.external_account_id,
          account_name: fields.account_name,
        };
      }
    } catch {
      // Undecryptable row (key mismatch), skip rather than throw.
    }
  }
  return null;
}

/**
 * Lazy-create the Transfer Clearing row if missing. Mirrors the
 * orImportBridge ensureUncategorizedAccounts pattern. Safe to call
 * repeatedly, the find step short-circuits when the row exists.
 *
 * Throws if the row cannot be located or created.
 */
export async function ensureTransferClearingAccount(
  orgId: string,
  encryptText: EncryptFn,
  decryptText: DecryptFn,
): Promise<TransferClearingAccount> {
  const existing = await findTransferClearingAccount(orgId, decryptText);
  if (existing) return existing;

  // Client-side CoA renumber + rename migrations. Idempotent: only do
  // work the first time per org. Wave 1 frees code 1500 (Equipment moves
  // to 1600) so the insert below lands at the canonical clearing slot
  // without colliding. Wave 2 brings the rest of the chart up to date
  // (Inventory 1300→1305, COGS 5100→5000, plus Equity/Income renames).
  // Order matters: Wave 1 first per the migration docstring. See
  // `migrate-coa-renumber.ts` for the ZKA rationale.
  try {
    await migrateEquipmentTransferClearingCodes(orgId, encryptText, decryptText);
  } catch (err) {
    // Non-fatal: if the migration trips on something unexpected we still
    // want the transfer write path to succeed. Log + continue. The 1500
    // insert below will throw a clear unique-constraint error if there's
    // a leftover Equipment row at 1500 in this org.
    console.warn('COA Wave 1 migration failed (continuing):', err);
  }
  try {
    await migrateCoaWave2(orgId, encryptText, decryptText);
  } catch (err) {
    // Non-fatal: Wave 2 is cosmetic for the transfer path. Surface the
    // error class so we can diagnose without leaking decrypted names.
    console.warn('COA Wave 2 migration failed (continuing):', err);
  }

  const legacyAccountId = crypto.randomUUID();
  const enc = await encryptChartOfAccount(
    {
      account_name: TRANSFER_CLEARING_NAME,
      account_code: TRANSFER_CLEARING_CODE,
      account_type: 'ASSET',
      account_group: 'Assets',
      account_category: null,
      is_archived: false,
    },
    encryptText,
  );
  const { data, error } = await supabase
    .from('chart_of_accounts')
    .insert({
      org_id: orgId,
      external_account_id: legacyAccountId,
      ...enc,
    } as any)
    .select('id')
    .single();
  if (error) throw error;
  if (!data) throw new Error('Transfer Clearing account insert returned no row.');
  return {
    id: (data as { id: string }).id,
    external_account_id: legacyAccountId,
    account_name: TRANSFER_CLEARING_NAME,
  };
}
