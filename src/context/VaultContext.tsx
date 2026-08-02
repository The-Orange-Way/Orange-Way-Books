/**
 * VaultContext — manages the vault unlock state and provides encrypt/decrypt functions.
 *
 * The Master Encryption Key (MEK) is stored as a non-extractable CryptoKey in a ref.
 * It never touches localStorage, sessionStorage, or any server.
 * Clearing the tab clears the key.
 */
import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { supabase } from '@/lib/supabase';
import {
  deriveKeyForVersion,
  generateVaultSalt,
  encryptText as cryptoEncrypt,
  decryptText as cryptoDecrypt,
  encryptBlob as cryptoEncryptBlob,
  decryptBlob as cryptoDecryptBlob,
  createVaultVerifier,
  verifyVaultPassword,
  LATEST_VAULT_KEY_VERSION,
  generateMekBytes,
  importAesGcmKey,
  wrapMekWithKey,
  unwrapMekWithKey,
  deriveVaultV1Kek,
  deriveBlindIndexKeyFromMek,
  deriveOrCredsKeyFromMek,
  deriveOrTxnsKeyFromMek,
  deriveOrMekBytes,
  generateRecoveryCode,
  deriveRecoveryKek,
  generateMasterRecoverySalt,
  deriveMasterRecoveryKek,
  createMasterRecoveryVerifier,
  verifyMasterRecoveryCode,
} from '@/lib/vault';
import { computeBlindIndex } from '@/lib/crypto-fields';
import { logSecurityEvent } from '@/lib/audit';
import {
  ensureUserKeypair,
  rewrapUserKeypair,
  importMekForHkdf,
  type SupabaseKeypairClient,
} from '@/lib/vault-keypair';
import {
  unwrapSigningKeyForSelf,
  signMutation as signingKeySignMutation,
  type SigningKeyHandle,
} from '@/lib/signing-key';
import { derivePqcSecretWrapKey } from '@/lib/key-derivation';
import { isCredentialError } from './vault-unlock-errors';
import { captureException } from '@/lib/observability/sentry';

interface VaultContextType {
  isUnlocked: boolean;
  unlock: (password: string) => Promise<void>;
  lock: () => void;
  encryptText: (plaintext: string) => Promise<string>;
  decryptText: (ciphertext: string) => Promise<string>;
  encryptBlob: (plaintext: ArrayBuffer | Uint8Array) => Promise<Blob>;
  decryptBlob: (ciphertext: Blob | ArrayBuffer) => Promise<ArrayBuffer>;
  // OrangeRails subkey helpers — used by the Connections page to encrypt
  // provider credentials, decrypt connection metadata, and hand keys
  // in-transit to OR's or-sync edge function via owb-or-proxy.
  encryptOrCipher: (plaintext: string) => Promise<string>;
  decryptOrCipher: (ciphertext: string) => Promise<string>;
  decryptOrTxnCipher: (ciphertext: string) => Promise<string>;
  exportOrCredsKey: () => Promise<string>;
  exportOrTxnsKey: () => Promise<string>;
  /**
   * First-time vault setup (v4). Returns verifier + salt + key material to
   * persist in org_settings, plus the recovery code to show the user once.
   */
  setupVault: (password: string) => Promise<{
    verifier: string;
    vaultSalt: string;
    vaultKeyVersion: number;
    encMekCiphertext: string;
    recoveryCiphertext: string;
    recoveryCode: string;
  }>;
  /**
   * Recover vault access using the 12-word recovery code. Unwraps the MEK,
   * re-wraps under newPassword, generates a fresh recovery code.
   * Caller must persist the returned fields to org_settings and show the new
   * recovery code to the user.
   */
  recoverWithCode(params: {
    recoveryCode: string;
    encMekCiphertext: string;
    recoveryCiphertext: string;
    orgSaltB64: string;
    userId: string;
    newPassword: string;
  }): Promise<{
    newEncMekCiphertext: string;
    newRecoveryCode: string;
    newRecoveryCiphertext: string;
    newVerifier: string;
  }>;
  /**
   * Compute a deterministic HMAC-SHA256 blind index for a plaintext value.
   * Only available for unlocked vaults (returns null otherwise or for
   * absent/empty values). Use this when writing hmac_* columns and when
   * building WHERE clauses to search encrypted fields.
   */
  blindIndex: (value: string | null | undefined) => Promise<string | null>;

  /**
   * Phase 4.4: load + unwrap the caller's Org Signing Key for the
   * active org. Must be called after unlock and before signing
   * mutations. Idempotent — a second call for the same org is a cheap
   * no-op (cached). Returns null when the caller has no signing-key wrap
   * (read-only roles like Auditor / Viewer), which is a legitimate
   * state and NOT an error.
   */
  loadOrgSigningKey: (orgId: string) => Promise<SigningKeyHandle | null>;
  /**
   * Phase 4.4: sign a mutation payload with the cached signing key for the
   * active org. Returns null when the caller has no signing-key wrap — the
   * call site should skip the signature columns (server-side trigger
   * accepts NULL for write_own paths and for service-role inserts).
   */
  signMutation: (
    payloadBytes: Uint8Array,
    orgId: string,
  ) => { signature_b64: string; key_version: number } | null;

  /**
   * Change the vault password. Re-wraps the MEK under the new password and
   * rotates the recovery code. The MEK itself is unchanged so all encrypted
   * data + blind index values remain valid.
   *
   * Caller must persist newEncMekCiphertext + newRecoveryCiphertext (+ new
   * verifier if keyVersion changed) to org_settings, and must show the new
   * recovery code to the user exactly once.
   */
  changeVaultPassword(params: {
    currentPassword: string;
    newPassword: string;
    orgSaltB64: string;
    encMekCiphertext: string;
    userId: string;
  }): Promise<{
    newEncMekCiphertext: string;
    newRecoveryCode: string;
    newRecoveryCiphertext: string;
    newVerifier: string;
  }>;

  /**
   * Rotate ONLY the recovery code, leaving the vault password and the
   * wrapped MEK unchanged. Requires the vault to be unlocked (uses the
   * in-memory MEK). Returns the new code (display once) and the new
   * recovery_ciphertext (persist to org_settings).
   *
   * The old recovery code is invalidated — any copy the user saved
   * before this call stops working immediately.
   */
  rotateRecoveryCode(): Promise<{
    newRecoveryCode: string;
    newRecoveryCiphertext: string;
  }>;

  /**
   * S14 — set up a per-user master recovery code that unlocks every
   * org the user is a member of. Caller persists masterSalt +
   * verifierCiphertext to public.user_master_recovery, and persists
   * currentOrgWrap to public.org_master_wraps for the active org.
   * Returns the new code for one-time display.
   */
  setupMasterRecoveryCode(): Promise<{
    newMasterCode: string;
    masterSalt: string;
    verifierCiphertext: string;
    currentOrgWrap: string;
  }>;

  /**
   * S14 — wrap the active org's MEK under an already-set-up master KEK.
   * For enrolling additional orgs into an existing master recovery
   * setup. Vault must be unlocked.
   */
  wrapCurrentOrgUnderMaster(masterCode: string, masterSaltB64: string): Promise<string>;

  /**
   * S14 — recover an org by using the master recovery code. Verifies
   * the code (via the user_master_recovery verifier), unwraps the
   * org's MEK from org_master_wraps, re-wraps it under a new password,
   * generates a fresh per-org recovery code, and leaves the vault
   * unlocked. Caller persists the returned ciphertexts to
   * org_settings.
   */
  recoverOrgWithMasterCode(params: {
    masterCode: string;
    masterSaltB64: string;
    verifierCiphertext: string;
    masterWrappedMek: string;
    orgSaltB64: string;
    userId: string;
    newPassword: string;
  }): Promise<{
    newEncMekCiphertext: string;
    newRecoveryCode: string;
    newRecoveryCiphertext: string;
    newVerifier: string;
  }>;
}

const VaultCtx = createContext<VaultContextType | null>(null);

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Phase 4.5: on Owner/Admin unlock, if this user has `users.invite`
 * AND the org's DEK is still the Phase 4.3 placeholder, silently kick
 * off a first-time-setup rotation. Skips if another writer in the org
 * already has an active job.
 *
 * Non-fatal: toast on success, toast on failure with a retry hint.
 * Imported dynamically so the rekey module is only loaded when needed.
 */
async function maybeFirstTimeSetup(
  userId: string,
  orgId: string,
  userEmail: string | null,
  decryptText: (ciphertext: string) => Promise<string>,
): Promise<void> {
  try {
    // Capability check — only Owners/Admins run first-time setup.
    const { data: canInvite } = await (
      supabase as unknown as {
        rpc: (
          name: string,
          args: Record<string, unknown>,
        ) => Promise<{ data: unknown; error: unknown }>;
      }
    ).rpc('user_has_capability', {
      p_user_id: userId,
      p_capability: 'users.invite',
      p_org_id: orgId,
    });
    if (!canInvite) return;

    // Is the current active DEK still the Phase 4.3 placeholder baseline?
    const { data: active } = await supabase
      .from('active_key_versions')
      .select('active_dek_key_version')
      .eq('org_id', orgId)
      .maybeSingle();
    const activeVer =
      (active as { active_dek_key_version?: number } | null)?.active_dek_key_version ?? 1;
    if (activeVer > 1) return; // Already rotated past baseline.

    // Probe: does the caller's own wrap exist AND is it a placeholder?
    const { data: wrap } = await supabase
      .from('org_keys')
      .select('is_placeholder')
      .eq('org_id', orgId)
      .eq('user_id', userId)
      .eq('key_version', activeVer)
      .maybeSingle();
    const isPlaceholder = (wrap as { is_placeholder?: boolean } | null)?.is_placeholder ?? false;
    if (!isPlaceholder) return;

    // Is another writer already running a job for this org?
    const { data: activeJob } = await supabase
      .from('key_rotation_jobs')
      .select('id')
      .eq('org_id', orgId)
      .not('status', 'in', '(complete,aborted,rolled_back)')
      .maybeSingle();
    if (activeJob) return;

    // Kick off. Import lazily so non-first-time-setup paths don't pay
    // the crypto-library load cost.
    const { startRekeyJob, runRekeyJob } = await import('@/lib/rekey');
    const { toast } = await import('sonner');
    try {
      // First-time setup uses Quick refresh — there's no existing real
      // shared DEK to re-encrypt under, so Deep's re-scramble isn't
      // applicable here.
      const { jobId } = await startRekeyJob(orgId, 'first_time_setup', 'quick');

      // Best-effort: decrypt the org name so the welcome email can
      // address the customer by name. Failure here is fine — the email
      // gets queued with a generic placeholder.
      let orgNameDecrypted = '';
      try {
        const { data: orgRow } = await supabase
          .from('organizations')
          .select('name')
          .eq('id', orgId)
          .maybeSingle();
        const encName = (orgRow as { name?: string } | null)?.name;
        if (encName) orgNameDecrypted = await decryptText(encName);
      } catch (err) {
        console.warn('[vault] could not decrypt org name for welcome email', err);
      }

      await runRekeyJob(jobId, {
        onComplete: () => {
          toast.success('One-time security setup completed in background', { duration: 4000 });
        },
        onAborted: (reason) => {
          toast.error(
            `Security setup couldn't finish: ${reason}. You can retry from Settings → Security.`,
            { duration: 8000 },
          );
        },
        onError: (err) => {
          console.warn('[vault] first-time-setup error:', err);
        },
        firstTimeSetupEmail:
          orgNameDecrypted && userEmail
            ? { orgNameDecrypted, recipientEmail: userEmail }
            : undefined,
      });
    } catch (err) {
      toast.error("Security setup couldn't finish. Please try again from Settings → Security.");
      console.warn('[vault] first-time-setup threw:', err);
    }
  } catch (err) {
    // Fail silently — first-time setup is optional. Next unlock retries.
    console.warn('[vault] maybeFirstTimeSetup probe failed', err);
  }
}

export function VaultProvider({ children }: { children: React.ReactNode }) {
  const [isUnlocked, setIsUnlocked] = useState(false);
  const keyRef = useRef<CryptoKey | null>(null);
  const blindIndexKeyRef = useRef<CryptoKey | null>(null);
  // OrangeRails subkeys, derived alongside the MEK at unlock.
  const orCredsKeyRef = useRef<CryptoKey | null>(null);
  const orTxnsKeyRef = useRef<CryptoKey | null>(null);
  // Phase 4.4: raw MEK bytes + salt kept so loadOrgSigningKey can
  // re-derive the pqc-secret-wrap subkey to unwrap user_vault_keys
  // lazily when an org is selected. Cleared on lock.
  const mekRawRef = useRef<Uint8Array | null>(null);
  const orgSaltRef = useRef<string | null>(null);
  // Phase 4.4: per-org signing-key cache. Cleared on lock. Populated lazily on
  // loadOrgSigningKey() calls from Admin / transaction call sites.
  const signingKeysRef = useRef<Map<string, SigningKeyHandle>>(new Map());

  const unlock = useCallback(async (password: string) => {
    // ── Pre-unlock guards (do NOT count toward rate limit) ────────────
    //
    // On a hard reload, the SPA mounts the unlock screen as soon as
    // `sessionLoaded` flips true in AuthGate, but Supabase's outgoing
    // HTTP client may not yet have flushed the rehydrated JWT into its
    // request headers. Wait for `getSession()` to resolve and assert a
    // non-null session before touching `org_settings`. The errors thrown
    // in this block are treated as "transient / not a password failure"
    // by the catch in the unlock-crypto stage below — they MUST NOT be
    // logged as `vault_unlock_failed`, otherwise a reload-induced flake
    // ticks the S10 sliding-window counter (see the bug fix referenced
    // in fix/vault-unlock-after-reload).
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.user) throw new Error('Session not yet ready — please try again.');
    const user = session.user;

    const stored = localStorage.getItem('orangewaybooks.active_org');
    const { data: memberships, error: membershipsErr } = await supabase
      .from('org_members')
      .select('org_id, joined_at')
      .eq('user_id', user.id)
      .order('joined_at', { ascending: true });
    if (membershipsErr) {
      // RLS / network failure — transient, do NOT log as a password failure.
      throw new Error('Could not load your organization. Please try again.');
    }

    const memberOrgIds = (memberships ?? []).map((m: any) => m.org_id as string);
    if (memberOrgIds.length === 0) throw new Error('No organization found for this user');

    const activeOrgId = stored && memberOrgIds.includes(stored) ? stored : memberOrgIds[0];

    const { data: settings, error: settingsErr } = await (supabase as any)
      .from('org_settings')
      .select('vault_verifier, vault_salt, vault_key_version, enc_mek_ciphertext')
      .eq('org_id', activeOrgId)
      .maybeSingle();
    if (settingsErr) {
      throw new Error('Could not load vault settings. Please try again.');
    }

    const verifier = (settings as any)?.vault_verifier;
    const orgSalt: string | null = (settings as any)?.vault_salt ?? null;
    const vaultKeyVersion: number = (settings as any)?.vault_key_version ?? 1;
    const encMekCiphertext: string | null = (settings as any)?.enc_mek_ciphertext ?? null;

    if (!verifier) throw new Error('Vault not set up for this organization');

    // ── Unlock-crypto stage (THIS is where password-failure tracking lives) ──
    //
    // We log `vault_unlock_failed` ONLY for actual password-derived crypto
    // failures inside this try block. Everything above (auth/network/RLS
    // and "no org" errors) is treated as transient and skipped, so the
    // S10 sliding-window cooldown only counts genuine wrong-password
    // attempts — never reload-induced flakes. (Cause-1 hardening for
    // the "C-G journey second-unlock fails" repro.)
    let passwordAttempted = false;
    try {
      if (!orgSalt || !encMekCiphertext) {
        throw new Error('Vault setup incomplete: missing salt or wrapped MEK');
      }
      // Derive KEK from password, unwrap random MEK, derive blind index
      // key from the MEK (so it's durable across password changes).
      passwordAttempted = true;
      const kek = await deriveVaultV1Kek(password, user.id, orgSalt);
      const mekRaw = await unwrapMekWithKey(encMekCiphertext, kek);
      const mek = await importAesGcmKey(mekRaw);
      const isValid = await verifyVaultPassword(
        password,
        user.id,
        verifier,
        orgSalt,
        vaultKeyVersion,
      );
      if (!isValid) throw new Error('Incorrect vault password');
      const blindIndexKey = await deriveBlindIndexKeyFromMek(mekRaw, orgSalt);
      keyRef.current = mek;
      blindIndexKeyRef.current = blindIndexKey;
      // Stash the raw MEK bytes + salt for on-demand signing-key unwrap.
      // These are the same bytes the vault already holds. We are not
      // creating new material, just retaining a handle for the
      // pqc-secret-wrap HKDF derivation. Cleared on lock().
      mekRawRef.current = mekRaw;
      orgSaltRef.current = orgSalt;

      // Make sure the user has a hybrid keypair published. Idempotent:
      // the row is written exactly once, on the unlock where it's still
      // missing. Failure MUST NOT block unlock; we swallow the rejection
      // and retry next time.
      try {
        const mekForHkdf = await importMekForHkdf(mekRaw);
        await ensureUserKeypair({
          userId: user.id,
          mek: mekForHkdf,
          saltB64: orgSalt,
          supabase: supabase as unknown as SupabaseKeypairClient,
        });
      } catch (e) {
        console.warn('[vault] ensureUserKeypair failed; retry next unlock', e);
      }

      // OrangeRails subkeys — derived from a separate Argon2id with a
      // stable salt prefix, so OR data survives vault version upgrades
      // and is consistent regardless of the vault's own MEK shape.
      // Requires orgSalt; v1 vaults without orgSalt skip OR support.
      if (orgSalt) {
        const orMekBytes = await deriveOrMekBytes(password, user.id, orgSalt);
        const orCredsKey = await deriveOrCredsKeyFromMek(orMekBytes, orgSalt);
        const orTxnsKey = await deriveOrTxnsKeyFromMek(orMekBytes, orgSalt);
        orCredsKeyRef.current = orCredsKey;
        orTxnsKeyRef.current = orTxnsKey;
      }

      setIsUnlocked(true);
      void logSecurityEvent(user.id, 'vault_unlock', { key_version: vaultKeyVersion });

      // Phase 4.5: silent first-time setup for Owners. If this user
      // holds `users.invite` in the active org AND the org's active
      // DEK version is still 1 AND their org_keys wrap is a placeholder,
      // kick off a background rotation to establish the real shared DEK.
      //
      // Skipped if another writer in the org is already running a job.
      // Failures are non-fatal — user can retry from Settings → Security.
      //
      // We close over the just-unlocked keyRef to provide a decrypt fn
      // so the first-time-setup welcome email can include the real
      // (decrypted) org name — ZKA-correct because the server only
      // sees the composed plaintext that the client chose to share.
      const decryptForEmail = async (ciphertext: string): Promise<string> => {
        if (!keyRef.current) throw new Error('Vault is locked');
        return cryptoDecrypt(ciphertext, keyRef.current);
      };
      void maybeFirstTimeSetup(user.id, activeOrgId, user.email ?? null, decryptForEmail);
    } catch (err) {
      // Only log `vault_unlock_failed` if this was a genuine password-derived
      // failure (KEK unwrap auth-tag mismatch or a `verifyVaultPassword`
      // false). The S10 rate-limit reads this event type, so we must not
      // pollute it with downstream non-password failures like a failing
      // `deriveBlindIndexKeyFromMek` or background `ensureUserKeypair`.
      //
      // `passwordAttempted` flips true the moment we start the
      // password-dependent derivation; anything that throws AFTER the
      // password has been confirmed valid (e.g. blind-index derivation,
      // OR subkey derivation) is a system bug, not a credential failure.
      const isPasswordFailure = passwordAttempted && isCredentialError(err);
      if (isPasswordFailure) {
        void logSecurityEvent(user.id, 'vault_unlock_failed');
      } else {
        console.warn('[vault] unlock failed (non-credential):', err);
        // Capture only the non-credential path. A wrong-password attempt
        // is an expected user action and would just flood GlitchTip; the
        // S10 rate-limit + audit_log row above is already the right
        // signal for that. What lands here is a system bug (post-password
        // derivation failure, signing-key load failure, etc.) that we
        // want a real issue for.
        captureException(err, { tags: { source: 'vault-unlock-noncred' } });
      }
      throw err;
    }
  }, []);

  const lock = useCallback(() => {
    keyRef.current = null;
    blindIndexKeyRef.current = null;
    orCredsKeyRef.current = null;
    orTxnsKeyRef.current = null;
    // Phase 4.4: clear raw MEK + signing-key cache on lock.
    if (mekRawRef.current) {
      mekRawRef.current.fill(0);
      mekRawRef.current = null;
    }
    orgSaltRef.current = null;
    for (const handle of signingKeysRef.current.values()) {
      handle.privateKeyBytes.fill(0);
    }
    signingKeysRef.current.clear();
    setIsUnlocked(false);
  }, []);

  // ─── OrangeRails subkey helpers ───────────────────────────────────────
  // Encrypt/decrypt with ORK or ORT in the same AES-256-GCM format
  // as cryptoEncrypt/cryptoDecrypt (IV[12] + ciphertext, base64).

  const encryptOrCipher = useCallback(async (plaintext: string): Promise<string> => {
    if (!orCredsKeyRef.current) throw new Error('Vault is locked or pre-v4');
    return cryptoEncrypt(plaintext, orCredsKeyRef.current);
  }, []);

  const decryptOrCipher = useCallback(async (ciphertext: string): Promise<string> => {
    if (!orCredsKeyRef.current) throw new Error('Vault is locked or pre-v4');
    return cryptoDecrypt(ciphertext, orCredsKeyRef.current);
  }, []);

  const decryptOrTxnCipher = useCallback(async (ciphertext: string): Promise<string> => {
    if (!orTxnsKeyRef.current) throw new Error('Vault is locked or pre-v4');
    return cryptoDecrypt(ciphertext, orTxnsKeyRef.current);
  }, []);

  // Export raw key bytes as base64 for in-transit handoff to or-sync.
  // Both keys are extractable=true (set in deriveOr*KeyFromMek).
  const exportOrCredsKey = useCallback(async (): Promise<string> => {
    if (!orCredsKeyRef.current) throw new Error('Vault is locked or pre-v4');
    const raw = await window.crypto.subtle.exportKey('raw', orCredsKeyRef.current);
    return arrayBufferToBase64(raw);
  }, []);

  const exportOrTxnsKey = useCallback(async (): Promise<string> => {
    if (!orTxnsKeyRef.current) throw new Error('Vault is locked or pre-v4');
    const raw = await window.crypto.subtle.exportKey('raw', orTxnsKeyRef.current);
    return arrayBufferToBase64(raw);
  }, []);

  const encryptText = useCallback(async (plaintext: string): Promise<string> => {
    if (!keyRef.current) throw new Error('Vault is locked');
    return cryptoEncrypt(plaintext, keyRef.current);
  }, []);

  const decryptText = useCallback(async (ciphertext: string): Promise<string> => {
    if (!keyRef.current) throw new Error('Vault is locked');
    return cryptoDecrypt(ciphertext, keyRef.current);
  }, []);

  const encryptBlob = useCallback(async (plaintext: ArrayBuffer | Uint8Array): Promise<Blob> => {
    if (!keyRef.current) throw new Error('Vault is locked');
    return cryptoEncryptBlob(plaintext, keyRef.current);
  }, []);

  const decryptBlob = useCallback(async (ciphertext: Blob | ArrayBuffer): Promise<ArrayBuffer> => {
    if (!keyRef.current) throw new Error('Vault is locked');
    return cryptoDecryptBlob(ciphertext, keyRef.current);
  }, []);

  const setupVault = useCallback(async (password: string) => {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) throw new Error('Not authenticated');

    // v4: random MEK, Argon2id-derived KEK wraps MEK, recovery code wraps MEK independently.
    // Blind index key is derived from the MEK (not password) so it survives
    // password changes and recovery.
    const vaultSalt = generateVaultSalt();
    const kek = await deriveVaultV1Kek(password, user.id, vaultSalt);

    const mekRaw = generateMekBytes();
    const mek = await importAesGcmKey(mekRaw);

    const [encMekCiphertext, verifier, blindIndexKey] = await Promise.all([
      wrapMekWithKey(mekRaw, kek),
      createVaultVerifier(password, user.id, vaultSalt, LATEST_VAULT_KEY_VERSION),
      deriveBlindIndexKeyFromMek(mekRaw, vaultSalt),
    ]);

    const recoveryCode = generateRecoveryCode();
    const recoveryKek = await deriveRecoveryKek(recoveryCode);
    const recoveryCiphertext = await wrapMekWithKey(mekRaw, recoveryKek);

    keyRef.current = mek;
    blindIndexKeyRef.current = blindIndexKey;
    setIsUnlocked(true);

    void logSecurityEvent(user.id, 'vault_setup', { key_version: LATEST_VAULT_KEY_VERSION });

    return {
      verifier,
      vaultSalt,
      vaultKeyVersion: LATEST_VAULT_KEY_VERSION,
      encMekCiphertext,
      recoveryCiphertext,
      recoveryCode,
    };
  }, []);

  const recoverWithCode = useCallback(
    async ({
      recoveryCode,
      recoveryCiphertext,
      orgSaltB64,
      userId,
      newPassword,
    }: {
      recoveryCode: string;
      encMekCiphertext: string;
      recoveryCiphertext: string;
      orgSaltB64: string;
      userId: string;
      newPassword: string;
    }) => {
      // Unwrap MEK with the recovery code KEK — throws if code is wrong.
      const recoveryKek = await deriveRecoveryKek(recoveryCode);
      const mekRaw = await unwrapMekWithKey(recoveryCiphertext, recoveryKek);
      const mek = await importAesGcmKey(mekRaw);

      // Re-wrap MEK with the new password (same salt → all existing ciphertext stays valid).
      // Blind index key derives from MEK so it survives this rotation unchanged.
      const newKek = await deriveVaultV1Kek(newPassword, userId, orgSaltB64);
      const newEncMekCiphertext = await wrapMekWithKey(mekRaw, newKek);
      const newVerifier = await createVaultVerifier(
        newPassword,
        userId,
        orgSaltB64,
        LATEST_VAULT_KEY_VERSION,
      );

      // Generate a fresh recovery code (old one is consumed).
      const newRecoveryCode = generateRecoveryCode();
      const newRecoveryKek = await deriveRecoveryKek(newRecoveryCode);
      const newRecoveryCiphertext = await wrapMekWithKey(mekRaw, newRecoveryKek);

      const blindIndexKey = await deriveBlindIndexKeyFromMek(mekRaw, orgSaltB64);

      keyRef.current = mek;
      blindIndexKeyRef.current = blindIndexKey;
      setIsUnlocked(true);

      void logSecurityEvent(userId, 'vault_recover');

      return { newEncMekCiphertext, newRecoveryCode, newRecoveryCiphertext, newVerifier };
    },
    [],
  );

  /**
   * Rotate ONLY the recovery code without touching the vault password or
   * the wrapped DEK. Uses the in-memory MEK (vault must be unlocked).
   *
   * Returns the new recovery code (to display once) and the new
   * recovery_ciphertext (to persist to org_settings). Caller is
   * responsible for the UPDATE + the user-facing save confirmation.
   *
   * Effects: invalidates the old recovery code. If the user had saved
   * the old one in a password manager, that copy stops working the
   * moment this completes.
   */
  const rotateRecoveryCode = useCallback(async () => {
    if (!mekRawRef.current) {
      throw new Error('Vault must be unlocked before rotating the recovery kit.');
    }
    const newRecoveryCode = generateRecoveryCode();
    const newRecoveryKek = await deriveRecoveryKek(newRecoveryCode);
    const newRecoveryCiphertext = await wrapMekWithKey(mekRawRef.current, newRecoveryKek);
    return { newRecoveryCode, newRecoveryCiphertext };
  }, []);

  /**
   * S14 — Set up the per-user master recovery code that unlocks every
   * org the user belongs to with a single phrase. Uses the in-memory
   * MEK of the active org; the master_wrapped_mek for THIS org is
   * returned to be persisted. To enroll additional orgs, the user
   * unlocks each one in turn and calls wrapCurrentOrgUnderMaster().
   *
   * Returns:
   *   newMasterCode    — display once, never persisted
   *   masterSalt       — base64 32 bytes, persist to user_master_recovery
   *   verifierCiphertext — proves a typed code is correct
   *   currentOrgWrap   — wrap of THIS org's MEK under the master KEK
   */
  const setupMasterRecoveryCode = useCallback(async () => {
    if (!mekRawRef.current) {
      throw new Error('Vault must be unlocked before setting up master recovery.');
    }
    const newMasterCode = generateRecoveryCode();
    const masterSalt = generateMasterRecoverySalt();
    const masterKek = await deriveMasterRecoveryKek(newMasterCode, masterSalt);
    const verifierCiphertext = await createMasterRecoveryVerifier(newMasterCode, masterSalt);
    const currentOrgWrap = await wrapMekWithKey(mekRawRef.current, masterKek);
    return { newMasterCode, masterSalt, verifierCiphertext, currentOrgWrap };
  }, []);

  /**
   * S14 — Wrap the currently-unlocked org's MEK under an already-set-up
   * master KEK. Used to enroll additional orgs into an existing master
   * recovery setup. The caller provides the master code (it's only
   * known to the user at setup time; we never persist it).
   */
  const wrapCurrentOrgUnderMaster = useCallback(
    async (masterCode: string, masterSaltB64: string) => {
      if (!mekRawRef.current) {
        throw new Error('Vault must be unlocked before enrolling org in master recovery.');
      }
      const masterKek = await deriveMasterRecoveryKek(masterCode, masterSaltB64);
      return wrapMekWithKey(mekRawRef.current, masterKek);
    },
    [],
  );

  /**
   * S14 — Recover an org using the master recovery code. Used on the
   * vault unlock screen when the user has forgotten their per-org
   * vault password AND lost the per-org recovery code, but still
   * has the master code.
   *
   * Steps:
   *   1. Verify the master code is correct (decrypt the verifier).
   *   2. Unwrap the org's MEK from org_master_wraps.master_wrapped_mek.
   *   3. Re-wrap MEK under the new password's KEK (org_settings.enc_mek_ciphertext).
   *   4. Generate a fresh per-org recovery code and wrap MEK under it.
   *   5. Build a new verifier for the new password.
   *   6. Set keyRef + blindIndexKeyRef so the vault is immediately unlocked.
   *
   * Caller persists the returned ciphertexts to org_settings.
   */
  const recoverOrgWithMasterCode = useCallback(
    async ({
      masterCode,
      masterSaltB64,
      verifierCiphertext,
      masterWrappedMek,
      orgSaltB64,
      userId,
      newPassword,
    }: {
      masterCode: string;
      masterSaltB64: string;
      verifierCiphertext: string;
      masterWrappedMek: string;
      orgSaltB64: string;
      userId: string;
      newPassword: string;
    }) => {
      // 1. Verify the code via the exported helper. This is the SAME crypto
      //    path the helper in vault.ts encapsulates — using the helper avoids
      //    a name-shadow bug where the local `decryptText` useCallback
      //    (1 arg, uses keyRef MEK which is null during recovery) would
      //    silently take precedence over the imported 2-arg helper. Found
      //    by the 2026-05-16 post-hardening audit (A1).
      if (!(await verifyMasterRecoveryCode(masterCode, masterSaltB64, verifierCiphertext))) {
        throw new Error('Master recovery key is incorrect.');
      }

      // 2. Re-derive the master KEK for the unwrap step. HKDF is cheap;
      //    the helper above did it once internally to verify, we do it
      //    once more here. If we ever care about the microseconds, the
      //    helper can be lifted to return both (boolean, kek).
      const masterKek = await deriveMasterRecoveryKek(masterCode, masterSaltB64);
      const mekRaw = await unwrapMekWithKey(masterWrappedMek, masterKek);
      const mek = await importAesGcmKey(mekRaw);

      // 3. Re-wrap under the new password's KEK.
      const newKek = await deriveVaultV1Kek(newPassword, userId, orgSaltB64);
      const newEncMekCiphertext = await wrapMekWithKey(mekRaw, newKek);
      const newVerifier = await createVaultVerifier(
        newPassword,
        userId,
        orgSaltB64,
        LATEST_VAULT_KEY_VERSION,
      );

      // 4. Fresh per-org recovery code (rotates whatever the user had — they
      //    don't necessarily remember it anyway, since they just used the
      //    master).
      const newRecoveryCode = generateRecoveryCode();
      const newRecoveryKek = await deriveRecoveryKek(newRecoveryCode);
      const newRecoveryCiphertext = await wrapMekWithKey(mekRaw, newRecoveryKek);

      // 5. Unlock in memory.
      const blindIndexKey = await deriveBlindIndexKeyFromMek(mekRaw, orgSaltB64);
      keyRef.current = mek;
      blindIndexKeyRef.current = blindIndexKey;
      mekRawRef.current = mekRaw;
      orgSaltRef.current = orgSaltB64;
      setIsUnlocked(true);

      void logSecurityEvent(userId, 'vault_recover', { via: 'master_code' });

      return { newEncMekCiphertext, newRecoveryCode, newRecoveryCiphertext, newVerifier };
    },
    [],
  );

  const changeVaultPassword = useCallback(
    async ({
      currentPassword,
      newPassword,
      orgSaltB64,
      encMekCiphertext,
      userId,
    }: {
      currentPassword: string;
      newPassword: string;
      orgSaltB64: string;
      encMekCiphertext: string;
      userId: string;
    }) => {
      // 1. Unwrap MEK with current password's KEK — throws if current password is wrong.
      const currentKek = await deriveVaultV1Kek(currentPassword, userId, orgSaltB64);
      const mekRaw = await unwrapMekWithKey(encMekCiphertext, currentKek);
      const mek = await importAesGcmKey(mekRaw);

      // 2. Re-wrap MEK with new password's KEK (same salt — blind index stays valid).
      const newKek = await deriveVaultV1Kek(newPassword, userId, orgSaltB64);
      const newEncMekCiphertext = await wrapMekWithKey(mekRaw, newKek);
      const newVerifier = await createVaultVerifier(
        newPassword,
        userId,
        orgSaltB64,
        LATEST_VAULT_KEY_VERSION,
      );

      // 3. Fresh recovery code — old one is invalidated.
      const newRecoveryCode = generateRecoveryCode();
      const newRecoveryKek = await deriveRecoveryKek(newRecoveryCode);
      const newRecoveryCiphertext = await wrapMekWithKey(mekRaw, newRecoveryKek);

      // 4. Keep vault unlocked with the same MEK + blind index key in memory.
      const blindIndexKey = await deriveBlindIndexKeyFromMek(mekRaw, orgSaltB64);
      keyRef.current = mek;
      blindIndexKeyRef.current = blindIndexKey;

      // 5. Phase 4.1: re-wrap the hybrid private key with the new MEK via
      // atomic UPDATE (Decision D5). The random MEK bytes are identical
      // across password change, so the HKDF-derived pqcSecretWrapKey also
      // stays the same — meaning this call is a no-op at the crypto layer
      // yet still exercises the UPDATE path so the DB-touch invariants
      // are observable. Password changes that *do* rotate the MEK (e.g.
      // Phase 4.5 hard re-key) will see real re-wrap work here.
      //
      // Never let a keypair-row failure block the password change UX;
      // the user's data encryption still works, and we retry on the
      // next unlock via ensureUserKeypair.
      try {
        const oldMekForHkdf = await importMekForHkdf(mekRaw);
        const newMekForHkdf = await importMekForHkdf(mekRaw);
        await rewrapUserKeypair({
          userId,
          oldMek: oldMekForHkdf,
          newMek: newMekForHkdf,
          saltB64: orgSaltB64,
          supabase: supabase as unknown as SupabaseKeypairClient,
        });
      } catch (e) {
        console.warn('[vault] rewrapUserKeypair failed; retry next unlock', e);
      }

      void logSecurityEvent(userId, 'vault_password_changed');

      return { newEncMekCiphertext, newRecoveryCode, newRecoveryCiphertext, newVerifier };
    },
    [],
  );

  const blindIndex = useCallback(
    async (value: string | null | undefined): Promise<string | null> => {
      if (!blindIndexKeyRef.current) return null;
      return computeBlindIndex(value, blindIndexKeyRef.current);
    },
    [],
  );

  /**
   * Phase 4.4: lazily unwrap the user's Org Signing Key for a given
   * org. The flow:
   *   1. Return cached handle if we already unwrapped this org's signing key.
   *   2. Fetch `org_member_signing_key_wraps` for (auth.uid, org_id, latest
   *      key_version). Null result = read-only role (Auditor / Viewer).
   *   3. Fetch the user's own `user_vault_keys.encrypted_private_key`
   *      and decrypt it with the pqc-secret-wrap subkey derived from
   *      the vault MEK.
   *   4. Use the recovered hybrid secret key to unwrap the signing key private
   *      half via the hybrid KEM strategy. Cache + return.
   *
   * All failures are plain-English: stale wrap, missing key, etc. The
   * call site (transaction save path) renders the error as a toast.
   */
  const loadOrgSigningKey = useCallback(async (orgId: string): Promise<SigningKeyHandle | null> => {
    if (!orgId) return null;
    const cached = signingKeysRef.current.get(orgId);
    if (cached) return cached;
    if (!mekRawRef.current || !orgSaltRef.current) {
      // Locked vault. No HKDF material available. Upstream
      // call sites skip signing in that case.
      return null;
    }

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    // Step 1: latest signing-key wrap for this user in this org.
    const { data: wrapRow, error: wrapErr } = await (supabase as any)
      .from('org_member_signing_key_wraps')
      .select('wrapped_private_key, key_version, wrap_algo')
      .eq('user_id', user.id)
      .eq('org_id', orgId)
      .order('key_version', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (wrapErr) {
      console.warn('[vault] loadOrgSigningKey: org_member_signing_key_wraps read failed', wrapErr);
      return null;
    }
    if (!wrapRow) {
      // Read-only role — no wrap. Not an error.
      return null;
    }

    // Step 2: user's own hybrid keypair row — the wrap's "recipient key".
    const { data: keyRow, error: keyErr } = await (supabase as any)
      .from('user_vault_keys')
      .select('encrypted_private_key')
      .eq('user_id', user.id)
      .maybeSingle();
    if (keyErr || !keyRow?.encrypted_private_key) {
      console.warn('[vault] loadOrgSigningKey: user_vault_keys missing', keyErr);
      return null;
    }

    try {
      // Derive the pqc secret-wrap subkey the same way vault-keypair.ts
      // does, then decrypt the hybrid private key bytes.
      const mekForHkdf = await importMekForHkdf(mekRawRef.current);
      const wrapKey = await derivePqcSecretWrapKey(mekForHkdf, orgSaltRef.current);
      const { decryptText: cryptoDecryptInner } = await import('@/lib/vault');
      const hybridPrivKeyB64 = await cryptoDecryptInner(keyRow.encrypted_private_key, wrapKey);
      const hybridPrivKey = Uint8Array.from(atob(hybridPrivKeyB64), (c) => c.charCodeAt(0));

      const privateKeyBytes = await unwrapSigningKeyForSelf(
        wrapRow.wrapped_private_key,
        hybridPrivKey,
      );
      const handle: SigningKeyHandle = {
        privateKeyBytes,
        keyVersion: wrapRow.key_version ?? 1,
      };
      signingKeysRef.current.set(orgId, handle);
      return handle;
    } catch (err) {
      console.warn('[vault] loadOrgSigningKey: unwrap failed', err);
      return null;
    }
  }, []);

  const signMutation = useCallback(
    (
      payloadBytes: Uint8Array,
      orgId: string,
    ): { signature_b64: string; key_version: number } | null => {
      const handle = signingKeysRef.current.get(orgId);
      if (!handle) return null;
      return signingKeySignMutation(payloadBytes, handle);
    },
    [],
  );

  return (
    <VaultCtx.Provider
      value={{
        isUnlocked,
        unlock,
        lock,
        encryptText,
        decryptText,
        encryptBlob,
        decryptBlob,
        encryptOrCipher,
        decryptOrCipher,
        decryptOrTxnCipher,
        exportOrCredsKey,
        exportOrTxnsKey,
        setupVault,
        recoverWithCode,
        blindIndex,
        changeVaultPassword,
        rotateRecoveryCode,
        setupMasterRecoveryCode,
        wrapCurrentOrgUnderMaster,
        recoverOrgWithMasterCode,
        loadOrgSigningKey,
        signMutation,
      }}
    >
      {children}
    </VaultCtx.Provider>
  );
}

export function useVault() {
  const ctx = useContext(VaultCtx);
  if (!ctx) throw new Error('useVault must be used within VaultProvider');
  return ctx;
}
