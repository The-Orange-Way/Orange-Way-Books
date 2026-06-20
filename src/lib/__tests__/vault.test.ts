/**
 * Tests for the V1 vault strategy and the strategy dispatcher.
 */
import { describe, it, expect } from 'vitest';
import {
  deriveVaultV1Kek,
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

const PASSWORD = 'correct-horse-battery-staple-1';
const WRONG_PASSWORD = 'different-password-99999';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('vault.ts:constants', () => {
  it('LATEST_VAULT_KEY_VERSION is 1 (post-collapse)', () => {
    expect(LATEST_VAULT_KEY_VERSION).toBe(1);
  });

  it('MIN_VAULT_PASSWORD_LENGTH is 14 (OWASP 2023)', () => {
    expect(MIN_VAULT_PASSWORD_LENGTH).toBe(14);
  });

  it('the strategy registry has exactly one entry (V1)', () => {
    expect(Object.keys(KEY_DERIVATION_STRATEGIES_WITH_SALT)).toEqual(['1']);
    expect(KEY_DERIVATION_STRATEGIES_WITH_SALT[1]).toBe(deriveVaultV1Kek);
  });
});

describe('vault.ts:V1 verifier round-trip', () => {
  it('createVaultVerifier + verifyVaultPassword agree on a correct password', async () => {
    const salt = generateVaultSalt();
    const verifier = await createVaultVerifier(PASSWORD, USER_ID, salt);
    const ok = await verifyVaultPassword(PASSWORD, USER_ID, verifier, salt);
    expect(ok).toBe(true);
  });

  it('verifyVaultPassword returns false for the wrong password', async () => {
    const salt = generateVaultSalt();
    const verifier = await createVaultVerifier(PASSWORD, USER_ID, salt);
    const ok = await verifyVaultPassword(WRONG_PASSWORD, USER_ID, verifier, salt);
    expect(ok).toBe(false);
  });

  it('verifyVaultPassword returns false when the salt has changed', async () => {
    const saltA = generateVaultSalt();
    const saltB = generateVaultSalt();
    const verifier = await createVaultVerifier(PASSWORD, USER_ID, saltA);
    const ok = await verifyVaultPassword(PASSWORD, USER_ID, verifier, saltB);
    expect(ok).toBe(false);
  });
});

describe('deriveKeyForVersion dispatch', () => {
  it('routes V1 through the registered strategy', async () => {
    const salt = generateVaultSalt();
    const viaDispatch = await deriveKeyForVersion(PASSWORD, USER_ID, salt, 1);
    const viaDirect = await deriveVaultV1Kek(PASSWORD, USER_ID, salt);
    // We can't compare CryptoKey objects directly; round-trip a known
    // plaintext through one and decrypt with the other.
    const ct = await encryptText('round-trip', viaDispatch);
    const pt = await decryptText(ct, viaDirect);
    expect(pt).toBe('round-trip');
  });

  it('rejects unknown versions', async () => {
    const salt = generateVaultSalt();
    await expect(deriveKeyForVersion(PASSWORD, USER_ID, salt, 99)).rejects.toThrow(/Unsupported/);
  });

  it('rejects calls without a per-org salt', async () => {
    await expect(deriveKeyForVersion(PASSWORD, USER_ID, null, 1)).rejects.toThrow(/per-org salt/);
  });
});
