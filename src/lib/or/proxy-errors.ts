/**
 * Error types for the owb-or-proxy edge function, plus the predicates callers
 * branch on. Kept out of the page that raises them so the branching rules can
 * be tested without mounting the Connections page and its whole context tree.
 */

/**
 * Failure from the owb-or-proxy edge function. Carries the upstream HTTP
 * status and (when available) the JSON body so callers can branch on specific
 * status codes. Vanilla `Error` drops both, which is what callProxy in
 * src/pages/Connections.tsx does today.
 */
export class CallProxyError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'CallProxyError';
    this.status = status;
    this.body = body;
    // Required for `instanceof` to survive the ES5 downlevel target.
    Object.setPrototypeOf(this, CallProxyError.prototype);
  }
}

/**
 * True when OR is telling us the subaccount_id we sent is one it never issued.
 *
 * In Books the id is cached in localStorage under `or_subaccount_id_for_org_`
 * plus the org id, which records the org but not which Orange Rails gateway
 * issued the id. Point a build at a different gateway and the cache keeps
 * handing over an id from the old one, which the new gateway has never heard
 * of.
 *
 * The state cannot clear itself: provisioning is skipped whenever an id is
 * already cached, so the unusable id both breaks every call and blocks the
 * re-provision that would replace it.
 *
 * Match on status AND message. Status alone would swallow unrelated 404s (a
 * missing connection, a retired endpoint) into a re-provision that cannot fix
 * them and would hide the real error; message alone would trust a substring
 * appearing in some other payload.
 */
export function isSubaccountNotFound(err: unknown): boolean {
  return (
    err instanceof CallProxyError && err.status === 404 && /subaccount not found/i.test(err.message)
  );
}
