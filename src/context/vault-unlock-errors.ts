/**
 * Helpers for classifying vault-unlock failures.
 *
 * Lives in its own module (not in VaultContext.tsx) so unit tests can
 * import it without pulling in the Supabase client (which throws at
 * import time when VITE_SUPABASE_URL is unset, as in CI / vitest runs).
 *
 * The single export `isCredentialError` is the policy boundary for the
 * S10 vault-unlock rate limit: only errors that match this predicate
 * cause `vault_unlock_failed` to be written. Everything else (session
 * not yet rehydrated, RLS / network blips, "no organization" etc.) is
 * treated as transient and must NOT count toward the 5-in-15min
 * sliding-window cooldown.
 *
 * See fix/vault-unlock-after-reload for the bug this prevents.
 */

/**
 * Decide whether an `unlock` failure should be logged as
 * `vault_unlock_failed` (which feeds the S10 5-in-15min sliding-window
 * lockout). Only genuine credential failures count:
 *
 *   • "Incorrect vault password"  — thrown by the verifier mismatch.
 *   • AES-GCM auth-tag failure on `unwrapMekWithKey` — surfaces as a
 *     Web Crypto `OperationError` (DOMException) or a generic Error
 *     whose message contains "decrypt" / "operation". Both shapes
 *     happen when the KEK derived from the typed password is wrong.
 *
 * Network / RLS / session-rehydration / "no organization" errors must
 * NOT count — those are transient and should never lock the user out.
 */
export function isCredentialError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message ?? '';
    if (msg === 'Incorrect vault password') return true;
    // Web Crypto's OperationError surfaces as DOMException with name
    // 'OperationError'. Browsers differ slightly on shape; check both
    // the constructor name and the message for safety.
    if ((err as { name?: string }).name === 'OperationError') return true;
    if (/operation|decrypt|cipher|auth(entication)? tag/i.test(msg)) return true;
  }
  return false;
}
