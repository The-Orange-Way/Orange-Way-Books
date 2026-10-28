/**
 * Chart-of-accounts ids for journal entry lines.
 *
 * journal_entry_lines.account_id is NOT NULL and references
 * chart_of_accounts(id). A line written without it is refused with 23503
 * and nothing after it is saved. These helpers resolve the id a line needs
 * BEFORE anything is written, so a missing account stops the save with a
 * clear message instead of leaving a journal entry with no lines.
 *
 * Two ways a line names its account:
 *   - a wallet leg: wallets.external_account_id holds the chart_of_accounts
 *     id of the wallet's own account. Wallets created in the app before this
 *     change have none, so the helper creates an Asset account for the
 *     wallet and links it (one wallet, one account).
 *   - any other leg: by account name, matched against the decrypted chart.
 *
 * Relative imports only: the Orange Rails commit path imports this module
 * outside the app's path aliases.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { decryptChartOfAccount, encryptChartOfAccount } from '../crypto-fields';

type EncryptFn = (plaintext: string) => Promise<string>;
type DecryptFn = (ciphertext: string) => Promise<string>;

export class LineAccountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LineAccountError';
  }
}

export interface WalletRef {
  id: string;
  /** Plaintext wallet name, used only to name a newly created account. */
  name: string;
}

/**
 * Returns wallet id -> chart_of_accounts.id for every wallet given, creating
 * and linking an Asset account for a wallet that has none (or whose link
 * points at a row that no longer exists).
 */
export async function ensureWalletChartAccountIds(
  client: SupabaseClient,
  orgId: string,
  wallets: WalletRef[],
  encryptText: EncryptFn,
): Promise<Map<string, string>> {
  const ids = [...new Set(wallets.map((w) => w.id))];
  const result = new Map<string, string>();
  if (ids.length === 0) return result;

  const { data: walletRows, error: walletErr } = await client
    .from('wallets')
    .select('id, external_account_id')
    .eq('org_id', orgId)
    .in('id', ids);
  if (walletErr) throw walletErr;
  const linked = new Map<string, string | null>(
    ((walletRows as Array<{ id: string; external_account_id: string | null }>) ?? []).map((w) => [
      w.id,
      w.external_account_id,
    ]),
  );
  const missingWallet = ids.find((id) => !linked.has(id));
  if (missingWallet) {
    throw new LineAccountError('A wallet in this entry was not found in this organization.');
  }

  const chartIds = [...new Set([...linked.values()].filter((v): v is string => !!v))];
  const existing = new Set<string>();
  if (chartIds.length > 0) {
    const { data: chartRows, error: chartErr } = await client
      .from('chart_of_accounts')
      .select('id')
      .eq('org_id', orgId)
      .in('id', chartIds);
    if (chartErr) throw chartErr;
    for (const r of (chartRows as Array<{ id: string }>) ?? []) existing.add(r.id);
  }

  for (const w of wallets) {
    if (result.has(w.id)) continue;
    const link = linked.get(w.id);
    if (link && existing.has(link)) {
      result.set(w.id, link);
      continue;
    }
    const enc = await encryptChartOfAccount(
      {
        account_name: w.name.trim() || 'Wallet',
        account_code: null,
        account_type: 'ASSET',
        account_group: 'Assets',
        account_category: null,
        is_archived: false,
      },
      encryptText,
    );
    const { data: created, error: createErr } = await client
      .from('chart_of_accounts')
      .insert({ org_id: orgId, ...enc } as never)
      .select('id')
      .single();
    if (createErr) throw createErr;
    const chartId = (created as { id: string } | null)?.id;
    if (!chartId) throw new LineAccountError('Creating the account for a wallet returned no row.');
    const { error: linkErr } = await client
      .from('wallets')
      .update({ external_account_id: chartId } as never)
      .eq('id', w.id)
      .eq('org_id', orgId);
    if (linkErr) throw linkErr;
    result.set(w.id, chartId);
  }
  return result;
}

/** Normalised key for matching account names. */
export function accountNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export interface ChartNameIndex {
  /** name key -> chart_of_accounts.id, for names held by exactly one account. */
  byName: Map<string, string>;
  /** name keys held by more than one account. */
  ambiguous: Set<string>;
}

/** Builds a name index over the org's chart (archived accounts excluded). */
export async function loadChartNameIndex(
  client: SupabaseClient,
  orgId: string,
  decryptText: DecryptFn,
): Promise<ChartNameIndex> {
  const { data, error } = await client.from('chart_of_accounts').select('*').eq('org_id', orgId);
  if (error) throw error;
  const byName = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const row of (data as Array<Record<string, unknown>>) ?? []) {
    try {
      const fields = await decryptChartOfAccount(row as never, decryptText);
      if (fields.is_archived) continue;
      const key = accountNameKey(fields.account_name ?? '');
      if (!key) continue;
      if (byName.has(key)) ambiguous.add(key);
      else byName.set(key, row.id as string);
    } catch {
      // Undecryptable rows are never posted to.
    }
  }
  for (const key of ambiguous) byName.delete(key);
  return { byName, ambiguous };
}

/** Returns the chart id for an account name, or throws a message a user can act on. */
export function requireAccountIdByName(
  index: ChartNameIndex,
  name: string | null | undefined,
): string {
  const key = accountNameKey(name ?? '');
  if (!key) throw new LineAccountError('Every line needs an account.');
  if (index.ambiguous.has(key)) {
    throw new LineAccountError(
      `More than one account is named "${(name ?? '').trim()}". Rename one so each line posts to a single account.`,
    );
  }
  const id = index.byName.get(key);
  if (!id) {
    throw new LineAccountError(
      `Account "${(name ?? '').trim()}" is not in the chart of accounts. Add it first, then save again.`,
    );
  }
  return id;
}
