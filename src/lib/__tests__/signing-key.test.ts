/**
 * @vitest-environment node
 *
 * Phase 4.4 — Org Signing Key client helper tests.
 *
 * Exercises:
 *   1. `generateAndWrapSigningKey` produces a bundle whose wraps each unwrap
 *      back to the same ML-DSA-65 secret key the generator produced.
 *   2. `signMutation` + `verifyMutation` round-trip for a recipient who
 *      unwrapped their row.
 *   3. A non-writer (whose wrap was never minted) cannot unwrap.
 *   4. `verifyMutation` returns false (never throws) on tampered input.
 *
 * Pure-crypto; no Supabase dependency. The edge function wire format is
 * integration-tested separately.
 */

import { describe, it, expect } from 'vitest';

// OWB crypto primitives look up `window.crypto`; node's test env exposes
// only `globalThis.crypto`. Alias once so downstream imports resolve.
if (typeof (globalThis as unknown as { window?: unknown }).window === 'undefined') {
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
}

import {
  generateAndWrapSigningKey,
  unwrapSigningKeyForSelf,
  signMutation,
  verifyMutation,
  ML_DSA_65,
} from '@/lib/signing-key';
import { generateHybridKemKeyPair } from '@/lib/pqc';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

describe('generateAndWrapSigningKey', () => {
  it('produces a bundle with one wrap per writer', async () => {
    const writerA = generateHybridKemKeyPair();
    const writerB = generateHybridKemKeyPair();

    const bundle = await generateAndWrapSigningKey('org-123', [
      { userId: 'user-a', publicKeyB64: bytesToBase64(writerA.publicKey) },
      { userId: 'user-b', publicKeyB64: bytesToBase64(writerB.publicKey) },
    ]);

    expect(bundle.algorithm).toBe('ml-dsa-65');
    expect(bundle.keyVersion).toBe(1);
    expect(bundle.wraps).toHaveLength(2);
    expect(bundle.wraps[0]).toMatchObject({
      user_id: 'user-a',
      wrap_algo: 'hybrid-kem-v1',
      key_version: 1,
    });
    expect(bundle.privateKeyBytes.length).toBe(ML_DSA_65.secretKeyBytes);
  });

  it('throws when writers is empty', async () => {
    await expect(generateAndWrapSigningKey('org-1', [])).rejects.toThrow(/writer/);
  });

  it('wrapped private key unwraps to the exact generator output', async () => {
    const writer = generateHybridKemKeyPair();
    const bundle = await generateAndWrapSigningKey('org-1', [
      { userId: 'u1', publicKeyB64: bytesToBase64(writer.publicKey) },
    ]);

    const unwrapped = await unwrapSigningKeyForSelf(
      bundle.wraps[0].wrapped_private_key,
      writer.secretKey,
    );

    expect(bytesToBase64(unwrapped)).toBe(bytesToBase64(bundle.privateKeyBytes));
  });

  it('refuses to unwrap for a third party', async () => {
    const writer = generateHybridKemKeyPair();
    const outsider = generateHybridKemKeyPair();
    const bundle = await generateAndWrapSigningKey('org-1', [
      { userId: 'u1', publicKeyB64: bytesToBase64(writer.publicKey) },
    ]);

    await expect(
      unwrapSigningKeyForSelf(bundle.wraps[0].wrapped_private_key, outsider.secretKey),
    ).rejects.toThrow();
  });
});

describe('signMutation + verifyMutation', () => {
  it('round-trips a signature through the org public key', async () => {
    const writer = generateHybridKemKeyPair();
    const bundle = await generateAndWrapSigningKey('org-1', [
      { userId: 'u1', publicKeyB64: bytesToBase64(writer.publicKey) },
    ]);

    const privateKey = await unwrapSigningKeyForSelf(
      bundle.wraps[0].wrapped_private_key,
      writer.secretKey,
    );

    const payload = new TextEncoder().encode('tx:abcdef:ciphertext');
    const { signature_b64, key_version } = signMutation(payload, {
      privateKeyBytes: privateKey,
      keyVersion: bundle.keyVersion,
    });

    expect(key_version).toBe(1);
    expect(verifyMutation(payload, signature_b64, bundle.publicKeyB64)).toBe(true);
  });

  it('returns false for a tampered payload', async () => {
    const writer = generateHybridKemKeyPair();
    const bundle = await generateAndWrapSigningKey('org-1', [
      { userId: 'u1', publicKeyB64: bytesToBase64(writer.publicKey) },
    ]);
    const privateKey = await unwrapSigningKeyForSelf(
      bundle.wraps[0].wrapped_private_key,
      writer.secretKey,
    );

    const payload = new TextEncoder().encode('original');
    const { signature_b64 } = signMutation(payload, {
      privateKeyBytes: privateKey,
      keyVersion: bundle.keyVersion,
    });

    const tampered = new TextEncoder().encode('tampered');
    expect(verifyMutation(tampered, signature_b64, bundle.publicKeyB64)).toBe(false);
  });

  it('returns false for a malformed signature (never throws)', async () => {
    const writer = generateHybridKemKeyPair();
    const bundle = await generateAndWrapSigningKey('org-1', [
      { userId: 'u1', publicKeyB64: bytesToBase64(writer.publicKey) },
    ]);

    const payload = new TextEncoder().encode('anything');
    expect(verifyMutation(payload, '!!!not-base64!!!', bundle.publicKeyB64)).toBe(false);
    expect(verifyMutation(payload, bytesToBase64(new Uint8Array(10)), bundle.publicKeyB64)).toBe(
      false,
    );
  });
});
