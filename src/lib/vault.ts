/**
 * Orange Way Books — Client-Side Encryption.
 *
 * One key derivation strategy is registered at any given time:
 *   v1: Argon2id (hash-wasm) with OWASP 2023 parameters, per-org random
 *       salt. Random 32-byte MEK wrapped by the Argon2id-derived KEK so
 *       password changes re-wrap the MEK instead of re-encrypting every
 *       row.
 *
 * Encryption:      AES-256-GCM with a random 96-bit IV per operation.
 * Output format:   base64( iv[12 bytes] + ciphertext + auth_tag[16 bytes] ).
 *
 * Adding a future v2 is a single entry in `KEY_DERIVATION_STRATEGIES_WITH_SALT`
 * plus a new derive function. The dispatch path in `deriveKeyForVersion`
 * stays version-agnostic so callers never branch on version explicitly.
 */

import { argon2id } from 'hash-wasm';

const SALT_PREFIX_V1 = 'owb-vault-v1:';
const ORANGE_WAY_BOOKS_VAULT_V1 = 'orange-way-books-vault-v1';
/**
 * Minimum vault password length. Enforced by the setup UI and by the
 * crypto boundary itself.
 */
export const MIN_VAULT_PASSWORD_LENGTH = 14;

/** Argon2id parameters — OWASP 2023 recommended profile. */
export const ARGON2ID_V1 = Object.freeze({
  memorySize: 65536, // KiB
  iterations: 3,
  parallelism: 4,
  hashLength: 32, // 256-bit output → AES-256 key
} as const);

/** Latest key derivation version — what new vaults use. */
export const LATEST_VAULT_KEY_VERSION = 1 as const;

/** Enforce the minimum at the crypto boundary. Callers that skip UI-level
 *  checks still fail closed. */
function requireStrongPassword(
  password: string,
  minLength: number = MIN_VAULT_PASSWORD_LENGTH,
): void {
  if (typeof password !== 'string' || password.length < minLength) {
    throw new Error(`Vault password must be at least ${minLength} characters`);
  }
}

/** Generate a fresh 32-byte org salt encoded as base64. */
export function generateVaultSalt(): string {
  const bytes = window.crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes));
}

/**
 * Encrypts a plaintext string with AES-256-GCM.
 * Returns base64(iv[12] + ciphertext + tag[16]).
 * Every call uses a fresh random IV — same plaintext produces different ciphertext.
 */
export async function encryptText(plaintext: string, key: CryptoKey): Promise<string> {
  const encoder = new TextEncoder();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  const ciphertext = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext),
  );

  // Combine: [iv (12 bytes)][ciphertext + auth tag]
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);

  return uint8ArrayToBase64(combined);
}

// Spread-args (`String.fromCharCode(...arr)`) blows the JS call stack at
// ~64-128 KB depending on the engine. For large attachment blobs we'd hit
// `RangeError: Maximum call stack size exceeded`. Process in 8 KB chunks
// (well under the limit on every engine we care about) and concatenate.
function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x2000; // 8192
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, i + CHUNK);
    bin += String.fromCharCode.apply(null, slice as unknown as number[]);
  }
  return btoa(bin);
}

/**
 * Decrypts a base64 string produced by encryptText.
 * Throws if the key is wrong or the data is tampered (AES-GCM authentication).
 */
export async function decryptText(ciphertext: string, key: CryptoKey): Promise<string> {
  const combined = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));
  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const plaintext = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);

  return new TextDecoder().decode(plaintext);
}

/**
 * Encrypts raw bytes (e.g. a File / Blob) with AES-256-GCM.
 * Returns a Blob whose content is: [iv (12 bytes)][ciphertext + auth tag].
 * Same layout convention as encryptText but operating on bytes instead of UTF-8 text.
 */
export async function encryptBlob(
  plaintext: ArrayBuffer | Uint8Array,
  key: CryptoKey,
): Promise<Blob> {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const bytes = plaintext instanceof ArrayBuffer ? new Uint8Array(plaintext) : plaintext;

  const ciphertext = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    bytes as BufferSource,
  );

  // Combine: [iv (12 bytes)][ciphertext + auth tag]
  const combined = new Uint8Array(12 + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), 12);

  return new Blob([combined], { type: 'application/octet-stream' });
}

/**
 * Decrypts a Blob (or ArrayBuffer) produced by encryptBlob.
 * Returns the original plaintext bytes as an ArrayBuffer.
 * Throws if the key is wrong or the data is tampered (AES-GCM authentication).
 */
export async function decryptBlob(
  ciphertext: Blob | ArrayBuffer,
  key: CryptoKey,
): Promise<ArrayBuffer> {
  const buffer = ciphertext instanceof Blob ? await ciphertext.arrayBuffer() : ciphertext;
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) throw new Error('Invalid encrypted blob: too short');
  const iv = bytes.slice(0, 12);
  const data = bytes.slice(12);

  return window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
}

/**
 * Registry of key derivation strategies keyed by vault_key_version.
 *
 * The extension point for future KDF upgrades: adding a v2 is a single
 * entry here plus a new derive function. VaultContext and the verifier
 * helpers must NOT branch on version explicitly — they route through this
 * map (OCP / DIP).
 */
export type DeriveFnWithSalt = (
  password: string,
  userId: string,
  orgSaltB64: string,
) => Promise<CryptoKey>;

export const KEY_DERIVATION_STRATEGIES_WITH_SALT: Readonly<Record<number, DeriveFnWithSalt>> =
  Object.freeze({
    // v1 returns the KEK (not a direct MEK). Callers using deriveKeyForVersion
    // under v1 are encrypting the verifier or running through a wrapping path
    // where the KEK is the right key to hand back. The actual MEK lives as
    // random bytes wrapped by this KEK; see deriveVaultV1Kek / wrapMekWithKey /
    // unwrapMekWithKey for the wrapping flow and VaultContext.setupVault for
    // the full onboarding orchestration.
    1: deriveVaultV1Kek,
  });

/**
 * Creates an encrypted verifier to store in Supabase.
 * Used to confirm the vault password is correct on subsequent logins
 * without storing the password or MEK anywhere.
 */
export async function createVaultVerifier(
  password: string,
  userId: string,
  orgSaltB64: string,
  keyVersion: number = LATEST_VAULT_KEY_VERSION,
): Promise<string> {
  const key = await deriveKeyForVersion(password, userId, orgSaltB64, keyVersion);
  return encryptText(ORANGE_WAY_BOOKS_VAULT_V1, key);
}

/**
 * Verifies the vault password by decrypting the stored verifier.
 * Returns true if the password matches, false otherwise.
 */
export async function verifyVaultPassword(
  password: string,
  userId: string,
  encryptedVerifier: string,
  orgSaltB64: string,
  keyVersion: number = LATEST_VAULT_KEY_VERSION,
): Promise<boolean> {
  try {
    const key = await deriveKeyForVersion(password, userId, orgSaltB64, keyVersion);
    const result = await decryptText(encryptedVerifier, key);
    return result === ORANGE_WAY_BOOKS_VAULT_V1;
  } catch {
    return false;
  }
}

/**
 * Derive the KEK for a given `vault_key_version`. VaultContext calls this
 * directly instead of branching on the version itself. Adding a new
 * version is a single entry in `KEY_DERIVATION_STRATEGIES_WITH_SALT` plus
 * a new derive function.
 */
export async function deriveKeyForVersion(
  password: string,
  userId: string,
  orgSaltB64: string | null,
  keyVersion: number = LATEST_VAULT_KEY_VERSION,
): Promise<CryptoKey> {
  const strategy = KEY_DERIVATION_STRATEGIES_WITH_SALT[keyVersion];
  if (!strategy) {
    throw new Error(`Unsupported vault_key_version: ${keyVersion}`);
  }
  if (!orgSaltB64) {
    throw new Error(`vault_key_version ${keyVersion} requires a per-org salt`);
  }
  return strategy(password, userId, orgSaltB64);
}

// ─────────────────────────────────────────────────────────────────────────────
// v1: MEK wrapping + recovery codes + blind indexes.
// ─────────────────────────────────────────────────────────────────────────────
// MEK is random 32 bytes; the password-derived KEK *wraps* the MEK.
// Changing the password re-wraps only; no data re-encryption required.
//
// Two independent wrappings are stored:
//   enc_mek_ciphertext   — MEK wrapped with Argon2id(password, salt)
//   recovery_ciphertext  — MEK wrapped with HKDF(12-word recovery code)
//
// Blind indexes: a single Argon2id call produces 64 bytes.
//   Bytes  0-31 → KEK for MEK wrapping (AES-256-GCM)
//   Bytes 32-63 → HMAC-SHA256 blind index key (server-side search)
// One KDF round, two keys — no extra unlock cost.

/** Generate 32 cryptographically random bytes for a new MEK. */
export function generateMekBytes(): Uint8Array {
  return window.crypto.getRandomValues(new Uint8Array(32));
}

/** Import raw bytes as a non-extractable AES-256-GCM key. */
export async function importAesGcmKey(raw: Uint8Array): Promise<CryptoKey> {
  return window.crypto.subtle.importKey(
    'raw',
    raw as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Wrap raw MEK bytes with a wrapping key (KEK or recovery KEK).
 * Reuses the encryptText wire format so unwrapping is symmetric.
 */
export async function wrapMekWithKey(mekRaw: Uint8Array, wrappingKey: CryptoKey): Promise<string> {
  const mekB64 = btoa(String.fromCharCode(...mekRaw));
  return encryptText(mekB64, wrappingKey);
}

/**
 * Unwrap a wrapped MEK ciphertext back to raw bytes.
 * Throws on wrong key or tampered ciphertext (AES-GCM auth).
 */
export async function unwrapMekWithKey(
  ciphertext: string,
  wrappingKey: CryptoKey,
): Promise<Uint8Array> {
  const mekB64 = await decryptText(ciphertext, wrappingKey);
  return Uint8Array.from(atob(mekB64), (c) => c.charCodeAt(0));
}

/**
 * Derive the v1 KEK from the password via Argon2id.
 *
 * KEK wraps/unwraps the random MEK. Call once per unlock or setup.
 *
 * IMPORTANT: blindIndexKey is derived from the MEK via
 * `deriveBlindIndexKeyFromMek` so that a password change doesn't
 * invalidate existing hmac_* values in the database. The MEK is random
 * and stable across password changes; only its wrapping changes.
 */
export async function deriveVaultV1Kek(
  password: string,
  userId: string,
  orgSaltB64: string,
): Promise<CryptoKey> {
  requireStrongPassword(password);
  const encoder = new TextEncoder();
  const saltBytes = encoder.encode(SALT_PREFIX_V1 + userId + ':' + orgSaltB64);

  const raw: Uint8Array = await argon2id({
    password: encoder.encode(password),
    salt: saltBytes,
    memorySize: ARGON2ID_V1.memorySize,
    iterations: ARGON2ID_V1.iterations,
    parallelism: ARGON2ID_V1.parallelism,
    hashLength: ARGON2ID_V1.hashLength,
    outputType: 'binary',
  });

  return window.crypto.subtle.importKey(
    'raw',
    raw as BufferSource,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Derive the HMAC-SHA256 blind index key from the raw MEK bytes via HKDF.
 *
 * The MEK is random and stable (it doesn't change on password change or
 * recovery) so this key is durable across the lifetime of the vault. Blind
 * index values in the DB remain valid through every password rotation.
 *
 * Using a distinct HKDF info string domain-separates this key from any
 * future subkeys derived from the same MEK.
 */
export async function deriveBlindIndexKeyFromMek(
  mekRaw: Uint8Array,
  orgSaltB64: string,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const saltBytes = encoder.encode('owb-hmac-v1:' + orgSaltB64);

  const mekAsHkdf = await window.crypto.subtle.importKey(
    'raw',
    mekRaw as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  );

  const rawHmac = await window.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBytes as BufferSource,
      info: encoder.encode('blind-index-hmac') as BufferSource,
    },
    mekAsHkdf,
    256,
  );

  return window.crypto.subtle.importKey('raw', rawHmac, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
}

// ─── OrangeRails MEK — vault-version-independent ────────────────────────────
//
// Separate Argon2id derivation with a stable salt prefix. Used as input
// material for the OrangeRails ORK/ORT HKDF.
//
// Cost: one extra Argon2id call (~1–2s) on each unlock. Acceptable for
// the durability gain.

export async function deriveOrMekBytes(
  password: string,
  userId: string,
  orgSaltB64: string,
): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const saltBytes = encoder.encode('owb-or-mek-v1:' + userId + ':' + orgSaltB64);
  const hashBytes = await argon2id({
    password: encoder.encode(password),
    salt: saltBytes,
    memorySize: ARGON2ID_V1.memorySize,
    iterations: ARGON2ID_V1.iterations,
    parallelism: ARGON2ID_V1.parallelism,
    hashLength: 32,
    outputType: 'binary',
  });
  return hashBytes;
}

// ─── OrangeRails subkeys — for connection sync via OR platform API ──────────
//
// Two extractable AES-256-GCM subkeys derived from the MEK via HKDF-SHA-256.
// HKDF info strings MUST match OrangeRails: 'orangerails-creds-v1' and
// 'orangerails-txns-v1'. Salt MUST be consistent between encryption (when
// adding a connection) and decryption (when displaying or syncing) — we
// use the org salt so all users of the same org derive identical keys.
//
// The subkeys are EXTRACTABLE so they can be exported as base64 and handed
// to OR's or-sync edge function in-transit (server uses them in-memory
// for one HTTP request, never persists). For pure-client encryption /
// decryption (label, credential blobs, displayed transactions) the keys
// are used in-place without leaving the tab.

async function deriveOrSubkey(
  mekRaw: Uint8Array,
  orgSaltB64: string,
  hkdfInfo: string,
): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const saltBytes = encoder.encode('owb-or:' + orgSaltB64);
  const mekAsHkdf = await window.crypto.subtle.importKey(
    'raw',
    mekRaw as BufferSource,
    'HKDF',
    false,
    ['deriveBits'],
  );
  const rawBits = await window.crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: saltBytes as BufferSource,
      info: encoder.encode(hkdfInfo) as BufferSource,
    },
    mekAsHkdf,
    256,
  );
  return window.crypto.subtle.importKey(
    'raw',
    rawBits,
    { name: 'AES-GCM' },
    /* extractable */ true,
    ['encrypt', 'decrypt'],
  );
}

export async function deriveOrCredsKeyFromMek(
  mekRaw: Uint8Array,
  orgSaltB64: string,
): Promise<CryptoKey> {
  return deriveOrSubkey(mekRaw, orgSaltB64, 'orangerails-creds-v1');
}

export async function deriveOrTxnsKeyFromMek(
  mekRaw: Uint8Array,
  orgSaltB64: string,
): Promise<CryptoKey> {
  return deriveOrSubkey(mekRaw, orgSaltB64, 'orangerails-txns-v1');
}

// ─── Recovery codes: 12-word offline backup for the MEK ─────────────────────
// Full standard BIP-39 English wordlist (2048 words). 12 words × log2(2048)
// = 132 bits of entropy. 11-bit indexing has no modulo bias since 2^11 = 2048
// exactly — a 16-bit random sample masked with 0x7FF is uniformly distributed.
// Uses the BIP-39 English wordlist without checksum validation: not a
// standard BIP-39 mnemonic, cannot be imported into a Bitcoin wallet.

import { BIP39_WORDS } from './bip39-words';

/** Generate a 12-word recovery code from 132 bits of crypto-random entropy. */
export function generateRecoveryCode(): string {
  const buf = new Uint16Array(12);
  window.crypto.getRandomValues(buf);
  return Array.from(buf, (sample) => BIP39_WORDS[sample & 0x7ff]).join(' ');
}

/**
 * Derive an AES-256-GCM wrapping key from a 12-word recovery code via HKDF.
 * No password-stretching: the code already has 132 bits of entropy.
 */
export async function deriveRecoveryKek(recoveryCode: string): Promise<CryptoKey> {
  const normalized = recoveryCode.trim().toLowerCase().replace(/\s+/g, ' ');
  const encoder = new TextEncoder();
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    encoder.encode(normalized) as BufferSource,
    'HKDF',
    false,
    ['deriveKey'],
  );
  return window.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: encoder.encode('owb-recovery-v1') as BufferSource,
      info: new Uint8Array(),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// ─── Master recovery code (unlocks ALL the user's orgs) ──────────────────────
//
// Separate HKDF context string + per-user salt so the master KEK is
// independent of the per-org recovery KEK. Same crypto profile: 12-word
// BIP-39 code, HKDF-SHA256, AES-256-GCM wrap.

const ORANGE_WAY_BOOKS_MASTER_RECOVERY_V1 = 'orange-way-books-master-recovery-v1';

/**
 * Derive the master recovery KEK from a 12-word code + per-user salt.
 * The salt is fetched from public.user_master_recovery and is non-sensitive.
 */
export async function deriveMasterRecoveryKek(
  masterCode: string,
  masterSaltB64: string,
): Promise<CryptoKey> {
  const normalized = masterCode.trim().toLowerCase().replace(/\s+/g, ' ');
  const encoder = new TextEncoder();
  const saltBytes = Uint8Array.from(atob(masterSaltB64), (c) => c.charCodeAt(0));
  const keyMaterial = await window.crypto.subtle.importKey(
    'raw',
    encoder.encode(normalized) as BufferSource,
    'HKDF',
    false,
    ['deriveKey'],
  );
  // Combine per-user salt + fixed context string into the HKDF salt
  // parameter. HKDF-Extract concatenates IKM + salt then HKDF-Expand keys
  // off info; differentiation bytes anywhere in the inputs differentiate
  // the output.
  const ctx = encoder.encode('owb-master-recovery-v1');
  const combinedSalt = new Uint8Array(saltBytes.length + ctx.length);
  combinedSalt.set(saltBytes, 0);
  combinedSalt.set(ctx, saltBytes.length);
  return window.crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: combinedSalt,
      info: new Uint8Array(),
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt the fixed master verifier plaintext under the master KEK. */
export async function createMasterRecoveryVerifier(
  masterCode: string,
  masterSaltB64: string,
): Promise<string> {
  const kek = await deriveMasterRecoveryKek(masterCode, masterSaltB64);
  return encryptText(ORANGE_WAY_BOOKS_MASTER_RECOVERY_V1, kek);
}

/** True iff the verifier blob decrypts to the canonical plaintext. */
export async function verifyMasterRecoveryCode(
  masterCode: string,
  masterSaltB64: string,
  verifierCiphertext: string,
): Promise<boolean> {
  try {
    const kek = await deriveMasterRecoveryKek(masterCode, masterSaltB64);
    const plain = await decryptText(verifierCiphertext, kek);
    return plain === ORANGE_WAY_BOOKS_MASTER_RECOVERY_V1;
  } catch {
    return false;
  }
}

/** Generate a 32-byte random salt and return its base64 representation. */
export function generateMasterRecoverySalt(): string {
  const buf = new Uint8Array(32);
  window.crypto.getRandomValues(buf);
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
}

// ============================================================================
// Orange Rails-compatible adapter exports
// ----------------------------------------------------------------------------
// These re-exports (and thin wrappers) expose the native vault primitives
// under the names that Orange Rails uses upstream. Consumed today by
// key-derivation.ts and vault-keypair.ts; preserved as a stable surface
// for any future OR-style modules ported into OWB.
//
// Do NOT add new logic here — only name translations and minimal signature
// adapters over existing exports.
// ============================================================================

/**
 * OR-compatible `encryptString`. Byte-identical wire format to OR:
 * base64(iv[12] | ciphertext | tag[16]) via AES-256-GCM. The native
 * `encryptText` already produces this exact format.
 */
export { encryptText as encryptString };

/**
 * OR-compatible `decryptString`. Inverse of `encryptString`, delegates to
 * the native `decryptText`.
 */
export { decryptText as decryptString };

/**
 * OR-compatible `importAesKey`. Returns an **extractable** AES-256-GCM
 * CryptoKey from raw bytes. Extractable because OR subkeys are sometimes
 * handed to edge functions in-transit; for local-only keys callers should
 * use `importAesKeyNonExtractable` below.
 *
 * OR's signature is `(rawBytes: ArrayBuffer)`. We accept BufferSource so
 * callers passing ArrayBuffer, Uint8Array, or other BufferSource work.
 */
export async function importAesKey(rawBytes: ArrayBuffer | Uint8Array): Promise<CryptoKey> {
  return window.crypto.subtle.importKey(
    'raw',
    rawBytes as BufferSource,
    { name: 'AES-GCM' },
    /* extractable */ true,
    ['encrypt', 'decrypt'],
  );
}

/**
 * OR-compatible `importAesKeyNonExtractable`. Returns a non-extractable
 * AES-256-GCM CryptoKey from raw bytes. We use the existing `importAesGcmKey` which
 * does the same thing but takes `Uint8Array`; OR callers pass ArrayBuffer
 * from `crypto.subtle.deriveBits`, so this wrapper accepts both.
 */
export async function importAesKeyNonExtractable(
  rawBytes: ArrayBuffer | Uint8Array,
): Promise<CryptoKey> {
  return window.crypto.subtle.importKey(
    'raw',
    rawBytes as BufferSource,
    { name: 'AES-GCM' },
    /* extractable */ false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * OR-compatible `deriveMekRaw`. Re-runs Argon2id and returns the raw
 * 32-byte hash. OR's signature is `(password, saltBase64)` with the salt
 * as raw base64 bytes (no prefix).
 *
 * Parameters match OR's `ARGON2ID_V1` which are numerically identical to
 * The OWASP 2023 recommended profile.
 *
 * The returned bytes are transient: callers must derive subkeys immediately
 * and let the array be garbage-collected. Never persist or log.
 */
export async function deriveMekRaw(password: string, saltBase64: string): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);
  // Decode the base64 salt the way OR does — raw 32 bytes, no prefix.
  const saltBinary = atob(saltBase64);
  const saltBytes = new Uint8Array(saltBinary.length);
  for (let i = 0; i < saltBinary.length; i++) saltBytes[i] = saltBinary.charCodeAt(i);

  const hashBytes = await argon2id({
    password: passwordBytes,
    salt: saltBytes,
    memorySize: ARGON2ID_V1.memorySize,
    iterations: ARGON2ID_V1.iterations,
    parallelism: ARGON2ID_V1.parallelism,
    hashLength: ARGON2ID_V1.hashLength,
    outputType: 'binary',
  });

  return hashBytes as Uint8Array;
}
