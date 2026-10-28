/**
 * Readable text for an error caught during a QuickBooks import.
 *
 * Supabase returns errors as plain objects ({ message, code, details, hint }),
 * not Error instances, so String(err) printed "[object Object]" in the
 * import's error list and the user could not tell what went wrong.
 */
export function describeImportError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object') {
    const { message, code } = err as { message?: unknown; code?: unknown };
    if (typeof message === 'string' && message.trim()) {
      return typeof code === 'string' && code.trim() ? `${message} (${code})` : message;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return 'Unknown error';
    }
  }
  return String(err);
}
