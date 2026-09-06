/**
 * "Sync all connections": what to send, and what to say about what came back.
 *
 * Ported from Orange-Way-Me src/lib/or/sync-all.ts (read at dev HEAD,
 * OWB-T0088). Two defects that module exists to close, carried over here
 * because OWB's own bulk-sync path will hit them the same way:
 *
 * 1. A private (stealth) connection is not in the `connections` table that
 *    `or-sync` reads from, it lives in a separate store scoped by app user.
 *    Sending its id to `or-sync` matches nothing and gets no entry back.
 *
 * 2. A caller that only reads `res.synced` and entries carrying an `error`
 *    cannot see an id that came back as neither. That id was never
 *    attempted, and reporting "no new transactions" in that case is an
 *    invention, not a summary.
 *
 * WHY PRIVATE CONNECTIONS ARE NEVER SYNCED IN BULK. Scanning one needs the
 * Orange Rails widget open in this browser, one popup per connection,
 * started by a user gesture (see src/lib/or/widget.ts openOrConnect). A loop
 * of popups is blocked by browsers and would break the user-initiated rule
 * the single-connection path was reviewed against. So bulk sync excludes
 * them and says so out loud, rather than including them and reporting
 * nothing.
 *
 * NOT YET WIRED. OWB's `connections` table has no `is_stealth` column today
 * (checked via code_search over this repo, zero hits) and there is no
 * "Sync all" action in src/pages/Connections.tsx yet, only a per-connection
 * `or-sync` call. This lands first, on its own, the same way OWB-T0156's
 * or-key-material.ts did, so the rule is reviewable before anything depends
 * on it. Wiring it into a bulk-sync UI action is separate follow-on scope on
 * OWB-T0088, not part of this change.
 *
 * Pure and exported so both halves can be tested without a browser, a popup,
 * or a network call.
 */

/** The subset of a connection row this decision needs. */
export interface SyncAllCandidate {
  id: string;
  /** Optional on the wire. Absent must read as ordinary, never as private. */
  is_stealth?: boolean;
}

export interface SyncAllPlan {
  /** Ordinary connection ids, the only ones `or-sync` can act on. */
  syncableIds: string[];
  /** Private connections, deliberately not sent. Reported, never dropped. */
  skippedPrivateIds: string[];
}

export function planSyncAll(connections: ReadonlyArray<SyncAllCandidate>): SyncAllPlan {
  const syncableIds: string[] = [];
  const skippedPrivateIds: string[] = [];
  for (const conn of connections) {
    // `conn.is_stealth === true`, not a truthiness check: an absent field
    // (every row today, until the column exists) must route to the
    // ordinary path. A missing field silently reclassifying a connection
    // is the bug next door.
    if (conn.is_stealth === true) {
      skippedPrivateIds.push(conn.id);
    } else {
      syncableIds.push(conn.id);
    }
  }
  return { syncableIds, skippedPrivateIds };
}

export interface SyncAllToast {
  level: 'success' | 'info' | 'warning' | 'error';
  message: string;
}

export interface SyncAllReport {
  toasts: SyncAllToast[];
  /**
   * Requested but absent from the response: never attempted. Surfaced for
   * the console so an operator can see which ids, and asserted in tests so
   * this can never silently fold back into a success count.
   */
  missingIds: string[];
}

/** One entry as `or-sync` returns it. */
export interface SyncAllResultEntry {
  connection_id: string;
  synced: number;
  error?: string;
}

export function reportSyncAll(args: {
  /** The ids actually sent, so absence can be measured against a request. */
  requestedIds: ReadonlyArray<string>;
  returned: ReadonlyArray<SyncAllResultEntry>;
  /** The function's own total. Not recomputed here: it is the source. */
  synced: number;
  skippedPrivateCount: number;
  /**
   * Whether the private-connection scan entry is live in this build. It
   * changes the advice, not the facts: while it is off, telling someone to
   * sync each one individually points them at a button that also does
   * nothing.
   */
  stealthSyncEnabled: boolean;
  /** First error, already run through the app's humanizer by the caller. */
  firstErrorMessage?: string;
}): SyncAllReport {
  const returnedIds = new Set(args.returned.map((r) => r.connection_id));
  const missingIds = args.requestedIds.filter((id) => !returnedIds.has(id));

  const errs = args.returned.filter((r) => r.error);
  const okCount = args.returned.filter((r) => !r.error).length;
  const toasts: SyncAllToast[] = [];

  if (args.requestedIds.length === 0) {
    // Nothing was syncable. Say that, and never say "up to date".
    if (args.skippedPrivateCount > 0) {
      toasts.push({
        level: 'info',
        message: privateSkipMessage(args.skippedPrivateCount, args.stealthSyncEnabled, true),
      });
    } else {
      toasts.push({ level: 'info', message: 'There is nothing to sync.' });
    }
    return { toasts, missingIds };
  }

  if (errs.length > 0) {
    const firstMsg = args.firstErrorMessage || 'Something went wrong.';
    const others = errs.length - 1;
    const suffix = others > 0 ? ` (and ${others} other${others === 1 ? '' : 's'})` : '';
    if (args.synced > 0) {
      toasts.push({
        level: 'warning',
        message: `Synced ${args.synced} across ${okCount} wallet${okCount === 1 ? '' : 's'}; ${errs.length} had trouble: ${firstMsg}${suffix}`,
      });
    } else {
      toasts.push({
        level: 'error',
        message: `${errs.length} connection${errs.length === 1 ? '' : 's'} couldn't sync: ${firstMsg}${suffix}`,
      });
    }
  } else if (args.synced > 0) {
    toasts.push({
      level: 'success',
      message: `Sync all: ${args.synced} transaction${args.synced === 1 ? '' : 's'} across ${okCount} wallet${okCount === 1 ? '' : 's'}.`,
    });
  } else if (missingIds.length === args.requestedIds.length) {
    // Everything we asked about came back absent. Nothing ran at all, so a
    // "no new transactions" reading would be an invention.
    toasts.push({
      level: 'warning',
      message: `Sync all: nothing was attempted for ${plural(missingIds.length, 'connection')}. Try them one at a time, and tell us if that fails too.`,
    });
  } else {
    toasts.push({ level: 'info', message: 'Sync all: no new transactions across any wallet.' });
  }

  // Some ran, some were never touched. The success line above is true for
  // the ones that ran and says nothing about the rest, so the rest get
  // their own.
  if (missingIds.length > 0 && missingIds.length < args.requestedIds.length) {
    toasts.push({
      level: 'warning',
      message: `${plural(missingIds.length, 'connection')} ${missingIds.length === 1 ? 'was' : 'were'} not attempted. Try ${missingIds.length === 1 ? 'it' : 'them'} one at a time.`,
    });
  }

  if (args.skippedPrivateCount > 0) {
    toasts.push({
      level: 'info',
      message: privateSkipMessage(args.skippedPrivateCount, args.stealthSyncEnabled, false),
    });
  }

  return { toasts, missingIds };
}

function privateSkipMessage(count: number, stealthSyncEnabled: boolean, only: boolean): string {
  const subject = plural(count, 'private connection');
  if (stealthSyncEnabled) {
    return only
      ? `${subject} can only be scanned one at a time. Use Sync on each one.`
      : `${subject} ${count === 1 ? 'was' : 'were'} skipped. Use Sync on each one to scan it.`;
  }
  return only
    ? `${subject} can't be synced here yet.`
    : `${subject} ${count === 1 ? 'was' : 'were'} skipped: they can't be synced here yet.`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
