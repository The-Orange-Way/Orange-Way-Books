/**
 * Which endpoint disconnects a given connection, and with what payload.
 *
 * There are two connection stores behind Orange Rails and they are scoped
 * differently. Ordinary connections live in `connections`, scoped by
 * subaccount. Private (stealth) connections live in their own store, scoped by
 * app user. `or-connection-delete` selects from the first one only, so calling
 * it for a private connection looks in a table that row is not in and answers
 * 404 "Connection not found in this subaccount". In the sibling app every
 * private connection was therefore undeletable, and the page reported it as
 * "Couldn't disconnect. Give it a moment and try again", which invited a retry
 * that could never work.
 *
 * BEFORE THE STEALTH BRANCH CAN RUN IN BOOKS. `ALLOWED_ENDPOINTS` in
 * supabase/functions/owb-or-proxy/index.ts lists the six ordinary endpoints
 * plus the two wallet-discovery ones, and no stealth endpoint at all. Until
 * `or-stealth-connection-delete` is added there, a stealth plan built by this
 * function will be refused by our own proxy before it ever reaches OR. This
 * function is still the right shape to land first: it is what the wiring will
 * call, and it is testable now.
 *
 * This is a pure function so the choice can be tested. In the sibling app it
 * was a bare `if` inside a click handler with no test, which is how it went
 * unnoticed.
 *
 * Note what is NOT here: the owner. `or-stealth-connection-delete` deletes by
 * row id, so the caller's identity is the only thing stopping one user from
 * deleting another's connection by guessing an id. That is forced to the
 * authenticated user inside `owb-or-proxy` and must never be sent from the
 * browser. The same is true of `subaccount_id` on the ordinary path: the proxy
 * resolves it server side from the verified org and overwrites whatever the
 * browser sent, so the field below is the shape OR expects, never a scoping
 * the client gets to choose.
 */

export interface DeletePlan {
  endpoint: 'or-connection-delete' | 'or-stealth-connection-delete';
  payload: Record<string, unknown>;
}

export function buildDeletePlan(args: {
  isStealth: boolean | undefined;
  connectionId: string;
  subaccountId: string;
}): DeletePlan {
  if (args.isStealth) {
    return {
      endpoint: 'or-stealth-connection-delete',
      payload: { connection_id: args.connectionId },
    };
  }
  return {
    endpoint: 'or-connection-delete',
    payload: { subaccount_id: args.subaccountId, connection_id: args.connectionId },
  };
}

/**
 * Outcome of reading the connection list back after a 2xx delete.
 *
 * A 2xx is not proof the row is gone: the endpoint can acknowledge a delete
 * that did not take, and the optimistic removal in the UI would otherwise hide
 * it. So the list is read back and this classifies the result:
 *
 *  - "silent-failure": the row is STILL present after a 2xx. Never claim
 *    success here.
 *  - "confirmed-gone": the row is absent from a list we could read. Safe to
 *    say "disconnected".
 *  - "unconfirmed": the list could not be read back (rows is null/undefined).
 *    We only know the endpoint returned 2xx, so say that and no more, do not
 *    claim a verified delete.
 *
 * Pure so the decision can be tested without standing up a DOM harness.
 */
export type DeleteReadback = 'silent-failure' | 'confirmed-gone' | 'unconfirmed';

export function classifyDeleteReadback(
  rows: { id: string }[] | null | undefined,
  connectionId: string,
): DeleteReadback {
  if (!rows) return 'unconfirmed';
  return rows.some((c) => c.id === connectionId) ? 'silent-failure' : 'confirmed-gone';
}
