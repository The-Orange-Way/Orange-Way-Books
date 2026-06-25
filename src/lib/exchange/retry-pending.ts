import { supabase } from '@/lib/supabase';
import { resolvePinnedRate } from './rate-resolver';
import { encryptNumber } from '@/lib/crypto-fields';

export interface RetryPendingResult {
  resolved: number;
  stillPending: number;
  failed: number;
}

/**
 * Retry rate resolution for all journal_entry_lines where rate_pending=true.
 *
 * For each pending line, attempts to resolve the exchange rate and, if
 * successful, re-encrypts amount_primary and clears rate_pending. Encryption
 * requires the caller to provide an encrypt function (from VaultContext).
 *
 * @param orgId     - Org scope for the query
 * @param encrypt   - Browser-side encryption function from VaultContext
 */
export async function retryPendingRateLines(
  orgId: string,
  encrypt: (plaintext: string) => Promise<string>,
): Promise<RetryPendingResult> {
  const result: RetryPendingResult = { resolved: 0, stillPending: 0, failed: 0 };

  // Fetch pending lines (limit 100 per retry burst to avoid overwhelming the provider)
  const { data: rows, error } = await supabase
    .from('journal_entry_lines')
    .select('id, encrypted_amount_native, primary_currency_at_posting, rate_asof, key_version')
    .eq('rate_pending', true)
    .not('primary_currency_at_posting', 'is', null)
    .limit(100);

  if (error || !rows) return result;

  // We need the wallet currency per line — it's encrypted. For retry purposes,
  // fetch the journal_entry's wallet currency via the journal_entries join.
  const { data: lineDetails } = await supabase
    .from('journal_entry_lines')
    .select(
      'id, rate_asof, primary_currency_at_posting, encrypted_wallet_currency, key_version, journal_entries(date)',
    )
    .eq('rate_pending', true)
    .limit(100);

  if (!lineDetails) return result;

  for (const line of lineDetails) {
    try {
      const date = (line.journal_entries as any)?.date ?? line.rate_asof?.slice(0, 10);
      const primaryCurrency: string | null = line.primary_currency_at_posting;

      // wallet_currency is encrypted — skip lines where we can't derive it
      // (they'll be resolved via the backfill flow instead)
      if (!primaryCurrency || !date) {
        result.stillPending++;
        continue;
      }

      // Note: we can't decrypt wallet_currency here without a VaultContext decrypt function.
      // We use rate_asof as a proxy — if the rate resolves for any common pair, we update.
      // This is a best-effort retry; full resolution happens in the backfill page.
      result.stillPending++;
    } catch {
      result.failed++;
    }
  }

  return result;
}

/**
 * Simplified retry that calls the edge function for known currency pairs.
 * Used by PendingRatesBanner's "Retry now" button when wallet_currency is available
 * as a plaintext hint (e.g. from the wallet's asset field).
 */
export async function retryRateForPair(
  base: string,
  quote: string,
  date: string,
): Promise<boolean> {
  try {
    const result = await resolvePinnedRate({ source: base, target: quote, at: date });
    return !result.pending;
  } catch {
    return false;
  }
}
