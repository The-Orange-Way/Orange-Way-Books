/**
 * Tests for the v3 Argon2id KDF and the strategy map. Separate from the
 * existing src/test/vault.test.ts so the two files can be reasoned about
 * independently (v1/v2 primitives vs v3 + dispatch layer).
 */
import { describe, it, expect } from 'vitest';
import {
  deriveKey,
  deriveKeyV2,
  deriveKeyV3,
  deriveKeyForVersion,
  generateVaultSalt,
  encryptText,
  decryptText,
  createVaultVerifier,
  verifyVaultPassword,
  KEY_DERIVATION_STRATEGIES_WITH_SALT,
  LATEST_VAULT_KEY_VERSION,
  MIN_VAULT_PASSWORD_LENGTH,
} from '@/lib/vault';

const PASSWORD = 'correct-horse-battery-staple';
const WRONG_PASSWORD = 'different-password-99999';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('vault v3 — configuration', () => {
  it('minimum password length is 14 (setup-path minimum)', () => {
    expect(MIN_VAULT_PASSWORD_LENGTH).toBe(14);
  });

  it('latest key version is 4', () => {
    expect(LATEST_VAULT_KEY_VERSION).toBe(4);
  });

  it('strategies map exposes v2 and v3 — extension point for future KDFs', () => {
    expect(KEY_DERIVATION_STRATEGIES_WITH_SALT[2]).toBe(deriveKeyV2);
    expect(KEY_DERIVATION_STRATEGIES_WITH_SALT[3]).toBe(deriveKeyV3);
    // Adding v4 should be one entry here and a new derive function —
    // zero edits to v2/v3 code paths (OCP).
  });
});

describe('vault v3 — Argon2id round-trip', () => {
  it('derives a key, encrypts a string, and decrypts it back', async () => {
    const salt = generateVaultSalt();
    const key = await deriveKeyV3(PASSWORD, USER_ID, salt);
    const plaintext = 'hello argon2id';
    const ct = await encryptText(plaintext, key);
    const back = await decryptText(ct, key);
    expect(back).toBe(plaintext);
  }, 30_000);

  it('same salt + password produces a key that can decrypt its own output', async () => {
    const salt = generateVaultSalt();
    const k1 = await deriveKeyV3(PASSWORD, USER_ID, salt);
    const k2 = await deriveKeyV3(PASSWORD, USER_ID, salt);
    const ct = await encryptText('cross-device', k1);
    const back = await decryptText(ct, k2);
    expect(back).toBe('cross-device');
  }, 30_000);

  it('different passwords produce keys that cannot decrypt each other', async () => {
    const salt = generateVaultSalt();
    const kRight = await deriveKeyV3(PASSWORD, USER_ID, salt);
    const kWrong = await deriveKeyV3(WRONG_PASSWORD, USER_ID, salt);
    const ct = await encryptText('secret', kRight);
    await expect(decryptText(ct, kWrong)).rejects.toBeDefined();
  }, 30_000);

  it('rejects a tampered ciphertext via AES-GCM auth tag', async () => {
    const salt = generateVaultSalt();
    const key = await deriveKeyV3(PASSWORD, USER_ID, salt);
    const ct = await encryptText('sensitive', key);
    // Flip a single bit in the ciphertext body (past the 12-byte IV) so
    // GCM authentication fails.
    const raw = Uint8Array.from(atob(ct), (c) => c.charCodeAt(0));
    raw[20] ^= 0x01; // somewhere inside the ciphertext
    const tampered = btoa(String.fromCharCode(...raw));
    await expect(decryptText(tampered, key)).rejects.toBeDefined();
  }, 30_000);

  it('enforces minimum length at the crypto boundary', async () => {
    const salt = generateVaultSalt();
    await expect(deriveKeyV3('short', USER_ID, salt)).rejects.toThrow(/at least 14/);
  });

  it('rejects an empty salt', async () => {
    await expect(deriveKeyV3(PASSWORD, USER_ID, '')).rejects.toThrow(/orgSaltB64/);
  });
});

describe('vault v3 — verifier round-trip', () => {
  it('createVaultVerifier + verifyVaultPassword agree on a correct password', async () => {
    const salt = generateVaultSalt();
    const verifier = await createVaultVerifier(PASSWORD, USER_ID, salt, 3);
    const ok = await verifyVaultPassword(PASSWORD, USER_ID, verifier, salt, 3);
    expect(ok).toBe(true);
  }, 30_000);

  it('verifyVaultPassword returns false for the wrong password', async () => {
    const salt = generateVaultSalt();
    const verifier = await createVaultVerifier(PASSWORD, USER_ID, salt, 3);
    const ok = await verifyVaultPassword(WRONG_PASSWORD, USER_ID, verifier, salt, 3);
    expect(ok).toBe(false);
  }, 30_000);

  it('verifyVaultPassword returns false when the salt has changed (salt mismatch)', async () => {
    const saltA = generateVaultSalt();
    const saltB = generateVaultSalt();
    const verifier = await createVaultVerifier(PASSWORD, USER_ID, saltA, 3);
    const ok = await verifyVaultPassword(PASSWORD, USER_ID, verifier, saltB, 3);
    expect(ok).toBe(false);
  }, 30_000);
});

describe('deriveKeyForVersion — dispatch', () => {
  it('routes v1 to the deterministic-salt derivation (no orgSalt required)', async () => {
    // Not a strict functional equality, but confirm the call succeeds and
    // produces a key that matches deriveKey's output for the same inputs.
    const viaDispatch = await deriveKeyForVersion(PASSWORD, USER_ID, null, 1);
    const viaDirect = await deriveKey(PASSWORD, USER_ID);
    const ct = await encryptText('v1-dispatch', viaDirect);
    const back = await decryptText(ct, viaDispatch);
    expect(back).toBe('v1-dispatch');
  });

  it('routes v2 to deriveKeyV2', async () => {
    const salt = generateVaultSalt();
    const viaDispatch = await deriveKeyForVersion(PASSWORD, USER_ID, salt, 2);
    const viaDirect = await deriveKeyV2(PASSWORD, USER_ID, salt);
    const ct = await encryptText('v2-dispatch', viaDirect);
    expect(await decryptText(ct, viaDispatch)).toBe('v2-dispatch');
  });

  it('routes v3 to deriveKeyV3', async () => {
    const salt = generateVaultSalt();
    const viaDispatch = await deriveKeyForVersion(PASSWORD, USER_ID, salt, 3);
    const viaDirect = await deriveKeyV3(PASSWORD, USER_ID, salt);
    const ct = await encryptText('v3-dispatch', viaDirect);
    expect(await decryptText(ct, viaDispatch)).toBe('v3-dispatch');
  }, 30_000);

  it('throws for an unknown version', async () => {
    const salt = generateVaultSalt();
    await expect(deriveKeyForVersion(PASSWORD, USER_ID, salt, 99)).rejects.toThrow(/Unsupported/);
  });

  it('v2/v3 require a per-org salt', async () => {
    await expect(deriveKeyForVersion(PASSWORD, USER_ID, null, 2)).rejects.toThrow(/per-org salt/);
    await expect(deriveKeyForVersion(PASSWORD, USER_ID, null, 3)).rejects.toThrow(/per-org salt/);
  });
});
