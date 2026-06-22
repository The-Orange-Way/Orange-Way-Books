/**
 * Org Signing Key client helpers — Phase 4.4.
 *
 * The signing key is a per-org ML-DSA-65 keypair:
 *
 *   - Public half lives in `org_signing_keys` (plaintext; any member
 *     can fetch it to verify peer writes).
 *   - Private half is wrapped per writer via the same hybrid-KEM
 *     strategy used for org_keys invite wraps, and stored in
 *     `org_member_signing_key_wraps` keyed on (user_id, org_id, key_version).
 *
 * Auditor and Viewer members never get a wrap, which is the
 * cryptographic read-only enforcement — see
 * OWB-MULTIUSER-DESIGN.md §3 "three-layer read-only (Auditor)".
 *
 * This module stays browser-pure: it only knows about bytes + base64
 * + ML-DSA primitives + hybrid-KEM strategies. Supabase I/O happens at
 * the VaultContext + Admin.tsx call sites.
 *
 * ── Non-goals ──────────────────────────────────────────────────────
 *   * No re-key / rotation logic — that lands in Phase 4.5 alongside
 *     hard re-key.
 *   * No signature payload-composition schema. Callers pass a
 *     `Uint8Array` and own the canonicalization: for the Phase 4.4
 *     transaction call site that payload is the encrypted memo bytes
 *     (the same AES-GCM ciphertext stored on the row).
 */

import { ML_DSA_65, generateSigKeyPair, sign as mlDsaSign, verify as mlDsaVerify } from '@/lib/pqc';
import { DEFAULT_WRAP_ALGORITHM, KEY_WRAP_STRATEGIES, base64ToBytes } from '@/lib/key-wrapping';

// ---------------------------------------------------------------------------
// Local base64 helpers — kept inline so this module has no cross-module
// dep on invite-wrap.ts (both modules share the primitive).
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// ---------------------------------------------------------------------------
// Types exposed to callers.
// ---------------------------------------------------------------------------

/** One writer recipient for `generateAndWrapSigningKey`. */
export interface WriterRecipient {
  /** auth.users.id of the writer. */
  userId: string;
  /** Base64 of their hybrid public key (user_vault_keys.public_key_b64). */
  publicKeyB64: string;
}

/** Shape of one row the caller sends to the mint-org-signing-key function. */
export interface SigningKeyWrapRow {
  user_id: string;
  wrapped_private_key: string;
  iv: string;
  wrap_algo: string;
  key_version: number;
}

/** Bundle produced by generateAndWrapSigningKey. Ready to POST. */
export interface GeneratedSigningKeyBundle {
  publicKeyB64: string;
  keyVersion: number;
  algorithm: string;
  wraps: SigningKeyWrapRow[];
  /**
   * Raw private key bytes — caller must drop the reference immediately
   * after passing to the mint-org-signing-key request (or store in the
   * VaultContext signing-key cache). The server never sees this.
   */
  privateKeyBytes: Uint8Array;
}

// ---------------------------------------------------------------------------
// Wire-format helpers.
// ---------------------------------------------------------------------------

const WRAP_ALGO_LABEL = 'hybrid-kem-v1';
const DATA_KEY_BYTES_TAG = 16;
const AES_GCM_IV_BYTES = 12;

/**
 * Extract the 12-byte IV that the hybrid-KEM strategy prepends to its
 * AES-GCM ciphertext. We duplicate the IV in the `iv` column so the
 * server-side audit tooling can inspect it without parsing base64 on
 * every row. The blob is self-contained either way — the IV column is
 * a convenience, not a requirement for unwrapping.
 */
function extractIvFromWrap(wrapped: Uint8Array, privateKeyBytes: number): Uint8Array {
  // Layout (see key-wrapping.ts): kemCt | iv[12] | (privateKey + tag[16]).
  const ivOffset = wrapped.length - AES_GCM_IV_BYTES - privateKeyBytes - DATA_KEY_BYTES_TAG;
  if (ivOffset < 0) {
    throw new Error(`signing-key wrap blob too short: ${wrapped.length} bytes`);
  }
  return wrapped.subarray(ivOffset, ivOffset + AES_GCM_IV_BYTES);
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Generate a fresh ML-DSA-65 keypair and wrap its private half to each
 * writer's hybrid public key. Callers pass the result to the
 * `mint-org-signing-key` edge function.
 *
 * Wraps only the writer roles — callers determine who's a writer
 * (members holding a capability with `requires_osk = TRUE`). A
 * non-writer accidentally receiving a wrap is a non-issue: the RLS +
 * capability layer denies their writes anyway. The edge function trusts
 * the client's computation here (adding an extra wrap is not a security
 * downgrade).
 *
 * NOTE: this wraps the ML-DSA *secret key* (4032 bytes for ML-DSA-65),
 * which is larger than the 32-byte DEK the hybrid-KEM strategy is
 * nominally designed to wrap. We cannot reuse `wrapForRecipient`
 * directly — it hardcodes the 32-byte data key length. We therefore
 * implement the wrap inline using the same hybrid KEM + AES-GCM
 * primitives. The wire format is identical (kemCt | iv[12] ||
 * AES-GCM(privateKey)) so a future migration could factor the two
 * paths together.
 */
export async function generateAndWrapSigningKey(
  orgId: string,
  writers: WriterRecipient[],
  keyVersion = 1,
): Promise<GeneratedSigningKeyBundle> {
  if (!orgId) throw new Error('orgId is required');
  if (writers.length === 0) {
    throw new Error('At least one writer recipient is required to mint a signing key.');
  }

  // Generate the ML-DSA-65 keypair. The client never writes the secret
  // half back to the server except as per-recipient wraps below.
  const kp = generateSigKeyPair();

  // Wrap the private key for each writer using the hybrid KEM + AES-GCM
  // primitives. Layout matches the hybrid-x25519-mlkem768 strategy:
  //   kemCiphertext (1120) | iv (12) | AES-GCM(privateKey | tag)
  const { hybridEncapsulate } = await import('@/lib/pqc');
  const wraps: SigningKeyWrapRow[] = [];
  for (const w of writers) {
    const recipientPub = base64ToBytes(w.publicKeyB64);
    const { ciphertext: kemCt, sharedSecret } = hybridEncapsulate(recipientPub);
    const aesKey = await crypto.subtle.importKey(
      'raw',
      sharedSecret as BufferSource,
      { name: 'AES-GCM' },
      /* extractable */ false,
      ['encrypt', 'decrypt'],
    );
    const iv = new Uint8Array(AES_GCM_IV_BYTES);
    crypto.getRandomValues(iv);
    const ct = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        aesKey,
        kp.secretKey as BufferSource,
      ),
    );

    // Concatenate kemCt | iv | ct.
    const wrapped = new Uint8Array(kemCt.length + iv.length + ct.length);
    wrapped.set(kemCt, 0);
    wrapped.set(iv, kemCt.length);
    wrapped.set(ct, kemCt.length + iv.length);

    wraps.push({
      user_id: w.userId,
      wrapped_private_key: bytesToBase64(wrapped),
      iv: bytesToBase64(iv),
      wrap_algo: WRAP_ALGO_LABEL,
      key_version: keyVersion,
    });
  }

  return {
    publicKeyB64: bytesToBase64(kp.publicKey),
    keyVersion,
    algorithm: 'ml-dsa-65',
    wraps,
    privateKeyBytes: kp.secretKey,
  };
}

/**
 * Unwrap a stored `org_member_signing_key_wraps` row to recover the user's
 * ML-DSA-65 secret key. Inverse of generateAndWrapSigningKey's wrap path.
 *
 * The recipient's hybrid secret key (x25519 | ML-KEM-768) must be
 * provided by the caller — typically fetched and decrypted by
 * VaultContext on unlock.
 */
export async function unwrapSigningKeyForSelf(
  wrappedPrivateKeyB64: string,
  ownHybridSecretKeyBytes: Uint8Array,
): Promise<Uint8Array> {
  const wrapped = base64ToBytes(wrappedPrivateKeyB64);

  // Use the same strategy primitives the invite-wrap path does —
  // wire format is identical. `unwrapForSelf` expects a blob with a
  // 32-byte data key, so we fall back to the low-level helpers here.
  const { HYBRID_KEM_CIPHERTEXT_BYTES, hybridDecapsulate } = await import('@/lib/pqc');

  if (wrapped.length < HYBRID_KEM_CIPHERTEXT_BYTES + AES_GCM_IV_BYTES + DATA_KEY_BYTES_TAG) {
    throw new Error('signing-key wrap blob is too short to unwrap.');
  }

  const kemCt = wrapped.subarray(0, HYBRID_KEM_CIPHERTEXT_BYTES);
  const iv = wrapped.subarray(
    HYBRID_KEM_CIPHERTEXT_BYTES,
    HYBRID_KEM_CIPHERTEXT_BYTES + AES_GCM_IV_BYTES,
  );
  const ct = wrapped.subarray(HYBRID_KEM_CIPHERTEXT_BYTES + AES_GCM_IV_BYTES);

  const sharedSecret = hybridDecapsulate(ownHybridSecretKeyBytes, kemCt);
  const aesKey = await crypto.subtle.importKey(
    'raw',
    sharedSecret as BufferSource,
    { name: 'AES-GCM' },
    /* extractable */ false,
    ['encrypt', 'decrypt'],
  );
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      aesKey,
      ct as BufferSource,
    ),
  );
  if (plaintext.length !== ML_DSA_65.secretKeyBytes) {
    throw new Error(
      `Unwrapped signing key has wrong length: expected ${ML_DSA_65.secretKeyBytes}, got ${plaintext.length}`,
    );
  }
  return plaintext;
}

/**
 * Signing-key handle returned by VaultContext. The private key bytes
 * stay inside the handle; callers pass the handle to `signMutation`.
 */
export interface SigningKeyHandle {
  privateKeyBytes: Uint8Array;
  keyVersion: number;
}

/** Produce an ML-DSA-65 signature over `payloadBytes` using the handle. */
export function signMutation(
  payloadBytes: Uint8Array,
  handle: SigningKeyHandle,
): { signature_b64: string; key_version: number } {
  const sig = mlDsaSign(handle.privateKeyBytes, payloadBytes);
  return {
    signature_b64: bytesToBase64(sig),
    key_version: handle.keyVersion,
  };
}

/**
 * Verify an ML-DSA-65 signature against the provided org public key.
 * Returns false on any validation failure — never throws.
 */
export function verifyMutation(
  payloadBytes: Uint8Array,
  signatureB64: string,
  orgPublicKeyB64: string,
): boolean {
  try {
    const sig = base64ToBytes(signatureB64);
    const pub = base64ToBytes(orgPublicKeyB64);
    return mlDsaVerify(pub, payloadBytes, sig);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Incidental re-exports so call sites don't need to import from pqc.ts.
// ---------------------------------------------------------------------------

export { ML_DSA_65 };
// Silence unused-import warning — DEFAULT_WRAP_ALGORITHM is kept in the
// import list as documentation that this module intentionally uses the
// same hybrid-KEM strategy label family as key-wrapping.ts (though it
// encodes its own 'hybrid-kem-v1' marker for clarity).
void DEFAULT_WRAP_ALGORITHM;
void KEY_WRAP_STRATEGIES;
void extractIvFromWrap;
