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
  /** Generation of the pinned pair. Null until established. */
  or_key_epoch: number | null;
}

export type OrKeyMaterialPlan =
  | {
      /**
       * Nothing is pinned yet. Derive the legacy value exactly as before and
       * pin it. This is correct only at a moment when the password and the
       * current salt still produce the value that existing rows were sealed
       * under, which means an unlock or a vault creation.
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

export interface PlanOrKeyMaterialOptions {
  /**
   * Whether `orgSalt` is still the salt that already-sealed rows were sealed
   * under.
   *
   * True on an unlock or a vault creation: the salt in force is the salt the
   * existing rows were written against, so deriving reproduces the same key.
   *
   * False during recovery, which mints a NEW salt before it gets here.
   * Deriving against that salt produces 32 bytes with no relationship to the
   * old ones, and pinning them makes the loss permanent. Recovery also cannot
   * repair the row, because reproducing the old key needs the OLD password
   * and recovery by definition does not have it. So refusing is not a policy
   * preference, it is the only outcome that is not a lie.
   *
   * Omitted defaults to true, which preserves the unlock and create paths.
   * Any production caller should pass it explicitly so it cannot inherit that
   * default by accident.
   */
  saltMatchesExistingRows?: boolean;
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
 * @param row      what the vault metadata row holds for this org
 * @param orgSalt  the salt in force right now, used only when pinning
 */
export function planOrKeyMaterial(
  row: OrKeyMaterialRow,
  orgSalt: string,
  options: PlanOrKeyMaterialOptions = {},
): OrKeyMaterialPlan {
  const hasCiphertext =
    typeof row.enc_or_mek_ciphertext === 'string' && row.enc_or_mek_ciphertext.length > 0;
  const hasSalt = typeof row.or_subkey_salt === 'string' && row.or_subkey_salt.length > 0;
  const hasEpoch = typeof row.or_key_epoch === 'number' && Number.isFinite(row.or_key_epoch);

  if (hasCiphertext && hasSalt && hasEpoch) {
    const epoch = row.or_key_epoch as number;
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

  const anyPresent = hasCiphertext || hasSalt || hasEpoch;
  if (anyPresent) {
    const missing = [
      hasCiphertext ? null : 'the sealed key',
      hasSalt ? null : 'its salt',
      hasEpoch ? null : 'its generation',
    ].filter((x): x is string => x !== null);
    return {
      mode: 'refuse',
      reason: `Orange Rails key material is partly stored: ${missing.join(' and ')} missing, so the subkeys cannot be reproduced.`,
    };
  }

  if (typeof orgSalt !== 'string' || orgSalt.length === 0) {
    return {
      mode: 'refuse',
      reason: 'No vault salt is available to pin Orange Rails key material against.',
    };
  }

  if (options.saltMatchesExistingRows === false) {
    // Nothing is pinned AND the salt just rotated.
    // Deriving here is what silently destroys history: it yields a well
    // formed key, pins it as authoritative, reports success, and every row
    // the customer already synced stops opening forever with nothing on
    // screen to say so.
    return {
      mode: 'refuse',
      reason:
        'Orange Rails key material was never pinned for this account and the vault salt has just changed, so the key that opened existing rows cannot be reproduced. Anything synced before this point needs a re-sync.',
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
