/** Shown when the database refuses to change a posted (finalized) journal entry. */
export const POSTED_ENTRY_LOCKED_MESSAGE =
  'This transaction is posted, so it cannot be edited. Void it and enter it again instead.';

/**
 * Turns whatever a save threw into text a person can read.
 * Supabase errors are plain objects, not Error instances, so String(err)
 * would print "[object Object]".
 */
export function saveErrorText(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    if (e.code === '23000' && typeof e.message === 'string' && e.message.includes('finalized')) {
      return POSTED_ENTRY_LOCKED_MESSAGE;
    }
    if (typeof e.message === 'string' && e.message) return e.message;
  }
  if (typeof err === 'string' && err) return err;
  return 'Unknown error.';
}
