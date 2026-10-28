/**
 * Vault material for an additional organization created from Settings.
 *
 * Every organization carries its own vault in org_settings: a random MEK,
 * wrapped once by the password-derived KEK (per-org salt) and once by a
 * 12-word recovery code. VaultContext unlocks whichever org is active from
 * that org's own row, so a new org needs the same material onboarding
 * writes, built WITHOUT replacing the key of the org that is open now.
 *
 * Unlike VaultContext.setupVault this has no side effects: it never touches
 * the in-memory key of the current session. The caller encrypts the new
 * org's fields with the returned key, persists the material through
 * create_org_for_current_user, and shows recoveryCode to the user once.
 */
import {
  LATEST_VAULT_KEY_VERSION,
  createVaultVerifier,
  deriveRecoveryKek,
  deriveVaultV1Kek,
  encryptText,
  generateMekBytes,
  generateRecoveryCode,
  generateVaultSalt,
  importAesGcmKey,
  wrapMekWithKey,
} from '@/lib/vault';

export interface NewOrgVault {
  verifier: string;
  vaultSalt: string;
  vaultKeyVersion: number;
  encMekCiphertext: string;
  recoveryCiphertext: string;
  recoveryCode: string;
  /** Encrypts with the NEW org's MEK. Use it for every field of the new org. */
  encryptForNewOrg: (plaintext: string) => Promise<string>;
}

export async function buildNewOrgVault(password: string, userId: string): Promise<NewOrgVault> {
  if (!password) throw new Error('Vault password is required');
  if (!userId) throw new Error('User id is required');

  const vaultSalt = generateVaultSalt();
  const kek = await deriveVaultV1Kek(password, userId, vaultSalt);
  const mekRaw = generateMekBytes();
  const mek = await importAesGcmKey(mekRaw);

  const recoveryCode = generateRecoveryCode();
  const recoveryKek = await deriveRecoveryKek(recoveryCode);

  const [encMekCiphertext, verifier, recoveryCiphertext] = await Promise.all([
    wrapMekWithKey(mekRaw, kek),
    createVaultVerifier(password, userId, vaultSalt, LATEST_VAULT_KEY_VERSION),
    wrapMekWithKey(mekRaw, recoveryKek),
  ]);
  mekRaw.fill(0);

  return {
    verifier,
    vaultSalt,
    vaultKeyVersion: LATEST_VAULT_KEY_VERSION,
    encMekCiphertext,
    recoveryCiphertext,
    recoveryCode,
    encryptForNewOrg: (plaintext: string) => encryptText(plaintext, mek),
  };
}
