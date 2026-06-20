/**
 * @vitest-environment node
 *
 * Phase 4.3 — invite-wrap pipeline tests.
 *
 * Exercises the wrap/unwrap round-trip using the same hybrid-KEM
 * primitives the production invite flow uses. Verifies:
 *
 *   1. `wrapOrgDekForRecipient` produces a payload whose `wrapped_dek`
 *      base64 unwraps to the exact org DEK the Owner passed in.
 *   2. The recipient's own secret key is what unwraps it — a different
 *      secret key throws.
 *   3. `generatePlaceholderOrgDek` returns distinct 32-byte keys (no
 *      accidental constant output under test conditions).
 *
 * The real Supabase `lookupRecipientPublicKey` path is covered by
 * integration in the invite-org-member edge function; this suite stays
 * pure-crypto so it runs fast and has no network dependencies.
 */

import { describe, it, expect } from 'vitest';

// OWB crypto helpers look up `window.crypto`; node's test env exposes
// only `globalThis.crypto`. Alias once at module load so downstream
// imports resolve cleanly.
if (typeof (globalThis as unknown as { window?: unknown }).window === 'undefined') {
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
}

import { wrapOrgDekForRecipient, generatePlaceholderOrgDek } from '@/lib/invite-wrap';
import { KEY_WRAP_STRATEGIES, base64ToBytes } from '@/lib/key-wrapping';
import { generateHybridKemKeyPair } from '@/lib/pqc';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

describe('generatePlaceholderOrgDek', () => {
  it('returns a 32-byte key', () => {
    const dek = generatePlaceholderOrgDek();
    expect(dek).toBeInstanceOf(Uint8Array);
    expect(dek.length).toBe(32);
  });

  it('returns distinct keys on each call', () => {
    const a = generatePlaceholderOrgDek();
    const b = generatePlaceholderOrgDek();
    // All 32 bytes identical would be a 1-in-2^256 coincidence.
    expect(bytesToBase64(a)).not.toBe(bytesToBase64(b));
  });
});

describe('wrapOrgDekForRecipient', () => {
  it('produces a payload the recipient can unwrap back to the input DEK', async () => {
    const recipient = generateHybridKemKeyPair();
    const orgDek = generatePlaceholderOrgDek();

    const payload = await wrapOrgDekForRecipient(orgDek, bytesToBase64(recipient.publicKey));

    expect(payload.wrap_algo).toBe('hybrid-x25519-mlkem768');
    expect(typeof payload.wrapped_dek).toBe('string');
    expect(typeof payload.iv).toBe('string');

    // Unwrap with the recipient's own secret key and confirm round-trip.
    const strategy = KEY_WRAP_STRATEGIES[payload.wrap_algo];
    expect(strategy).toBeDefined();
    const wrapped = base64ToBytes(payload.wrapped_dek);
    const unwrapped = await strategy.unwrapForSelf(wrapped, recipient.secretKey);
    expect(bytesToBase64(unwrapped)).toBe(bytesToBase64(orgDek));
  });

  it('rejects an incorrect DEK length', async () => {
    const recipient = generateHybridKemKeyPair();
    const tooShort = new Uint8Array(16);
    crypto.getRandomValues(tooShort);
    await expect(
      wrapOrgDekForRecipient(tooShort, bytesToBase64(recipient.publicKey)),
    ).rejects.toThrow(/32 bytes/);
  });

  it('rejects a malformed base64 recipient public key', async () => {
    const orgDek = generatePlaceholderOrgDek();
    await expect(wrapOrgDekForRecipient(orgDek, '!!!not-base64!!!')).rejects.toThrow();
  });

  it('throws when a third party tries to unwrap', async () => {
    const intendedRecipient = generateHybridKemKeyPair();
    const eavesdropper = generateHybridKemKeyPair();
    const orgDek = generatePlaceholderOrgDek();

    const payload = await wrapOrgDekForRecipient(
      orgDek,
      bytesToBase64(intendedRecipient.publicKey),
    );

    const strategy = KEY_WRAP_STRATEGIES[payload.wrap_algo];
    const wrapped = base64ToBytes(payload.wrapped_dek);
    // ML-KEM "fails" by deriving a different shared secret which makes
    // AES-GCM decryption fail. We only assert the unwrap rejects — not
    // the exact error message — because KEM failure modes are noisy.
    await expect(strategy.unwrapForSelf(wrapped, eavesdropper.secretKey)).rejects.toThrow();
  });
});
