/**
 * Regression tests for the vault-unlock-after-reload fix
 * (fix/vault-unlock-after-reload).
 *
 * Background: on a hard SPA reload after a successful sign-in + unlock,
 * the in-memory MEK is dropped and the unlock screen re-renders. The
 * `unlock()` helper used to:
 *   1. Call `supabase.auth.getUser()` before the rehydrated JWT was
 *      attached, returning null and throwing 'Not authenticated'.
 *   2. Catch EVERY error inside its main try-block as
 *      `vault_unlock_failed`, ticking the S10 5-in-15min sliding-window
 *      cooldown for transient flakes (network, RLS, session race).
 *
 * The fix narrows the failure-event logging to genuine credential
 * failures only. These tests pin down the policy boundary.
 */
import { describe, it, expect } from 'vitest';
import { isCredentialError } from './vault-unlock-errors';

describe('isCredentialError, S10 rate-limit policy boundary', () => {
  it('flags "Incorrect vault password" as a credential failure', () => {
    expect(isCredentialError(new Error('Incorrect vault password'))).toBe(true);
  });

  it('flags Web Crypto OperationError as a credential failure', () => {
    // Browsers surface AES-GCM auth-tag mismatches as DOMException with
    // name 'OperationError'. We don't have DOMException in jsdom by
    // default, so synthesise the same shape.
    const err = new Error('The operation failed for an operation-specific reason');
    (err as { name?: string }).name = 'OperationError';
    expect(isCredentialError(err)).toBe(true);
  });

  it('flags generic AES-GCM decrypt errors as a credential failure', () => {
    expect(isCredentialError(new Error('AES-GCM decrypt failed: auth tag mismatch'))).toBe(true);
    expect(isCredentialError(new Error('cipher operation failed'))).toBe(true);
  });

  // ── Non-credential failures (must NOT tick the rate limit) ───────────
  it('does NOT flag "Session not yet ready" as a credential failure', () => {
    // Thrown when `getSession()` returns null on a hard reload before
    // the JWT is rehydrated. This is the heart of the C-G journey bug.
    expect(isCredentialError(new Error('Session not yet ready, please try again.'))).toBe(false);
  });

  it('does NOT flag "Not authenticated" as a credential failure', () => {
    expect(isCredentialError(new Error('Not authenticated'))).toBe(false);
  });

  it('does NOT flag "No organization found" as a credential failure', () => {
    expect(isCredentialError(new Error('No organization found for this user'))).toBe(false);
  });

  it('does NOT flag "Vault not set up" as a credential failure', () => {
    expect(isCredentialError(new Error('Vault not set up for this organization'))).toBe(false);
  });

  it('does NOT flag transient network / RLS errors as credential failures', () => {
    expect(
      isCredentialError(new Error('Could not load your organization. Please try again.')),
    ).toBe(false);
    expect(isCredentialError(new Error('Could not load vault settings. Please try again.'))).toBe(
      false,
    );
    expect(isCredentialError(new Error('TypeError: Failed to fetch'))).toBe(false);
  });

  it('does NOT flag non-Error values', () => {
    expect(isCredentialError(null)).toBe(false);
    expect(isCredentialError(undefined)).toBe(false);
    expect(isCredentialError('Incorrect vault password')).toBe(false); // string, not Error
    expect(isCredentialError({ message: 'Incorrect vault password' })).toBe(false);
  });
});
