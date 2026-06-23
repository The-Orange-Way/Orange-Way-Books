/**
 * Invite wrap pipeline.
 *
 * Orchestrates the client-side crypto for a real, per-recipient hybrid
 * KEM wrap of the org DEK when an Owner invites a new member. Sits on
 * top of the Phase 4.0 primitives in `key-wrapping.ts` and the Phase 4.1
 * `user_vault_keys` table.
 *
 * ── Flow ────────────────────────────────────────────────────────────
 *
 *   1. Owner's Admin UI collects email + role. Before calling the
 *      invite-org-member edge function:
 *        a. `lookupRecipientPublicKey` queries `user_vault_keys` by
 *           recipient user id. RLS (see 20260424000000_phase4_3_invites.sql)
 *           permits the inviter to read public keys of members they
 *           could invite.
 *        b. If the recipient has a public key -> `wrapOrgDekForRecipient`
 *           produces a ready-to-store payload. The edge function inserts
 *           the row into `org_keys`.
 *        c. If the recipient has no public key yet -> the edge function
 *           records a `pending_invites` row. When the recipient later
 *           publishes their keypair, the DB trigger flips the row to
 *           `ready_to_wrap`; the Owner's client subscribes via realtime
 *           and eventually loops back through (a)/(b).
 *
 *   2. The org DEK handed in by the caller is opaque to this module.
 *      Today the caller supplies a placeholder 32-byte slot
 *     , real shared-DEK establishment is Phase 4.5 hard re-key. The
 *      wrap pipeline is therefore exercised end-to-end now so the 4.5
 *      migration can swap the payload without disturbing the invite UX.
 *
 * ── Non-goals ──────────────────────────────────────────────────────
 *
 *   * No signing key (ML-DSA-65) yet, that is Phase 4.4.
 *   * No hard re-key, that is Phase 4.5.
 *   * No recipient-side unwrap helper here, the recipient's
 *      VaultContext will read `org_keys.wrapped_dek` alongside their
 *      own hybrid secret key (Phase 4.5+). For 4.3 we only need the
 *      wrap side.
 */

import { KEY_WRAP_STRATEGIES, DEFAULT_WRAP_ALGORITHM, base64ToBytes } from '@/lib/key-wrapping';

// Lazy-load the supabase client to keep this module importable in
// pure-node test environments that haven't set up `localStorage` (the
// supabase client constructor reads it at load time). The test suite
// only exercises the pure-crypto helpers below; the lookup function is
// covered by integration tests through the edge functions.
type SupabaseLike = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (
        col: string,
        val: string,
      ) => {
        maybeSingle: () => Promise<{ data: unknown; error: { message: string } | null }>;
      };
    };
  };
};
async function getSupabase(): Promise<SupabaseLike> {
  const mod = await import('@/lib/supabase');
  return mod.supabase as unknown as SupabaseLike;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Wrap payload produced by `wrapOrgDekForRecipient`. Shape matches the
 * POST body expected by `invite-org-member` and `complete-invite-wrap`.
 */
export interface OrgDekWrapPayload {
  /** Base64 of the opaque wrapped blob (KEM ciphertext | IV | AES-GCM ct). */
  wrapped_dek: string;
  /** Base64 of the AES-GCM IV, pulled out of the blob for audit tooling.
   *  The blob is self-contained; this field is a convenience duplicate
   *  matching the existing org_keys.iv column. */
  iv: string;
  /** Strategy identifier (e.g. 'hybrid-x25519-mlkem768'). */
  wrap_algo: string;
}

/**
 * Result shape for `lookupRecipientPublicKey`. Null `publicKeyB64` means
 * the recipient has not yet published a keypair, the caller should
 * route the invite through the `pending_invites` path.
 */
export interface RecipientKeyLookupResult {
  publicKeyB64: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/**
 * Generate a random 32-byte placeholder org DEK. Used today so every
 * invite wrap exercises real hybrid-KEM crypto against real recipient
 * public keys. Phase 4.5 hard re-key replaces the placeholder with a
 * genuine shared DEK that decrypts business data.
 */
export function generatePlaceholderOrgDek(): Uint8Array {
  const dek = new Uint8Array(32);
  crypto.getRandomValues(dek);
  return dek;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a recipient's hybrid public key from user_vault_keys. Returns
 * null when the recipient does not yet have a keypair published, the
 * caller should fall back to the pending_invites path.
 *
 * RLS (policy `user_vault_keys_select_for_inviters`) lets any caller
 * holding `users.invite` in an org read the public keys of existing
 * members or pending invitees for that org. `public_key_b64` is public
 * by cryptographic design; exposing it is safe.
 */
export async function lookupRecipientPublicKey(
  recipientUserId: string,
): Promise<RecipientKeyLookupResult> {
  const supabase = await getSupabase();
  const { data, error } = await supabase
    .from('user_vault_keys')
    .select('public_key_b64')
    .eq('user_id', recipientUserId)
    .maybeSingle();

  // A PostgREST error here (RLS denial, missing table) is genuine
  // surface it rather than silently falling back to "no key", which
  // would misleadingly route the Owner into the pending-invite path.
  if (error) {
    throw new Error(`lookupRecipientPublicKey failed: ${error.message}`);
  }

  const publicKeyB64 = (data as { public_key_b64?: string } | null)?.public_key_b64;
  return { publicKeyB64: publicKeyB64 ?? null };
}

/**
 * Wrap an org DEK for a single recipient using the hybrid KEM strategy.
 * Output is a JSON-ready payload suitable for either the invite-org-member
 * or complete-invite-wrap edge functions to persist to `org_keys`.
 *
 * The recipient's public key is base64-encoded (as stored in
 * user_vault_keys.public_key_b64). We validate it decodes cleanly
 * before calling into the strategy, a truncated or malformed key
 * would otherwise surface as a confusing byte-length error from
 * key-wrapping.ts.
 */
export async function wrapOrgDekForRecipient(
  orgDek: Uint8Array,
  recipientPublicKeyB64: string,
  algorithm: string = DEFAULT_WRAP_ALGORITHM,
): Promise<OrgDekWrapPayload> {
  if (orgDek.length !== 32) {
    throw new Error(`orgDek must be 32 bytes, got ${orgDek.length}`);
  }

  const strategy = KEY_WRAP_STRATEGIES[algorithm];
  if (!strategy) {
    throw new Error(`unknown wrap strategy: ${algorithm}`);
  }

  let recipientPublicKey: Uint8Array;
  try {
    recipientPublicKey = base64ToBytes(recipientPublicKeyB64);
  } catch (err) {
    throw new Error(
      `recipient public key is not valid base64: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const wrapped = await strategy.wrapForRecipient(orgDek, recipientPublicKey);

  // The hybrid blob layout is `kemCt | iv[12] | ciphertext+tag`. The
  // IV lives at bytes [HYBRID_KEM_CIPHERTEXT_BYTES .. +12]. Rather than
  // hard-code the offset here (and risk drift if the strategy format
  // changes), we look up the per-strategy ciphertext size via the
  // blob's total length. All existing strategies place the 12-byte IV
  // directly after the KEM ciphertext, so the length math is:
  //   ivOffset = wrapped.length - 12 - 32 - 16   (blob - iv - data - tag)
  // That is, iv starts at the position that leaves room for the
  // 32-byte data key plus the 16-byte GCM tag after it.
  const AES_GCM_IV_BYTES = 12;
  const DATA_KEY_BYTES = 32;
  const AES_GCM_TAG_BYTES = 16;
  const ivOffset = wrapped.length - AES_GCM_IV_BYTES - DATA_KEY_BYTES - AES_GCM_TAG_BYTES;
  if (ivOffset < 0) {
    throw new Error(`wrapped blob too short to contain IV: ${wrapped.length} bytes`);
  }
  const iv = wrapped.subarray(ivOffset, ivOffset + AES_GCM_IV_BYTES);

  return {
    wrapped_dek: bytesToBase64(wrapped),
    iv: bytesToBase64(iv),
    wrap_algo: strategy.algorithm,
  };
}

/**
 * End-to-end convenience used by Admin.tsx: look up the recipient's
 * public key and wrap the provided org DEK for them. Returns null if
 * the recipient has no public key yet, the caller should then route
 * to the pending_invites path.
 */
export async function wrapForRecipientByUserId(
  orgDek: Uint8Array,
  recipientUserId: string,
): Promise<OrgDekWrapPayload | null> {
  const { publicKeyB64 } = await lookupRecipientPublicKey(recipientUserId);
  if (!publicKeyB64) return null;
  return wrapOrgDekForRecipient(orgDek, publicKeyB64);
}
