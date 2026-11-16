/**
 * Tests for buildNewOrgVault: the vault material written for an additional org.
 */
import { describe, it, expect } from 'vitest';
import { buildNewOrgVault } from '@/lib/new-org-vault';
import {
  decryptText,
  deriveRecoveryKek,
  deriveVaultV1Kek,
  importAesGcmKey,
  LATEST_VAULT_KEY_VERSION,
  unwrapMekWithKey,
  verifyVaultPassword,
} from '@/lib/vault';

const PASSWORD = 'correct-horse-battery-staple-1';
const WRONG_PASSWORD = 'different-password-99999';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_USER_ID = 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee';

/** Decrypt a field with the MEK unwrapped from the stored material. */
async function decryptWithUnwrapped(wrapped: string, wrappingKey: CryptoKey, field: string) {
  const mek = await importAesGcmKey(await unwrapMekWithKey(wrapped, wrappingKey));
  return decryptText(field, mek);
}

describe('buildNewOrgVault', () => {
  it('the password key unwraps the MEK that encryptForNewOrg uses', async () => {
    const v = await buildNewOrgVault(PASSWORD, USER_ID);
    const field = await v.encryptForNewOrg('Acme Ltd');
    const kek = await deriveVaultV1Kek(PASSWORD, USER_ID, v.vaultSalt);
    await expect(decryptWithUnwrapped(v.encMekCiphertext, kek, field)).resolves.toBe('Acme Ltd');
  });

  it('the recovery code unwraps the same MEK', async () => {
    const v = await buildNewOrgVault(PASSWORD, USER_ID);
    const field = await v.encryptForNewOrg('Acme Ltd');
    const rkek = await deriveRecoveryKek(v.recoveryCode);
    await expect(decryptWithUnwrapped(v.recoveryCiphertext, rkek, field)).resolves.toBe('Acme Ltd');
  });

  it('both wrappings hold identical MEK bytes', async () => {
    const v = await buildNewOrgVault(PASSWORD, USER_ID);
    const a = await unwrapMekWithKey(
      v.encMekCiphertext,
      await deriveVaultV1Kek(PASSWORD, USER_ID, v.vaultSalt),
    );
    const b = await unwrapMekWithKey(v.recoveryCiphertext, await deriveRecoveryKek(v.recoveryCode));
    expect(a).toHaveLength(32);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('the verifier accepts the password and refuses a wrong one', async () => {
    const v = await buildNewOrgVault(PASSWORD, USER_ID);
    expect(v.vaultKeyVersion).toBe(LATEST_VAULT_KEY_VERSION);
    await expect(
      verifyVaultPassword(PASSWORD, USER_ID, v.verifier, v.vaultSalt, v.vaultKeyVersion),
    ).resolves.toBe(true);
    await expect(
      verifyVaultPassword(WRONG_PASSWORD, USER_ID, v.verifier, v.vaultSalt, v.vaultKeyVersion),
    ).resolves.toBe(false);
    await expect(
      verifyVaultPassword(PASSWORD, OTHER_USER_ID, v.verifier, v.vaultSalt, v.vaultKeyVersion),
    ).resolves.toBe(false);
  });

  it('a wrong password or another org key cannot unwrap or decrypt', async () => {
    const v = await buildNewOrgVault(PASSWORD, USER_ID);
    const other = await buildNewOrgVault(PASSWORD, USER_ID);
    const field = await v.encryptForNewOrg('Acme Ltd');

    const wrongKek = await deriveVaultV1Kek(WRONG_PASSWORD, USER_ID, v.vaultSalt);
    await expect(unwrapMekWithKey(v.encMekCiphertext, wrongKek)).rejects.toThrow();

    // Same password, but the other org has its own salt and MEK.
    const otherKek = await deriveVaultV1Kek(PASSWORD, USER_ID, other.vaultSalt);
    await expect(decryptWithUnwrapped(other.encMekCiphertext, otherKek, field)).rejects.toThrow();
    await expect(
      unwrapMekWithKey(v.recoveryCiphertext, await deriveRecoveryKek(other.recoveryCode)),
    ).rejects.toThrow();
  });

  it('each new org gets fresh salt, MEK and recovery code', async () => {
    const a = await buildNewOrgVault(PASSWORD, USER_ID);
    const b = await buildNewOrgVault(PASSWORD, USER_ID);
    expect(a.vaultSalt).not.toBe(b.vaultSalt);
    expect(a.recoveryCode).not.toBe(b.recoveryCode);
    // Ciphertexts always differ (random IV), so compare the unwrapped key bytes.
    const mekA = await unwrapMekWithKey(
      a.recoveryCiphertext,
      await deriveRecoveryKek(a.recoveryCode),
    );
    const mekB = await unwrapMekWithKey(
      b.recoveryCiphertext,
      await deriveRecoveryKek(b.recoveryCode),
    );
    expect(Array.from(mekA)).not.toEqual(Array.from(mekB));
  });

  it('refuses an empty password or user id', async () => {
    await expect(buildNewOrgVault('', USER_ID)).rejects.toThrow('Vault password is required');
    await expect(buildNewOrgVault(PASSWORD, '')).rejects.toThrow('User id is required');
  });
});
