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

/**
 * What the caller has ESTABLISHED, BY LOOKING, about Orange Rails rows that
 * are already sealed for this org.
 *
 * This replaced a boolean named `saltMatchesExistingRows`, and the reason is
 * worth carrying. That flag asked the caller to assert that the salt in force
 * is the salt the existing rows were sealed under, and its own comment said
 * that was true "on an unlock or a vault creation". It is not. An account that
 * synced rows under one salt, changed its vault password before pinning
 * existed, and then unlocks under this build has a new salt and old rows. A
 * caller following that comment passes true, this module answers
 * derive-and-pin, and the result is a well formed key that opens none of the
 * customer's rows, pinned as authoritative and reported as success. The salt
 * is not recorded next to the sealed rows, so no caller can check the thing
 * the flag asked it to assert.
 *
 * So the caller is not asked what it believes. It is asked what it found.
 *
 * 'none'
 *   The caller looked, and there are no Orange Rails rows sealed for this org.
 *   Deriving cannot orphan anything because there is nothing to orphan. This
 *   is the ordinary case: a new vault, or an org that has never synced.
 *
 * 'opens-with-derived-key'
 *   The caller derived the legacy value from the salt in force and PROVED it
 *   opens a row that is already sealed. This is the only form of "the salt
 *   still matches" that is evidence rather than a claim, and pinning a key
 *   that has just been shown to open real data is safe by construction. It
 *   exists so an account that predates pinning is not made to re-sync when
 *   its salt has in fact never moved.
 *
 * 'present'
 *   Sealed rows exist, nothing is pinned, and the derived key was not shown
 *   to open them. Which salt they were sealed under cannot be recovered, so
 *   there is no honest answer but to refuse and say those rows need a
 *   re-sync.
 *
 * 'unknown'
 *   The caller did not look, or could not. Absence of evidence is the state in
 *   which deriving is least safe. It is spelled as a value rather than left to
 *   a default so that a caller has to write it down.
 */
export type OrSealedRowsEvidence = 'none' | 'opens-with-derived-key' | 'present' | 'unknown';

export interface PlanOrKeyMaterialOptions {
  /**
   * REQUIRED, and required on purpose. This was once optional and defaulted
   * to the permissive answer, which pointed absence at the destroying
   * outcome: a caller computing it from a lookup and passing `undefined`
   * (which TypeScript would not have flagged while it was optional) got
   * derive-and-pin. "I do not know" is precisely the state in which deriving
   * is unsafe. It is also re-checked at runtime below, because the type alone
   * does not stop an untyped caller passing undefined.
   */
  sealedRows: OrSealedRowsEvidence;
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
 * refuse.
 */
function readEpoch(raw: number | string | null): number | null {
  if (typeof raw === 'number') return Number.isInteger(raw) ? raw : null;
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    const parsed = Number.parseInt(raw.trim(), 10);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
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
 * @param options  what the caller established about rows already sealed for
 *                 this org. Required: see OrSealedRowsEvidence for why a
 *                 caller is asked what it found rather than what it believes.
 */
export function planOrKeyMaterial(
  row: OrKeyMaterialRow,
  orgSalt: string,
  options: PlanOrKeyMaterialOptions,
): OrKeyMaterialPlan {
  const hasCiphertext =
    typeof row.enc_or_mek_ciphertext === 'string' && row.enc_or_mek_ciphertext.length > 0;
  const hasSalt = typeof row.or_subkey_salt === 'string' && row.or_subkey_salt.length > 0;
  const epoch = readEpoch(row.or_key_epoch);
  const hasEpoch = epoch !== null;

  // A column that is STORED but unusable (an empty string, a generation that
  // is not a whole number) is evidence of a write that went wrong, not
  // evidence that nothing was ever written. Reading it as absent would let a
  // failed seal fall through to derive-and-pin, which is the one outcome this
  // module must never reach by accident.
  //
  // Checked against the VALUE rather than against a column definition on
  // purpose. The Books migration that declares these columns is not written
  // yet, so if it ever lands as NOT NULL DEFAULT '' the rule here is already
  // correct instead of becoming wrong on the day of the migration.
  const stored = (value: unknown) => value !== null && value !== undefined;
  const wroteSomethingUnusable =
    (stored(row.enc_or_mek_ciphertext) && !hasCiphertext) ||
    (stored(row.or_subkey_salt) && !hasSalt) ||
    (stored(row.or_key_epoch) && !hasEpoch);
  if (wroteSomethingUnusable) {
    return {
      mode: 'refuse',
      reason:
        'Orange Rails key material holds a value that cannot be read, so a write went wrong rather than never happening and the subkeys cannot be reproduced.',
    };
  }

  if (hasCiphertext && hasSalt && epoch !== null) {
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

  const evidence = options?.sealedRows;
  if (evidence !== 'none' && evidence !== 'opens-with-derived-key') {
    // Nothing is pinned, and the caller has not established that deriving is
    // harmless. Deriving here is what silently destroys history: it yields a
    // well formed key, pins it as authoritative, reports success, and every
    // row the customer already synced stops opening forever with nothing on
    // screen to say so. Refusing costs a re-sync. Deriving costs the books.
    //
    // The two branches are separated because the customer-facing consequence
    // differs: one is a state we can describe exactly, the other is a state
    // nobody looked at, and saying so is more useful than one message that
    // covers both.
    return {
      mode: 'refuse',
      reason:
        evidence === 'present'
          ? 'Orange Rails key material was never pinned for this account and rows are already sealed under a salt that can no longer be identified, so the key that opened them cannot be reproduced. Those rows need a re-sync.'
          : 'Orange Rails key material was never pinned for this account, and it was not established whether any rows are already sealed, so deriving now could produce a key that opens none of them. Anything synced before this point needs a re-sync.',
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
