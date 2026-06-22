/**
 * Vault keypair lifecycle — Phase 4.1.
 *
 * Glue between the Phase 4.0 crypto primitives (`pqc.ts`, `key-derivation.ts`)
 * and the `user_vault_keys` table (Phase 4.1 migration). Produces the
 * single-row shape documented
 * in `OWB-USER-MANAGEMENT-ZKA.md` §14:
 *
 *   - public_key_b64        = base64(X25519_pub ‖ ML-KEM-768_pub)
 *   - encrypted_private_key = AES-256-GCM ciphertext of the hybrid
 *                             secret key (IV-prefixed, base64)
 *   - iv                    = base64(12-byte IV) — duplicated as a
 *                             column for convenience; also embedded
 *                             at the head of encrypted_private_key
 *                             (matches the encryptText wire format)
 *
 * The ML-DSA-65 signing half is *not* generated here — the Phase 4
 * design places the Org Signing Key behind the Auditor / writer
 * split, which arrives in Phase 4.4. This module is deliberately
 * narrow.
 *
 * Functions:
 *
 *   - `ensureUserKeypair(opts)` — idempotent upsert on first unlock.
 *     Generates + wraps + INSERTs only if the row is missing. Safe to
 *     call every unlock.
 *   - `rewrapUserKeypair(opts)` — atomic re-wrap on password change.
 *     Uses a single UPDATE (never DELETE + INSERT, Decision D5). The
 *     hybrid private key material is unchanged; only the wrap changes.
 *
 * Both functions accept a narrow Supabase surface (`SupabaseKeypairClient`)
 * so the unit test can drive them with an in-memory stub without
 * importing the full generated schema types.
 */

import { encryptString, decryptString, importAesKeyNonExtractable } from './vault';
import { derivePqcSecretWrapKey } from './key-derivation';
import { generateHybridKemKeyPair } from './pqc';

// ---------------------------------------------------------------------------
// Local base64 helpers — kept small and private.
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Narrow Supabase surface. We need:
//   - SELECT `public_key_b64, encrypted_private_key, iv` for a user
//   - INSERT one row
//   - UPDATE one row (atomic re-wrap)
// ---------------------------------------------------------------------------

export interface UserVaultKeysRow {
  public_key_b64: string;
  encrypted_private_key: string;
  iv: string;
  key_algorithm: string;
}

export interface SupabaseKeypairClient {
  from(table: 'user_vault_keys'): {
    select(columns: string): {
      eq(
        column: 'user_id',
        value: string,
      ): {
        maybeSingle(): Promise<{
          data: Partial<UserVaultKeysRow> | null;
          error: unknown;
        }>;
      };
    };
    insert(values: Record<string, unknown>): Promise<{ error: unknown }>;
    update(values: Record<string, unknown>): {
      eq(column: 'user_id', value: string): Promise<{ error: unknown }>;
    };
  };
}

// ---------------------------------------------------------------------------
// Shared internals.
// ---------------------------------------------------------------------------

/**
 * Extract the 12-byte IV stored at the head of an encryptText payload.
 *
 * The wire format is `base64(iv[12] | ciphertext | tag[16])` (see
 * `src/lib/vault.ts`). Splitting the IV back out lets us populate the
 * `iv` column on `user_vault_keys` as documented in §14, even though
 * the ciphertext alone is sufficient to unwrap. The duplicated column
 * keeps server-side tooling (backups, audit exports) able to identify
 * the IV without parsing base64.
 */
function extractIvFromEncryptedString(b64: string): string {
  const combined = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  if (combined.length < 12) {
    throw new Error('user_vault_keys: encrypted blob too short to contain IV');
  }
  const iv = combined.subarray(0, 12);
  return bytesToBase64(iv);
}

/**
 * Derive the wrap key + produce the three-field row payload from a
 * freshly-generated keypair. Extracted so `ensureUserKeypair` and the
 * future 4.3 invite flow can share the same encoding logic.
 */
async function buildUserVaultKeysRow(mek: CryptoKey, saltB64: string): Promise<UserVaultKeysRow> {
  const wrapKey = await derivePqcSecretWrapKey(mek, saltB64);
  const kem = generateHybridKemKeyPair();

  // Wrap the hybrid secret key with the MEK-derived subkey. encryptString
  // is AES-256-GCM with a fresh random IV — same wire format used for
  // every other vault ciphertext in this repo.
  const encrypted_private_key = await encryptString(bytesToBase64(kem.secretKey), wrapKey);

  return {
    public_key_b64: bytesToBase64(kem.publicKey),
    encrypted_private_key,
    iv: extractIvFromEncryptedString(encrypted_private_key),
    key_algorithm: 'x25519-mlkem768-v1',
  };
}

// ---------------------------------------------------------------------------
// ensureUserKeypair — first-unlock generate + publish.
// ---------------------------------------------------------------------------

export interface EnsureUserKeypairArgs {
  userId: string;
  mek: CryptoKey;
  /** Base64 of the per-org vault salt (same salt passed to HKDF). */
  saltB64: string;
  supabase: SupabaseKeypairClient;
}

export type EnsureUserKeypairResult =
  | { generated: false }
  | { generated: true; publicKeyB64: string };

/**
 * If the calling user does not yet have a row in `user_vault_keys`,
 * generate a hybrid keypair, MEK-wrap the private key, and INSERT the
 * single row. If the row already exists, this is a no-op.
 *
 * Non-blocking contract: the calling VaultContext should `void`-swallow
 * rejections. A transient Supabase failure must not prevent the user
 * from using the app — we'll retry next unlock. Phase 4.3 pulls a
 * missing keypair into the invite path's pending-wrap notification.
 */
export async function ensureUserKeypair(
  args: EnsureUserKeypairArgs,
): Promise<EnsureUserKeypairResult> {
  const { userId, mek, saltB64, supabase } = args;

  const existing = await supabase
    .from('user_vault_keys')
    .select('public_key_b64')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing.error) {
    throw existing.error;
  }
  if (existing.data?.public_key_b64) {
    return { generated: false };
  }

  const row = await buildUserVaultKeysRow(mek, saltB64);

  const insert = await supabase
    .from('user_vault_keys')
    .insert({ user_id: userId, ...row } as unknown as Record<string, unknown>);

  if (insert.error) {
    throw insert.error;
  }

  return { generated: true, publicKeyB64: row.public_key_b64 };
}

// ---------------------------------------------------------------------------
// rewrapUserKeypair — atomic UPDATE on password change (Decision D5).
// ---------------------------------------------------------------------------

export interface RewrapUserKeypairArgs {
  userId: string;
  /** MEK currently wrapping the private key (used to unwrap). */
  oldMek: CryptoKey;
  /** MEK that will wrap the private key after re-wrap. */
  newMek: CryptoKey;
  saltB64: string;
  supabase: SupabaseKeypairClient;
}

export type RewrapUserKeypairResult = { rewrapped: false; reason: 'no-row' } | { rewrapped: true };

/**
 * Re-wrap the user's hybrid private key with a new MEK. Used by the
 * password-change flow so the Org DEK wraps do not have to rotate
 * (Decision D5). The hybrid secret bytes are unchanged — only the
 * wrapping cipher changes.
 *
 * Atomicity guardrail: this function MUST NOT DELETE the existing row
 * and INSERT a replacement. Leaving old ciphertext around (even briefly)
 * means an attacker with the old MEK can continue to decrypt the old
 * private-key wrap. The unit test in `vault-keypair.test.ts` asserts
 * that (a) `UPDATE` is called, (b) `DELETE` is never called, and
 * (c) `count(*)` stays at 1.
 *
 * Returns `{ rewrapped: false, reason: 'no-row' }` if the user has no
 * keypair yet — a valid state during the Phase 4.1/4.2 transition when
 * a user may change their password before their first unlock generates
 * a keypair. The VaultContext caller should not treat this as an error.
 */
export async function rewrapUserKeypair(
  args: RewrapUserKeypairArgs,
): Promise<RewrapUserKeypairResult> {
  const { userId, oldMek, newMek, saltB64, supabase } = args;

  const existing = await supabase
    .from('user_vault_keys')
    .select('public_key_b64, encrypted_private_key, iv')
    .eq('user_id', userId)
    .maybeSingle();

  if (existing.error) {
    throw existing.error;
  }
  if (!existing.data?.encrypted_private_key) {
    return { rewrapped: false, reason: 'no-row' };
  }

  // Unwrap under the old MEK, then re-wrap under the new MEK.
  const oldWrapKey = await derivePqcSecretWrapKey(oldMek, saltB64);
  const newWrapKey = await derivePqcSecretWrapKey(newMek, saltB64);
  const secretKeyB64 = await decryptString(existing.data.encrypted_private_key, oldWrapKey);
  const newEncrypted = await encryptString(secretKeyB64, newWrapKey);

  // Atomic UPDATE on the existing row. No DELETE + INSERT.
  const update = await supabase
    .from('user_vault_keys')
    .update({
      encrypted_private_key: newEncrypted,
      iv: extractIvFromEncryptedString(newEncrypted),
      // updated_at is bumped by the trg_user_vault_keys_updated_at
      // trigger — we intentionally do not set it from the client so
      // the DB is the single source of truth for the timestamp.
    } as unknown as Record<string, unknown>)
    .eq('user_id', userId);

  if (update.error) {
    throw update.error;
  }

  return { rewrapped: true };
}

// ---------------------------------------------------------------------------
// MEK → HKDF import helper.
// ---------------------------------------------------------------------------

/**
 * Import raw MEK bytes as an HKDF base key, suitable for passing to
 * `ensureUserKeypair` / `rewrapUserKeypair` (both of which ultimately
 * call `crypto.subtle.deriveBits({ name: 'HKDF' }, mek, ...)` inside
 * `derivePqcSecretWrapKey`).
 *
 * OWB stores the MEK as a non-extractable AES-GCM CryptoKey in
 * VaultContext (used for data encrypt/decrypt). For HKDF subkey
 * derivation we need a *separate* import with usage `['deriveBits']`.
 * Both imports come from the same raw bytes so there is no trust
 * boundary crossed — they are simply different "views" of the same
 * 32-byte MEK tailored to different WebCrypto operations.
 *
 * The returned CryptoKey is non-extractable.
 */
export async function importMekForHkdf(mekRaw: Uint8Array): Promise<CryptoKey> {
  // `globalThis.crypto` resolves to the same WebCrypto in the browser
  // (window.crypto) and in Node 20+ (node's built-in crypto.webcrypto
  // is exposed globally). Using the global form keeps this module
  // node-testable without any jsdom dependency.
  return globalThis.crypto.subtle.importKey(
    'raw',
    mekRaw as BufferSource,
    'HKDF',
    /* extractable */ false,
    ['deriveBits'],
  );
}

// ---------------------------------------------------------------------------
// Local-only helper re-export for tests. `importAesKeyNonExtractable` is
// re-exported from the vault barrel; re-exposing it here keeps the test
// file's import list tight.
// ---------------------------------------------------------------------------

export { importAesKeyNonExtractable };
