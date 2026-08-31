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
 *
 * WHAT THE FIRST CALLER MUST DO. Books already seals Orange Rails rows
 * today: src/pages/Connections.tsx encrypts a connection's label and its
 * credentials with the credentials subkey, and that subkey is derived from
 * the vault password and the org salt. So accounts whose history was sealed
 * under a salt that has since rotated can exist here, and no caller may
 * assume otherwise. Before it may take the derive-and-pin path a caller has
 * to establish one of the two facts in SealedRowEvidence, by looking rather
 * than by asserting.
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
       * Nothing is pinned yet, and the caller has SHOWN that deriving is
       * safe: either nothing was ever sealed, or the key derived from the
       * password and salt in force now demonstrably opens a row that was.
       * Derive the legacy value exactly as before and pin it.
       *
       * Being on an unlock is not by itself that showing. An account that
       * changed its vault password before pinning existed unlocks perfectly
       * normally, and its current salt no longer matches its own rows.
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
 * What the caller has ESTABLISHED about rows this org already sealed under
 * the legacy derivation.
 *
 * This replaces a boolean called `saltMatchesExistingRows`, whose own doc
 * told callers to pass true "on an unlock or a vault creation". That
 * sentence is false for any account that rotated its vault password before
 * pinning existed. Such an account really is on an unlock, and its current
 * salt really is not the salt its rows were sealed under. A caller following
 * the comment derived against the new salt, pinned it as authoritative and
 * reported success, while every row already synced stopped opening forever.
 * That is the exact data-loss outcome this module exists to prevent, reached
 * through the documented path rather than an accidental one, and the flag
 * could not be checked by anyone: it asked for a belief and turned it into a
 * permanent fact.
 *
 * The distinction that makes it fixable is that PINNING destroys history,
 * not deriving. Deriving a candidate key and trying it against a row that is
 * already sealed costs one AES-GCM open and settles the question outright.
 * So this asks for evidence instead, and every variant below is something a
 * caller can actually go and check.
 *
 * The module stays pure. The caller performs the check; this decides what
 * the result permits.
 */
export type SealedRowEvidence =
  | {
      /**
       * The caller looked, and this org has no Orange Rails rows sealed
       * under the legacy derivation at all. Deriving cannot orphan
       * anything, because there is nothing to orphan. True of a new vault,
       * and true of a recovery on an account that never connected anything.
       */
      kind: 'no-sealed-rows';
    }
  | {
      /**
       * The caller derived the candidate key from the password and salt in
       * force right now and used it to open a row this org had already
       * sealed. The open succeeded, so the current derivation does
       * reproduce the key those rows were written under. That is proof
       * rather than a claim, and it is the only positive evidence that
       * permits pinning on an account that already has history.
       */
      kind: 'derived-key-opens-a-sealed-row';
    }
  | {
      /**
       * Everything else: sealed rows exist and nothing was proved, the
       * check could not run, or the trial open failed. All three mean the
       * same thing here, so all three refuse. "I do not know" is precisely
       * the state in which deriving is unsafe.
       */
      kind: 'unproven';
      /** Optional detail, surfaced in the refusal so the cause is legible. */
      detail?: string;
    };

export interface PlanOrKeyMaterialOptions {
  /**
   * REQUIRED, and required on purpose. This was once an optional boolean
   * whose default pointed at the destroying outcome, so a caller computing
   * it from a lookup and passing `undefined` got derive-and-pin, which
   * TypeScript would not have flagged. Absence must refuse rather than
   * destroy, which is why the check below tests for the two PERMITTING
   * shapes explicitly instead of testing for the refusing one: an omitted
   * argument, an untyped `undefined`, and any variant added here later all
   * refuse by default rather than inheriting the derive path.
   */
  existingRows: SealedRowEvidence;
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
 * @param options  what the caller ESTABLISHED about rows already sealed.
 *                 Required: see SealedRowEvidence for why a belief is not
 *                 accepted in its place.
 */
export function planOrKeyMaterial(
  row: OrKeyMaterialRow,
  orgSalt: string,
  options: PlanOrKeyMaterialOptions,
): OrKeyMaterialPlan {
  // Two different questions, and collapsing them into one is what left the
  // empty-string case resting on a migration nobody has written yet.
  // "Usable" is what the unwrap path needs. "Written" is what decides
  // whether something has already touched this row, and an empty string is
  // evidence of a write that went wrong, not evidence of nothing having
  // happened. Keeping them apart means the refusal holds whatever the
  // eventual column definitions turn out to be, including NOT NULL
  // DEFAULT ''.
  const usableCiphertext =
    typeof row.enc_or_mek_ciphertext === 'string' && row.enc_or_mek_ciphertext.length > 0;
  const usableSalt = typeof row.or_subkey_salt === 'string' && row.or_subkey_salt.length > 0;
  const epoch = readEpoch(row.or_key_epoch);
  const hasEpoch = epoch !== null;

  const writtenCiphertext = typeof row.enc_or_mek_ciphertext === 'string';
  const writtenSalt = typeof row.or_subkey_salt === 'string';
  const writtenEpoch = row.or_key_epoch !== null;

  if (usableCiphertext && usableSalt && epoch !== null) {
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

  const anyWritten = writtenCiphertext || writtenSalt || writtenEpoch;
  if (anyWritten) {
    const missing = [
      usableCiphertext ? null : 'the sealed key',
      usableSalt ? null : 'its salt',
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

  const evidence: SealedRowEvidence | undefined = options?.existingRows;
  const permitsDeriving =
    evidence?.kind === 'no-sealed-rows' || evidence?.kind === 'derived-key-opens-a-sealed-row';

  if (!permitsDeriving) {
    // Nothing is pinned, and neither of the two things that make deriving
    // safe has been established: that there is no history to orphan, or
    // that the current derivation still opens the history there is.
    //
    // Deriving here is what silently destroys history: it yields a well
    // formed key, pins it as authoritative, reports success, and every row
    // the customer already synced stops opening forever with nothing on
    // screen to say so.
    const why =
      'Orange Rails key material was never pinned for this account, and it has not been established that the key derived from the vault password and salt in force now still opens the rows already sealed. Pinning a derived key here could make every one of those rows permanently unopenable, so it is refused. Either show that an existing sealed row opens, or accept that anything synced before this point needs a re-sync.';
    const detail = evidence && evidence.kind === 'unproven' ? evidence.detail : undefined;
    return { mode: 'refuse', reason: detail ? `${why} Cause: ${detail}.` : why };
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
