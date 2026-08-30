/**
 * Error types for the owb-or-proxy edge function, plus the predicates callers
 * branch on. Kept out of the page that raises them so the branching rules can
 * be tested without mounting the Connections page and its whole context tree.
 *
 * Mirrors the same module in the personal app so the two products stay design
 * twins.
 *
 * NOT YET WIRED. Connections.tsx still throws a bare Error from its own inline
 * callProxy. This lands first, on its own, so the rules are reviewable before
 * anything depends on them.
 */

/**
 * Failure from the owb-or-proxy edge function. Carries the upstream HTTP
 * status and, when available, the JSON body, so callers can branch on a
 * specific status code instead of on the text of a message. A vanilla Error
 * would drop both.
 */
export class CallProxyError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'CallProxyError';
    this.status = status;
    this.body = body;
  }
}

/**
 * True when Orange Rails is telling us the subaccount_id we sent is one it
 * never issued.
 *
 * This is worth a named predicate because the only repair is to provision a
 * new subaccount, and that repair is wrong for every other 404. A connection
 * that has already been deleted is also a 404 and re-provisioning would not
 * help it; it would just replace a real error with a confusing one.
 *
 * Match on status AND message. Status alone would swallow unrelated 404s (a
 * missing connection, a retired endpoint) into a re-provision that cannot fix
 * them and would hide the real error. Message alone would trust a substring
 * appearing in some other payload.
 */
export function isSubaccountNotFound(err: unknown): boolean {
  return (
    err instanceof CallProxyError && err.status === 404 && /subaccount not found/i.test(err.message)
  );
}
