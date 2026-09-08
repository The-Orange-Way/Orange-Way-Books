/**
 * OWB Stealth Sync slice 4/4, part 2: fetch, decrypt and normalize a
 * private (stealth) connection's transactions so they can be handed to
 * the existing ledger importer (orImportBridge.importOrTransactionsToV3).
 *
 * WHY THIS IS A SEPARATE PATH FROM THE ORDINARY or-sync + TransactionList
 * FLOW. A stealth connection is never a row in the `connections` table
 * that `or-sync` reads from (see planSyncAll in ./sync-all.ts). Its
 * transactions are sealed under a DIFFERENT key: `cred_key`
 * (deriveOrCredsKeyFromMek, HKDF info orangerails-creds-v1), not
 * `transactions_key` (deriveOrTxnsKeyFromMek, orangerails-txns-v1).
 * OWM-T0109 shipped this exact defect once already: decrypting the
 * stealth path with the txns key, so every row failed its AES-GCM auth
 * tag and the failure counter was never surfaced. Do not "simplify" this
 * into one function that takes either key, and do not swap the key this
 * module uses without re-reading OWM-T0109 first.
 *
 * WIRE CONTRACT, VERIFIED against Orange Rails source 2026-09-06 by reading
 * supabase/functions/or-stealth-transactions-list/index.ts in the Orange
 * Rails repo directly: POST or-stealth-transactions-list via owb-or-proxy, body
 * { connection_id, app_user_id, limit?, before_block?,
 * before_txid_blind_index_hex? }. Response transactions carry
 * `sealed_record: { version: 1, algorithm: 'AES-256-GCM', iv_b64,
 * ciphertext_b64 }` unsealed with cred_key the same way as
 * stealth_connections.sealed_envelope. `occurred_at` and `block_height`
 * arrive as plaintext (ZKA Level 2 trade-off); everything else about the
 * transaction is inside sealed_record.
 *
 * ONE THING THIS FILE DOES NOT VERIFY, STATED PLAINLY SO IT IS NOT
 * MISTAKEN FOR SOMETHING THAT WAS CHECKED. The plaintext JSON schema
 * inside sealed_record is assumed identical to the ordinary path's
 * DecryptedOrTx (see TransactionList.tsx:
 * `JSON.parse(await decrypt(row.encrypted_payload)) as DecryptedTx`)
 * because both paths feed the same downstream importer and the decrypt
 * contract note describes one normalized transaction shape end to end.
 * That assumption is NOT independently confirmed against a live
 * or-stealth-transactions-list response in this change; there is no
 * stealth connection this build can create yet to produce one (see
 * OWB-T0030, still waiting: the "connect a Bitcoin wallet via Stealth
 * Sync" UI does not exist in Books today). Confirm it against a real
 * response before this path is wired to a button a customer can press.
 */

import type { DecryptedOrTx } from '../orImportBridge';

/** One sealed transaction row exactly as or-stealth-transactions-list returns it. */
export interface SealedStealthTxRow {
  id: string;
  sealed_record: {
    version: number;
    algorithm: string;
    iv_b64: string;
    ciphertext_b64: string;
  };
  occurred_at: string;
  block_height: number;
  txid_blind_index_hex: string;
  created_at: string;
}

export interface StealthCursor {
  before_block: number;
  before_txid_blind_index_hex: string;
}

export interface StealthTransactionsPage {
  connection_id: string;
  transactions: SealedStealthTxRow[];
  total: number;
  has_more: boolean;
  next_cursor: StealthCursor | null;
}

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * Unseal one sealed_record under cred_key.
 *
 * Refuses anything but the one algorithm and version this build
 * understands, rather than handing an unknown shape to WebCrypto and
 * letting whatever error it throws stand in for a clear one. A future
 * version bump on the OR side should show up here as a named refusal, not
 * a confusing decrypt failure three layers down.
 */
export async function decryptStealthRecord(
  sealed: SealedStealthTxRow['sealed_record'],
  credKey: CryptoKey,
): Promise<string> {
  if (sealed.version !== 1 || sealed.algorithm !== 'AES-256-GCM') {
    throw new Error(
      `Unsupported sealed_record shape: version ${sealed.version}, algorithm ${sealed.algorithm}`,
    );
  }
  const iv = base64ToBytes(sealed.iv_b64);
  const ciphertext = base64ToBytes(sealed.ciphertext_b64);
  const plaintext = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    credKey,
    ciphertext as BufferSource,
  );
  return new TextDecoder().decode(plaintext);
}

/**
 * Decrypt one row to the normalized transaction shape, or a captured
 * per-row error. Never throws: a wrong key, a tampered envelope, or a
 * malformed plaintext must not abort a whole page of otherwise-good rows.
 */
export async function decryptStealthTx(
  row: SealedStealthTxRow,
  credKey: CryptoKey,
): Promise<{ tx: DecryptedOrTx | null; error: string | null }> {
  try {
    const json = await decryptStealthRecord(row.sealed_record, credKey);
    const tx = JSON.parse(json) as DecryptedOrTx;
    return { tx, error: null };
  } catch (err) {
    return { tx: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Decrypt a page of stealth rows, same all-rows-attempted contract as the
 * ordinary TransactionList decrypt loop: one bad row is reported, not
 * fatal to the rest.
 */
export async function decryptStealthPage(
  page: StealthTransactionsPage,
  credKey: CryptoKey,
): Promise<{ ok: DecryptedOrTx[]; failed: Array<{ id: string; error: string }> }> {
  const ok: DecryptedOrTx[] = [];
  const failed: Array<{ id: string; error: string }> = [];
  for (const row of page.transactions) {
    const { tx, error } = await decryptStealthTx(row, credKey);
    if (tx) ok.push(tx);
    else failed.push({ id: row.id, error: error ?? 'unknown decrypt failure' });
  }
  return { ok, failed };
}

/** What the caller (Connections.tsx) supplies to actually reach the network. */
export type StealthPageFetcher = (args: {
  connection_id: string;
  limit?: number;
  before_block?: number;
  before_txid_blind_index_hex?: string;
}) => Promise<StealthTransactionsPage>;

/**
 * Page through every stealth transaction for one connection.
 *
 * The caller supplies the actual network call (a callProxy('or-stealth-
 * transactions-list', ...) closure in Connections.tsx) so this stays
 * testable without a network, a proxy, or a signed-in session.
 *
 * maxPages is a hard stop against a server that never sets has_more to
 * false or a next_cursor that never advances; this must never spin
 * forever in a customer's browser tab.
 */
export async function fetchAllStealthTransactions(
  connectionId: string,
  fetchPage: StealthPageFetcher,
  maxPages = 100,
): Promise<SealedStealthTxRow[]> {
  const all: SealedStealthTxRow[] = [];
  let cursor: StealthCursor | null = null;
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage({
      connection_id: connectionId,
      limit: 100,
      before_block: cursor?.before_block,
      before_txid_blind_index_hex: cursor?.before_txid_blind_index_hex,
    });
    all.push(...res.transactions);
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return all;
}
