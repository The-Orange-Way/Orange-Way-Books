/**
 * What to say after the OR connect widget reports success.
 *
 * THE DEFECT THIS REPLACES. A user pastes an extended public key they have
 * already added. Orange Rails is right to deduplicate: the same key is the
 * same wallet, so `or-stealth-connection-create` answers
 *
 *     200 {"connection_id":"<the existing one>","already_existed":true}
 *
 * The widget then closes and posts back only
 *
 *     {"type":"or-link-success","connection_id":"<the existing one>","source_wallets":[]}
 *
 * `already_existed` is dropped on the way. The app therefore renders nothing:
 * no toast, no new row, no explanation. Every report of "I added a wallet and
 * nothing happened" is this.
 *
 * Note what is NOT the fix: waiting for Orange Rails to forward the flag. That
 * change is worth making and is filed separately, but this app does not need
 * it. The app already knows which connections it was showing a moment ago, so
 * it can tell "this is new" from "you already had this" on its own, and a fix
 * that depends on nobody else shipping is the one that reaches the user.
 *
 * Pure and exported so all three branches are testable. The equivalent code in
 * the sibling app was an unexamined `await refresh()` in a click handler with
 * no test, which is how silence became the product's answer to a successful
 * action.
 */

/** The subset of the widget's success payload this decision needs. */
export interface LinkSuccessLike {
  connection_id: string;
  /** Present in the type OR publishes, empty in practice for stealth links. */
  source_wallets?: ReadonlyArray<unknown>;
  /**
   * Only set when OR forwards it. Absent today. Treated as authoritative when
   * present so this keeps working, and improves, the moment OR ships it.
   */
  already_existed?: boolean;
}

export type LinkOutcome = 'created' | 'already-existed' | 'unknown';

export interface LinkResultReport {
  outcome: LinkOutcome;
  toast: { level: 'success' | 'info' | 'warning'; message: string };
  /** Connection to scroll to and highlight, so the claim is visible. */
  highlightConnectionId: string | null;
}

export function describeLinkResult(args: {
  result: LinkSuccessLike;
  /** Connection ids on screen immediately BEFORE the widget was opened. */
  knownConnectionIdsBefore: ReadonlyArray<string>;
  /** Ids returned by the refresh AFTER the widget closed, when available. */
  connectionIdsAfter?: ReadonlyArray<string>;
}): LinkResultReport {
  const id = args.result.connection_id;
  const wasKnown = args.knownConnectionIdsBefore.includes(id);

  // OR's own flag wins when it is actually sent. Today it never is, so the
  // membership check below is what runs. Both paths are covered by tests so
  // the day OR starts forwarding it, nothing silently changes shape.
  const flag = args.result.already_existed;
  const existed = typeof flag === 'boolean' ? flag : wasKnown;

  if (existed) {
    return {
      outcome: 'already-existed',
      toast: {
        level: 'info',
        message:
          'You already have this wallet connected, so nothing new was added. ' +
          "We've highlighted it below.",
      },
      highlightConnectionId: id,
    };
  }

  // Genuinely new. If a refresh already ran and still does not contain the id,
  // saying "added" would be a claim the screen contradicts. Say what is true:
  // it was created, and it is not showing yet.
  if (args.connectionIdsAfter && !args.connectionIdsAfter.includes(id)) {
    return {
      outcome: 'unknown',
      toast: {
        level: 'warning',
        message:
          "Connection added, but it isn't showing yet. Reload the page, and " +
          'tell us if it stays missing.',
      },
      highlightConnectionId: null,
    };
  }

  return {
    outcome: 'created',
    toast: {
      level: 'success',
      message: 'Connection added. Credentials stored as ciphertext only.',
    },
    highlightConnectionId: id,
  };
}
