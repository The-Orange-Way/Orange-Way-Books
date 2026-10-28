/** Shown when the current vault password typed on the change form is wrong. */
export const WRONG_CURRENT_VAULT_PASSWORD = 'Current vault password is incorrect.';

const FALLBACK = 'Failed to change vault password.';

/**
 * Turn a vault password change failure into text the user can read.
 *
 * A wrong current password makes Web Crypto reject the key unwrap with an
 * `OperationError` whose message is empty in Chromium, which left the form
 * with no error at all. Match it by name only, so network errors that merely
 * mention "operation" are not reported as a wrong password.
 */
export function describeVaultPasswordChangeError(err: unknown): string {
  if (!err || typeof err !== 'object') return FALLBACK;
  const { name, message } = err as { name?: unknown; message?: unknown };
  if (name === 'OperationError') return WRONG_CURRENT_VAULT_PASSWORD;
  if (typeof message === 'string' && message.trim()) return message;
  return FALLBACK;
}
