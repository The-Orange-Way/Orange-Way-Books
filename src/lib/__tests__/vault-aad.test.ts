/**
 * @vitest-environment node
 *
 * OWB-T0092 — AEAD binding primitive unit tests.
 *
 * These exercise `buildVaultAad` / `encryptTextBound` / `decryptTextBound`
 * in `vault.ts` directly, independent of any call site. The call-site
 * proof (a real column transplanted at the storage layer) lives in
 * `vault-keypair.test.ts`; this file is about the primitive itself.
 */

import { describe, it, expect } from 'vitest';

// vault.ts reaches for `window.crypto` to match the rest of the app. Under
// the "node" environment there is no `window`. Point it at `globalThis` so
// WebCrypto resolves to node's built-in implementation. Local to this file,
// matching the convention in vault-keypair.test.ts.
if (typeof (globalThis as unknown as { window?: unknown }).window === 'undefined') {
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
}

import {
  buildVaultAad,
  encryptTextBound,
  decryptTextBound,
  encryptText,
  VAULT_AAD_DOMAIN,
  BOUND_ENVELOPE_PREFIX,
} from '@/lib/vault';

async function freshAesKey(): Promise<CryptoKey> {
  return window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
}

describe('vault — buildVaultAad', () => {
  it('produces the documented frame, domain "owb" for this repo', () => {
    const aad = buildVaultAad({
      table: 'user_vault_keys',
      column: 'encrypted_private_key',
      rowId: 'abc-123',
    });
    const text = new TextDecoder().decode(aad);
    expect(text).toBe('owb/v1|public.user_vault_keys|encrypted_private_key|abc-123');
    expect(VAULT_AAD_DOMAIN).toBe('owb');
  });

  it('honors an explicit schema', () => {
    const aad = buildVaultAad({
      schema: 'internal',
      table: 't',
      column: 'c',
      rowId: 'r',
    });
    expect(new TextDecoder().decode(aad)).toBe('owb/v1|internal.t|c|r');
  });

  it('throws if table, column or rowId is missing', () => {
    expect(() => buildVaultAad({ table: '', column: 'c', rowId: 'r' })).toThrow();
    expect(() => buildVaultAad({ table: 't', column: '', rowId: 'r' })).toThrow();
    expect(() => buildVaultAad({ table: 't', column: 'c', rowId: '' })).toThrow();
  });
});

describe('vault — encryptTextBound / decryptTextBound', () => {
  it('round-trips under a matching AAD', async () => {
    const key = await freshAesKey();
    const aad = buildVaultAad({
      table: 'journal_entry_lines',
      column: 'encrypted_debit',
      rowId: 'row-1',
    });
    const sealed = await encryptTextBound('42.00', key, aad);
    expect(sealed.startsWith(BOUND_ENVELOPE_PREFIX)).toBe(true);
    const opened = await decryptTextBound(sealed, key, aad);
    expect(opened).toBe('42.00');
  });

  it('OWB-T0092 acceptance #2: rejects a ciphertext presented under a different row id', async () => {
    const key = await freshAesKey();
    const slotA = buildVaultAad({
      table: 'journal_entry_lines',
      column: 'encrypted_debit',
      rowId: 'row-A',
    });
    const slotB = buildVaultAad({
      table: 'journal_entry_lines',
      column: 'encrypted_debit',
      rowId: 'row-B',
    });
    const sealed = await encryptTextBound('sealed-under-row-A', key, slotA);
    await expect(decryptTextBound(sealed, key, slotB)).rejects.toThrow();
  });

  it('rejects a ciphertext presented under a different column of the same row', async () => {
    const key = await freshAesKey();
    const debit = buildVaultAad({
      table: 'journal_entry_lines',
      column: 'encrypted_debit',
      rowId: 'row-1',
    });
    const credit = buildVaultAad({
      table: 'journal_entry_lines',
      column: 'encrypted_credit',
      rowId: 'row-1',
    });
    const sealed = await encryptTextBound('100.00', key, debit);
    // This is the concrete threat model from OWB-T0092: swapping debit and
    // credit on the same row must not decrypt, or a ledger entry's sign
    // could be inverted undetected.
    await expect(decryptTextBound(sealed, key, credit)).rejects.toThrow();
  });

  it('OWB-T0092 acceptance #4: legacy (pre-change, unbound) ciphertext still opens', async () => {
    const key = await freshAesKey();
    // encryptText is the original, unbound primitive — this is exactly
    // what a row written before this change looks like at rest.
    const legacy = await encryptText('written-before-owb-t0092', key);
    expect(legacy.startsWith(BOUND_ENVELOPE_PREFIX)).toBe(false);
    const aad = buildVaultAad({ table: 'anything', column: 'anything', rowId: 'anything' });
    // decryptTextBound must fall back to the unbound path when the
    // envelope carries no BOUND_ENVELOPE_PREFIX, regardless of the AAD
    // the caller now computes for this column.
    const opened = await decryptTextBound(legacy, key, aad);
    expect(opened).toBe('written-before-owb-t0092');
  });
});
