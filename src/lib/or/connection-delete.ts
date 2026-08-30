/**
 * Which endpoint disconnects a given connection, and with what payload, and
 * whether the disconnect can honestly be reported as done.
 *
 * Mirrors the same module in the personal app so the two products stay design
 * twins. Both rules below are ported before Books has a private-wallet
 * connection path, so that path is built against them rather than against the
 * behaviour they replace.
 *
 * TWO CONNECTION STORES, SCOPED DIFFERENTLY. Ordinary connections live in
 * `connections`, scoped by subaccount. Private (stealth) connections live in
 * their own store, scoped by app user. The ordinary delete endpoint selects
 * from the first one only, so calling it for a private connection looks in a
 * table that row is not in and answers 404 "Connection not found in this
 * subaccount". In the personal app that made every private connection
 * undeletable, and the page reported it as a temporary failure and invited a
 * retry that could never work.
 *
 * Note what is NOT here: the owner. The private delete endpoint deletes by row
 * id, so the caller's identity is the only thing stopping one customer from
 * deleting another's connection by guessing an id. That is forced to the
 * authenticated user inside the proxy and must never be sent from the browser.
 *
 * KNOWN GAP, verified on dev and stated here so it is not rediscovered:
 * owb-or-proxy's ALLOWED_ENDPOINTS does not yet contain the private delete
 * endpoint, so that branch would be refused by the proxy today. Whatever wires
 * the private connection path has to add it.
 *
 * Pure functions, so both decisions can be tested without a DOM harness.
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
 * that did not take, and an optimistic removal in the UI would otherwise hide
 * it. So the list is read back and this classifies the result:
 *
 *  - "silent-failure": the row is STILL present after a 2xx. Never claim
 *    success here.
 *  - "confirmed-gone": the row is absent from a list we could read. Safe to say
 *    "disconnected".
 *  - "unconfirmed": the list could not be read back (rows is null/undefined).
 *    We only know the endpoint returned 2xx, so say that and no more, do not
 *    claim a verified delete.
 */
export type DeleteReadback = 'silent-failure' | 'confirmed-gone' | 'unconfirmed';

export function classifyDeleteReadback(
  rows: { id: string }[] | null | undefined,
  connectionId: string,
): DeleteReadback {
  if (!rows) return 'unconfirmed';
  return rows.some((c) => c.id === connectionId) ? 'silent-failure' : 'confirmed-gone';
}
