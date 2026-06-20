/**
 * Backfill dual-currency amounts for pre-dual journal_entry_lines.
 *
 * Iterates rows where dual_amounts_backfilled=false, decrypts each row,
 * resolves the exchange rate for its date, encrypts the new dual fields,
 * and writes them back. Always marks dual_amounts_backfilled=true so the
 * row is never revisited, even if the rate is still pending.
 *
 * ZKA note: encryption/decryption happen entirely in the browser. The
 * server only ever sees ciphertext. Rate fetching sends {pair, date}
 * metadata — same L2 privacy baseline as existing plaintext dates.
 */

import { supabase } from '@/lib/supabase';
import { decryptJournalEntryLine, encryptJournalEntryLine } from '@/lib/crypto-fields';
import { resolvePinnedRate } from './rate-resolver';

type EncryptFn = (plaintext: string) => Promise<string>;
type DecryptFn = (ciphertext: string) => Promise<string>;

const PAGE_SIZE = 500;
const STORAGE_KEY = 'owb_backfill_progress';

export interface BackfillProgress {
  processed: number;
  resolved: number;
  pending: number;
  failed: number;
  lastCursor: string | null; // last processed row id for resumability
}

export function loadBackfillProgress(): BackfillProgress {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) return JSON.parse(stored);
  } catch {
    /* ignore */
  }
  return { processed: 0, resolved: 0, pending: 0, failed: 0, lastCursor: null };
}

function saveBackfillProgress(p: BackfillProgress): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

export function clearBackfillProgress(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export interface BackfillCallbacks {
  onProgress: (p: BackfillProgress) => void;
  onDone: (p: BackfillProgress) => void;
  signal?: AbortSignal;
}

/**
 * Run one full backfill pass for an org.
 *
 * @param orgId         - Org scope
 * @param primaryCurrency - Current primary currency (used when wallet_currency is unknown)
 * @param encrypt       - VaultContext encryptText
 * @param decrypt       - VaultContext decryptText
 * @param callbacks     - Progress reporting
 */
export async function backfillDualAmounts(
  orgId: string,
  primaryCurrency: string,
  encrypt: EncryptFn,
  decrypt: DecryptFn,
  callbacks: BackfillCallbacks,
): Promise<BackfillProgress> {
  const progress = loadBackfillProgress();
  let cursor = progress.lastCursor;

  while (true) {
    if (callbacks.signal?.aborted) break;

    // Fetch next page of unbackfilled rows with JE date for rate resolution
    // Cast to any: post-Phase 1 schema has encrypted_primary_currency_at_posting
    // which the auto-generated types.ts won't know about until regenerated
    // after DB reset.
    let query = (supabase as any)
      .from('journal_entry_lines')
      .select(
        'id, key_version, account_id, journal_entry_id, encrypted_debit, encrypted_credit, encrypted_book_value, account_name, account_code, description, encrypted_amount_native, encrypted_wallet_currency, encrypted_primary_currency_at_posting, rate_pending, journal_entries!inner(date, org_id)',
      )
      .eq('dual_amounts_backfilled', false)
      .eq('journal_entries.org_id', orgId)
      .order('id', { ascending: true })
      .limit(PAGE_SIZE);

    if (cursor) {
      query = query.gt('id', cursor);
    }

    const { data: rows, error } = await query;
    if (error || !rows || rows.length === 0) break;

    // Process each row
    const updates: Array<{
      id: string;
      encrypted_amount_native: string | null;
      encrypted_amount_primary: string | null;
      encrypted_posted_rate: string | null;
      encrypted_wallet_currency: string | null;
      encrypted_primary_currency_at_posting: string | null;
      rate_pending: boolean;
      rate_asof: string | null;
      pinned_rate_id: string | null;
      dual_amounts_backfilled: boolean;
    }> = [];

    for (const row of rows) {
      if (callbacks.signal?.aborted) break;

      try {
        const jeDate: string = (row.journal_entries as any)?.date ?? '';
        const fields = await decryptJournalEntryLine(row, decrypt);

        // Wallet currency: prefer decrypted field; fall back to primary (identity rate)
        const walletCurrency = fields.wallet_currency ?? primaryCurrency;
        const targetCurrency =
          (row as any).encrypted_primary_currency_at_posting ?? primaryCurrency;

        // Signed native amount from debit/credit
        const amount_native = fields.debit > 0 ? fields.debit : -fields.credit;

        let rate = 0;
        let rateId: string | null = null;
        let rateBucketTs: string | null = null;
        let pending = false;

        try {
          const resolved = await resolvePinnedRate({
            source: walletCurrency,
            target: targetCurrency,
            at: jeDate,
          });
          rate = resolved.rate;
          rateId = resolved.rateId;
          rateBucketTs = resolved.bucketTs;
          pending = resolved.pending;
        } catch {
          pending = true;
        }

        const amount_primary = pending ? null : amount_native * rate;

        // Re-encrypt with dual amounts
        const encrypted = await encryptJournalEntryLine(
          {
            ...fields,
            amount_native,
            amount_primary,
            posted_rate: pending ? null : rate,
            wallet_currency: walletCurrency,
          },
          encrypt,
          {
            // meta-input key stays plaintext-named (encryptJournalEntryLine
            // internally encrypts it into encrypted_primary_currency_at_posting)
            primary_currency_at_posting: targetCurrency,
            rate_pending: pending,
            rate_asof: rateBucketTs,
            pinned_rate_id: rateId,
          },
        );

        updates.push({
          id: row.id,
          encrypted_amount_native: encrypted.encrypted_amount_native,
          encrypted_amount_primary: encrypted.encrypted_amount_primary,
          encrypted_posted_rate: encrypted.encrypted_posted_rate,
          encrypted_wallet_currency: encrypted.encrypted_wallet_currency,
          encrypted_primary_currency_at_posting: encrypted.encrypted_primary_currency_at_posting,
          rate_pending: encrypted.rate_pending,
          rate_asof: encrypted.rate_asof,
          pinned_rate_id: encrypted.pinned_rate_id,
          dual_amounts_backfilled: true,
        });

        if (pending) progress.pending++;
        else progress.resolved++;
      } catch {
        // Mark as backfilled to avoid infinite retry; rate_pending stays false
        updates.push({
          id: row.id,
          encrypted_amount_native: null,
          encrypted_amount_primary: null,
          encrypted_posted_rate: null,
          encrypted_wallet_currency: null,
          encrypted_primary_currency_at_posting: null,
          rate_pending: false,
          rate_asof: null,
          pinned_rate_id: null,
          dual_amounts_backfilled: true,
        });
        progress.failed++;
      }

      progress.processed++;
    }

    // Batch upsert updates
    if (updates.length > 0) {
      await supabase.from('journal_entry_lines').upsert(updates as any, { onConflict: 'id' });
    }

    cursor = rows[rows.length - 1].id;
    progress.lastCursor = cursor;
    saveBackfillProgress(progress);
    callbacks.onProgress({ ...progress });

    // Stop if we got fewer rows than the page size (last page)
    if (rows.length < PAGE_SIZE) break;
  }

  clearBackfillProgress();
  callbacks.onDone({ ...progress });
  return progress;
}
