/**
 * Deciding where the Orange Rails key material comes from.
 *
 * Mirrors the same module in the personal app so the two products stay
 * design twins. The reasoning below is the reason this module exists at all,
 * so it is carried across rather than summarised away.
 *
 * THE DEFECT THIS EXISTS TO CLOSE. The Orange Rails subkeys are derived from
 * the vault password and the org salt (see deriveOrCredsKeyFromMek and
 * deriveOrTxnsKeyFromMek in src/lib/vault.ts). Changing a vault password
 * regenerates that salt, so the subkeys change, and every row sealed under
 * the previous ones can never be opened again by anyone, including us. The
 * recovery path does the same thing for the same reason. The rows survive,
 * the key does not.
 *
 * THE FIX IS NOT TO RE-ENCRYPT ANYTHING. It is to stop re-deriving a key we
 * already have. The Orange Rails key keeps its CURRENT value and gets stored
 * wrapped under the vault key, which is a random key that is wrapped rather
 * than derived, and therefore already survives a password change and is
 * already recoverable from the recovery code. Because the value does not
 * change, no sealed row anywhere needs touching.
 *
 * TWO THINGS MUST BE PINNED, NOT ONE. The subkeys take the salt as an HKDF
 * salt context, so pinning the key while letting the salt rotate would still
 * move every subkey. `or_subkey_salt` pins the salt that was in force when
 * the material was established.
 *
 * This module is PURE and holds no crypto. It answers only "derive, unwrap,
 * or refuse", so the rule can be tested without WebCrypto and without a
 * vault. The caller performs whichever of the three it is told.
 *
 * NOT YET WIRED. Nothing in Books reads or writes these columns today. This
 * lands first, on its own, so the rule is reviewable before anything depends
 * on it.
 */

/**
 * The generation of the pinned Orange Rails key material this build writes
 * and understands.
 *
 * Why a number and not a boolean "is pinned". The pinned pair is a contract
 * between whatever sealed the rows and whatever opens them, and the one
 * failure this whole design exists to remove is a client confidently using
 * key material whose meaning has moved underneath it. A version makes that
 * detectable rather than silent: a client that meets a generation it does not
 * know refuses, instead of unwrapping bytes that are no longer what it
 * assumes.
 *
 * Bump this ONLY when the meaning of the pinned pair changes, never for an
 * unrelated schema change. Bumping it makes every older client refuse, which
 * is correct on a genuine format change and gratuitous otherwise.
 */
export const CURRENT_OR_KEY_EPOCH = 1;

/** The stored state, as read from the vault metadata row. */
export interface OrKeyMaterialRow {
  /** Orange Rails key sealed under the vault key. Null until established. */
  enc_or_mek_ciphertext: string | null;
  /** The org salt in force when the above was established. Null until then. */
  or_subkey_salt: string | null;
  /**
   * Generation of the pinned pair. Null until established.
   *
   * Typed to accept a string as well as a number, and that is deliberate.
   * PostgREST returns a Postgres `numeric` as a JSON STRING and only the
   * integer types as a JSON number, so a strict `typeof === 'number'` test
   * would read a fully pinned row as half established the moment the column
   * were declared numeric, and would disable the namespace for every customer
   * who actually has the material while naming the wrong cause. The column
   * must be declared `integer` when the Books migration is written (the
   * personal twin already declares it that way), and this type accepts the
   * string form so the client is not what breaks if it ever is not.
   */
  or_key_epoch: number | string | null;
}

export type OrKeyMaterialPlan =
  | {
      /**
       * Nothing is pinned yet, and the caller has shown that deriving cannot
       * destroy anything: either this org has no sealed Orange Rails rows at
       * all, or the key this derivation produces was proven to open one. Pin
       * the derived value so no later password change can move it again.
       */
      mode: 'derive-and-pin';
      saltContext: string;
      epoch: number;
    }
  | {
      /** Pinned. Use it, and never mind what the password or salt now are. */
      mode: 'unwrap';
      ciphertext: string;
      saltContext: string;
    }
  | {
      /**
       * The stored state cannot be used. The caller must NOT fall back to
       * deriving: after a rotation, deriving produces a key that opens
       * nothing while looking exactly like success, which is the original
       * defect.
       *
       * The caller also must not fail the unlock over this. The customer's
       * vault is not in question here, only the Orange Rails namespace, and
       * locking someone out of their own books is a worse outcome than the
       * bug being fixed. The namespace is disabled and says so, loudly.
       */
      mode: 'refuse';
      reason: string;
    };

/**
 * What the caller has established about rows that were ALREADY sealed with
 * the Orange Rails subkeys for this org.
 *
 * This replaced a boolean called `saltMatchesExistingRows`, and the reason is
 * worth keeping. That flag asked the caller to assert that the salt in force
 * is the salt the existing rows were written against, and its own
 * documentation said an unlock or a vault creation makes that true. It does
 * not. An account that changed its vault password before pinning existed has
 * a new salt, nothing pinned, and no record anywhere of the old one, so on
 * the next unlock a caller doing exactly what the comment said would derive
 * against the wrong salt and pin the result. Nothing in the product records
 * salt history, so the honest answer to the old question was always "I cannot
 * know", and a parameter whose only honest answer is refuse should not be
 * phrased as a claim the caller is invited to make.
 *
 * These four are phrased as things a caller can go and find out.
 *
 * - `none`: there are no sealed Orange Rails rows for this org. Deriving is
 *   safe whatever the salt has done, because there is nothing that has to
 *   keep opening. Establish it by counting the rows, not by assuming a new
 *   account.
 * - `opens-with-candidate`: sealed rows exist, and the key this plan would
 *   derive was tried against one and opened it. That is proof rather than
 *   inference, and it is the path that lets an existing customer pin without
 *   a re-sync.
 * - `present-unverified`: sealed rows exist and no such attempt was made or
 *   it failed. Refuses.
 * - `unknown`: the caller could not check. Refuses, because "I do not know"
 *   is precisely the state in which deriving is unsafe.
 */
export type SealedRowEvidence = 'none' | 'opens-with-candidate' | 'present-unverified' | 'unknown';

export interface PlanOrKeyMaterialOptions {
  /**
   * REQUIRED, and required on purpose. It was once optional and defaulted to
   * the deriving outcome, so a caller computing it from a lookup and passing
   * `undefined` got the destructive path with nothing to flag it. Absence
   * must refuse. The check below is an explicit allow-list of the two safe
   * values rather than a test for the unsafe ones, so an untyped caller
   * passing undefined, null or a misspelt string at runtime is refused too.
   */
  existingSealedRows: SealedRowEvidence;
}

/**
 * Read the stored generation, accepting both shapes PostgREST can hand back.
 *
 * A Postgres `integer` arrives as a JSON number and a `numeric` arrives as a
 * JSON string, so a client that accepts only a number is one column-type
 * choice away from reading every fully pinned row as half established.
 *
 * Anything that is not a whole number, in either shape, is treated as absent
 * rather than coerced. A fractional or unparseable generation is not a
 * generation, and guessing at one is the class of thing this module exists to
 * refuse. Both shapes require a SAFE integer, so a magnitude beyond exact
 * representation is refused whichever way it arrives, rather than being
 * accepted as a number and rejected as its own string spelling.
 */
function readEpoch(raw: number | string | null): number | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) ? raw : null;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** Present means the column holds something. It does not mean it is usable. */
function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * Decide, from what is stored, how to obtain the Orange Rails key material.
 *
 * The half-established cases are refusals rather than repairs on purpose. One
 * column without the others means something wrote a partial state, and the
 * two possible repairs (derive a fresh key, or reuse the current salt) both
 * silently produce a key that opens nothing if the salt has since rotated.
 * Guessing here is how a data-loss bug hides itself for months. Refusing is
 * visible on the first attempt.
 *
 * An empty string counts as a partial state, not as a blank one. Empty is
 * evidence that a write went wrong partway, and the difference matters: read
 * as absent, a row holding '' falls through to deriving, which is the
 * destructive answer. This does not depend on how the eventual Books
 * migration declares its defaults, which is the point of deciding it here.
 *
 * @param row      what the vault metadata row holds for this org. A missing
 *                 row is an unreadable state, not an empty one, and refuses.
 * @param orgSalt  the salt in force right now, used only when pinning
 * @param options  what the caller established about rows already sealed. See
 *                 SealedRowEvidence: only proof that nothing can be lost
 *                 permits deriving.
 */
export function planOrKeyMaterial(
  row: OrKeyMaterialRow,
  orgSalt: string,
  options: PlanOrKeyMaterialOptions,
): OrKeyMaterialPlan {
  // The row itself has to be a row. Every read below is optional-chained, so a
  // null or undefined row yields undefined three times and looks exactly like a
  // row whose three columns are genuinely null. Those two states mean opposite
  // things: a row of nulls is a fresh account with nothing to lose, a missing
  // row is a read that did not complete. Falling through would answer
  // derive-and-pin for a lookup we never got an answer from, which is the
  // destructive guess this module exists to refuse.
  if (row === null || typeof row !== 'object') {
    return {
      mode: 'refuse',
      reason:
        'Orange Rails key material could not be read: no vault metadata row was available, so whether anything is pinned is unknown. Deriving in that state could produce a key that opens none of the rows already synced, so it is refused.',
    };
  }

  const ciphertextPresent = isPresent(row?.enc_or_mek_ciphertext);
  const saltPresent = isPresent(row?.or_subkey_salt);
  const epochPresent = isPresent(row?.or_key_epoch);

  const ciphertextUsable =
    typeof row?.enc_or_mek_ciphertext === 'string' && row.enc_or_mek_ciphertext.length > 0;
  const saltUsable = typeof row?.or_subkey_salt === 'string' && row.or_subkey_salt.length > 0;
  const epoch = readEpoch(row?.or_key_epoch ?? null);

  if (ciphertextUsable && saltUsable && epoch !== null) {
    if (epoch !== CURRENT_OR_KEY_EPOCH) {
      // Deliberately refuses in BOTH directions. A newer generation means
      // this build is the stale one and must not guess at a format it
      // predates. An older generation means a migration exists that has not
      // been written, and treating the material as current would be assuming
      // that migration was a no-op.
      return {
        mode: 'refuse',
        reason: `Orange Rails key material is generation ${epoch} and this app understands generation ${CURRENT_OR_KEY_EPOCH}.`,
      };
    }
    return {
      mode: 'unwrap',
      ciphertext: row.enc_or_mek_ciphertext as string,
      saltContext: row.or_subkey_salt as string,
    };
  }

  if (ciphertextPresent || saltPresent || epochPresent) {
    const missing = [
      ciphertextUsable ? null : 'the sealed key',
      saltUsable ? null : 'its salt',
      epoch !== null ? null : 'its generation',
    ].filter((x): x is string => x !== null);
    return {
      mode: 'refuse',
      reason: `Orange Rails key material is partly stored: ${missing.join(' and ')} missing or empty, so the subkeys cannot be reproduced.`,
    };
  }

  if (typeof orgSalt !== 'string' || orgSalt.length === 0) {
    return {
      mode: 'refuse',
      reason: 'No vault salt is available to pin Orange Rails key material against.',
    };
  }

  const evidence = options?.existingSealedRows;
  if (evidence !== 'none' && evidence !== 'opens-with-candidate') {
    // Nothing is pinned, and the caller has not shown that deriving costs
    // nothing. Deriving here is what silently destroys history: it yields a
    // well formed key, pins it as authoritative, reports success, and every
    // row the customer already synced stops opening forever with nothing on
    // screen to say so. An unstated fact is not evidence of safety, so
    // `unknown` and a missing option refuse on the same footing as rows that
    // are known to exist unverified.
    return {
      mode: 'refuse',
      reason:
        'Orange Rails key material was never pinned for this account, and it is not established that deriving now reproduces the key that sealed the rows already synced. Deriving could produce a key that opens none of them, so it is refused. Either prove the derived key opens an existing sealed row, or re-sync anything synced before this point.',
    };
  }

  return { mode: 'derive-and-pin', saltContext: orgSalt, epoch: CURRENT_OR_KEY_EPOCH };
}

/**
 * Thrown by the Orange Rails accessors when the vault IS unlocked but the
 * Orange Rails namespace is not usable.
 *
 * A named class rather than a message convention, because the caller's
 * correct response differs completely from the other failure in this area.
 * "Vault is locked" means ask for the password. This means the password will
 * not help, so a surface should disable itself and say why. Matching on
 * message text would make every consumer depend on wording that a copy edit
 * can break, and a broad catch would swallow real errors, which is exactly
 * what a banner built on one must not do.
 */
export class OrNamespaceDisabledError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Orange Rails is unavailable in this session: ${reason}`);
    this.name = 'OrNamespaceDisabledError';
    this.reason = reason;
    // Required for `instanceof` to survive the ES5 downlevel target.
    Object.setPrototypeOf(this, OrNamespaceDisabledError.prototype);
  }
}
