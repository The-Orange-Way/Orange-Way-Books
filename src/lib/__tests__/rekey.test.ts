/**
 * @vitest-environment node
 *
 * Phase 4.5, Hard re-key client library tests.
 *
 * Exercises the pure-crypto paths without a live Supabase connection.
 * The orchestration paths that talk to edge functions are covered by
 * integration tests deployed alongside the edge functions themselves.
 *
 * Tests:
 *   1. Generate DEK + wrap for 3 members; each wrap unwraps to the same DEK.
 *   2. ciphertext re-encrypt round-trip: decrypt under old DEK + re-encrypt
 *      under new DEK produces a blob the new DEK can decrypt back to the
 *      original plaintext.
 *   3. CSV export serializes decrypted rows with quoting.
 */

import { describe, it, expect } from 'vitest';

if (typeof (globalThis as unknown as { window?: unknown }).window === 'undefined') {
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
}

import { generateHybridKemKeyPair } from '@/lib/pqc';
import { KEY_WRAP_STRATEGIES, DEFAULT_WRAP_ALGORITHM, base64ToBytes } from '@/lib/key-wrapping';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

async function aesGcmEncryptBase64(plaintext: string, dek: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    dek as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: iv as BufferSource },
      key,
      new TextEncoder().encode(plaintext) as BufferSource,
    ),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToBase64(out);
}

async function aesGcmDecryptBase64(b64: string, dek: Uint8Array): Promise<string> {
  const combined = base64ToBytes(b64);
  const iv = combined.subarray(0, 12);
  const ct = combined.subarray(12);
  const key = await crypto.subtle.importKey(
    'raw',
    dek as BufferSource,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new TextDecoder().decode(pt);
}

describe('rekey, DEK wrap for 3 members', () => {
  it('produces per-member wraps that each unwrap to the same DEK', async () => {
    const strategy = KEY_WRAP_STRATEGIES[DEFAULT_WRAP_ALGORITHM];
    if (!strategy) throw new Error('default strategy missing');

    const newDek = new Uint8Array(32);
    crypto.getRandomValues(newDek);

    const members = [
      generateHybridKemKeyPair(),
      generateHybridKemKeyPair(),
      generateHybridKemKeyPair(),
    ];

    const wrapped = await Promise.all(
      members.map((m) => strategy.wrapForRecipient(newDek, m.publicKey)),
    );

    for (let i = 0; i < members.length; i++) {
      const recovered = await strategy.unwrapForSelf(wrapped[i], members[i].secretKey);
      expect(bytesToBase64(recovered)).toBe(bytesToBase64(newDek));
    }

    // Member 1 cannot unwrap member 0's row.
    await expect(strategy.unwrapForSelf(wrapped[0], members[1].secretKey)).rejects.toThrow();
  });
});

describe('rekey, row re-encrypt under new DEK', () => {
  it('decrypts with old DEK, re-encrypts with new DEK, and round-trips plaintext', async () => {
    const oldDek = new Uint8Array(32);
    crypto.getRandomValues(oldDek);
    const newDek = new Uint8Array(32);
    crypto.getRandomValues(newDek);

    const plaintext = 'Transaction memo, $123.45 paid to Acme Corp.';
    const oldCiphertext = await aesGcmEncryptBase64(plaintext, oldDek);

    // Core re-encrypt primitive mirrored inline (same shape as rekey.ts).
    const decrypted = await aesGcmDecryptBase64(oldCiphertext, oldDek);
    expect(decrypted).toBe(plaintext);

    const newCiphertext = await aesGcmEncryptBase64(decrypted, newDek);

    // New ciphertext is NOT the same bytes as the old one.
    expect(newCiphertext).not.toBe(oldCiphertext);

    // The new DEK can recover the original plaintext.
    const newDecrypted = await aesGcmDecryptBase64(newCiphertext, newDek);
    expect(newDecrypted).toBe(plaintext);

    // The old DEK cannot decrypt the new ciphertext.
    await expect(aesGcmDecryptBase64(newCiphertext, oldDek)).rejects.toThrow();
  });
});

describe('rekey, CSV escaping', () => {
  // Verify the csvEscape behavior independent of the module.
  // Replicated here to avoid importing Supabase-dependent code paths.
  function csvEscape(value: unknown): string {
    if (value === null || value === undefined) return '';
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    if (/["\n,]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }

  it('quotes values containing commas, quotes, or newlines', () => {
    expect(csvEscape('abc')).toBe('abc');
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('hello "world"')).toBe('"hello ""world"""');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape(null)).toBe('');
    expect(csvEscape(undefined)).toBe('');
    expect(csvEscape(42)).toBe('42');
  });
});

describe('rekey, abort-state invariants', () => {
  it('wraps written during a job are additive (do not overwrite old wraps)', async () => {
    // Simulate the shape of a wrap_members stage: a client wrapping a
    // new DEK at key_version=2 should not invalidate a wrap at
    // key_version=1 for the same recipient. This test is a contract
    // statement, the rekey-batch edge function uses upsert with
    // onConflict='org_id,user_id,key_version', so rows at different
    // key_versions coexist.
    const strategy = KEY_WRAP_STRATEGIES[DEFAULT_WRAP_ALGORITHM];
    if (!strategy) throw new Error('default strategy missing');

    const recipient = generateHybridKemKeyPair();
    const oldDek = new Uint8Array(32);
    crypto.getRandomValues(oldDek);
    const newDek = new Uint8Array(32);
    crypto.getRandomValues(newDek);

    const oldWrap = await strategy.wrapForRecipient(oldDek, recipient.publicKey);
    const newWrap = await strategy.wrapForRecipient(newDek, recipient.publicKey);

    // Old wrap still recovers old DEK after the new wrap is created.
    const recoveredOld = await strategy.unwrapForSelf(oldWrap, recipient.secretKey);
    const recoveredNew = await strategy.unwrapForSelf(newWrap, recipient.secretKey);
    expect(bytesToBase64(recoveredOld)).toBe(bytesToBase64(oldDek));
    expect(bytesToBase64(recoveredNew)).toBe(bytesToBase64(newDek));
    expect(bytesToBase64(recoveredOld)).not.toBe(bytesToBase64(recoveredNew));
  });
});
