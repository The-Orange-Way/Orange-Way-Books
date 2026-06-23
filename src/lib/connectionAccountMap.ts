/**
 * connectionAccountMap, client helpers for the encrypted destination-account
 * routing table introduced in Phase 3.
 *
 * The server stores opaque identifiers (or_connection_id, or_external_wallet_id)
 * paired with an AES-256-GCM ciphertext over the OWB chart_of_accounts.id. The
 * client decrypts the ciphertext locally after vault unlock and uses the
 * recovered chart_of_accounts.id to look up the human-readable account name.
 *
 * ZKA invariants:
 *   - encrypted_account_id is ciphertext (vault MEK). Never exposed plaintext
 *     to the server.
 *   - or_connection_id + or_external_wallet_id are opaque to OWB (they live in
 *     OR's database). They appear in OWB only as routing keys; the server
 *     cannot turn them into a meaningful account-id without the MEK.
 */

import { supabase } from '@/lib/supabase';

export interface ConnectionAccountMapRow {
  id: string;
  org_id: string;
  or_connection_id: string;
  or_external_wallet_id: string;
  encrypted_account_id: string;
  encrypted_metadata_key_version: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  /** High-water mark of or_ts already imported for this mapping. NULL =
   *  no successful sync yet (caller should fetch all history). */
  last_or_synced_at: string | null;
}

/** A decrypted mapping row, ready for rendering. */
export interface DecryptedConnectionAccountMapping {
  id: string;
  or_connection_id: string;
  or_external_wallet_id: string;
  external_account_id: string;
  is_active: boolean;
  /** Forwarded from the row so the bridge can build a connection-wide
   *  cursor (min across mappings) for the OR `since` parameter. */
  last_or_synced_at: string | null;
}

/** Fetch all mapping rows for an org and decrypt them client-side. */
export async function fetchAndDecryptMappings(
  orgId: string,
  decryptText: (ciphertext: string) => Promise<string>,
): Promise<DecryptedConnectionAccountMapping[]> {
  const { data, error } = await supabase
    .from('connection_account_map' as never)
    .select('*')
    .eq('org_id', orgId);
  if (error) throw error;
  const rows = (data ?? []) as unknown as ConnectionAccountMapRow[];
  const decrypted = await Promise.all(
    rows.map(async (r): Promise<DecryptedConnectionAccountMapping | null> => {
      try {
        const external_account_id = await decryptText(r.encrypted_account_id);
        return {
          id: r.id,
          or_connection_id: r.or_connection_id,
          or_external_wallet_id: r.or_external_wallet_id,
          external_account_id,
          is_active: r.is_active,
          last_or_synced_at: r.last_or_synced_at ?? null,
        };
      } catch {
        // A mapping that fails to decrypt under the current vault key is most
        // likely from a previous vault generation (key rotation, re-keyed
        // org, etc.). Skip rather than hard-fail the routing UI.
        return null;
      }
    }),
  );
  return decrypted.filter((m): m is DecryptedConnectionAccountMapping => m !== null);
}

export interface SaveMappingsParams {
  orgId: string;
  orConnectionId: string;
  /** Plaintext desired mappings: which OR wallet routes to which legacy account. */
  desired: Array<{ or_external_wallet_id: string; external_account_id: string }>;
  encryptText: (plaintext: string) => Promise<string>;
}

/**
 * Replace the current mapping set for this connection with the desired set.
 *
 * Implementation: delete existing rows for (org_id, or_connection_id) then
 * insert the new ones. We do this with two simple statements rather than a
 * diff because mapping cardinality is small (typically 1–3 rows per
 * connection) and the unique index over encrypted_account_id makes incremental
 * upserts brittle when the user reassigns a wallet to a different account.
 *
 * Both operations are gated by RLS, the user must have connectors.write in
 * the org, and the rows must already belong to that org. There's no atomic
 * transaction here, but the worst-case interleaving (delete succeeds, insert
 * fails) leaves the connection unrouted, which falls back to the safe
 * "unrouted" badge in the UI; no incorrect routing can result.
 */
export async function saveMappingsForConnection({
  orgId,
  orConnectionId,
  desired,
  encryptText,
}: SaveMappingsParams): Promise<void> {
  const { error: delErr } = await supabase
    .from('connection_account_map' as never)
    .delete()
    .eq('org_id', orgId)
    .eq('or_connection_id', orConnectionId);
  if (delErr) throw delErr;

  if (desired.length === 0) return;

  const rows = await Promise.all(
    desired.map(async (d) => ({
      org_id: orgId,
      or_connection_id: orConnectionId,
      or_external_wallet_id: d.or_external_wallet_id,
      encrypted_account_id: await encryptText(d.external_account_id),
      encrypted_metadata_key_version: 1,
      is_active: true,
    })),
  );

  const { error: insErr } = await supabase
    .from('connection_account_map' as never)
    .insert(rows as never);
  if (insErr) throw insErr;
}

/**
 * Build a fast lookup map from (or_connection_id, or_external_wallet_id) →
 * external_account_id. Used by TransactionList to render the "Routed to" badge.
 */
export function buildMappingIndex(
  mappings: DecryptedConnectionAccountMapping[],
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const m of mappings) {
    if (!m.is_active) continue;
    const key = `${m.or_connection_id}::${m.or_external_wallet_id}`;
    const arr = index.get(key);
    if (arr) arr.push(m.external_account_id);
    else index.set(key, [m.external_account_id]);
  }
  return index;
}

export function lookupRouting(
  index: Map<string, string[]>,
  orConnectionId: string,
  orExternalWalletId: string | null | undefined,
): string[] {
  if (!orExternalWalletId) return [];
  return index.get(`${orConnectionId}::${orExternalWalletId}`) ?? [];
}
