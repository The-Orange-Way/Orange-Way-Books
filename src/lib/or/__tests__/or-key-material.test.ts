/**
 * Tests for the Orange Rails key-material rule and the OPK seed derivation.
 *
 * The rule is pure, so it is tested directly with no vault and no WebCrypto.
 * The seed derivation is not, so it is tested against the real WebCrypto in
 * the test environment, alongside its sibling subkeys, because the property
 * that matters most (they are all different keys) can only be shown by
 * deriving all three and comparing them.
 */
import { describe, it, expect } from 'vitest';
import {
  CURRENT_OR_KEY_EPOCH,
  OrNamespaceDisabledError,
  planOrKeyMaterial,
  type OrKeyMaterialRow,
  type PlanOrKeyMaterialOptions,
} from '@/lib/or/or-key-material';
import {
  deriveOrCredsKeyFromMek,
  deriveOrOpkSeedFromMek,
  deriveOrTxnsKeyFromMek,
} from '@/lib/vault';

const EMPTY: OrKeyMaterialRow = {
  enc_or_mek_ciphertext: null,
  or_subkey_salt: null,
  or_key_epoch: null,
};

const CURRENT_SALT = 'Y3VycmVudC1zYWx0LWJhc2U2NA==';
const PINNED_SALT = 'cGlubmVkLXNhbHQtYmFzZTY0';

/**
 * The caller looked and this org has nothing sealed, so deriving cannot
 * orphan anything. Also the value passed by every test below that is not
 * about the derive gate: those rows are pinned or partly stored, so the
 * derive path is unreachable from them and the evidence is irrelevant. It is
 * spelled out at each call only because the parameter is required.
 */
const NO_ROWS: PlanOrKeyMaterialOptions = { existingRows: { kind: 'no-sealed-rows' } };

/** History exists, and the caller proved the current derivation opens it. */
const PROVEN: PlanOrKeyMaterialOptions = {
  existingRows: { kind: 'derived-key-opens-a-sealed-row' },
};

/** History exists and nothing was proved. The case that must refuse. */
const UNPROVEN: PlanOrKeyMaterialOptions = { existingRows: { kind: 'unproven' } };

describe('planOrKeyMaterial: nothing pinned yet', () => {
  it('derives and pins when the caller established there is nothing sealed', () => {
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, NO_ROWS);
    expect(plan).toEqual({
      mode: 'derive-and-pin',
      saltContext: CURRENT_SALT,
      epoch: CURRENT_OR_KEY_EPOCH,
    });
  });

  it('derives and pins when the derived key was SHOWN to open an existing sealed row', () => {
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, PROVEN);
    expect(plan).toEqual({
      mode: 'derive-and-pin',
      saltContext: CURRENT_SALT,
      epoch: CURRENT_OR_KEY_EPOCH,
    });
  });

  it('REFUSES when rows are already sealed and nothing was proved', () => {
    // The scenario the whole module exists for, and the one a caller used to
    // walk straight into: an account that synced rows under one salt, changed
    // its vault password before pinning existed, and now unlocks normally.
    // The unlock is real, so the old boolean invited the caller to say the
    // salt matched. It does not. Deriving here yields a well formed key that
    // opens none of that account's rows, and pinning it makes that permanent.
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, UNPROVEN);
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/never pinned/i);
    expect(plan.reason).toMatch(/re-sync/i);
  });

  it('carries the caller-supplied cause into the refusal when there is one', () => {
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, {
      existingRows: { kind: 'unproven', detail: 'the trial open failed' },
    });
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toContain('the trial open failed');
  });

  it('REFUSES an evidence variant it does not recognise, rather than deriving', () => {
    // A variant added later, or a caller on an older build, must fall to the
    // safe side. The gate tests for the two PERMITTING shapes, so anything
    // else refuses by default instead of inheriting the destroying path.
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, {
      existingRows: { kind: 'something-invented-later' },
    } as unknown as PlanOrKeyMaterialOptions);
    expect(plan.mode).toBe('refuse');
  });

  it('REFUSES when the caller passes undefined rather than stating the evidence', () => {
    // The shape a caller falls into by accident when it computes the value
    // from a lookup that can come back empty. Absence has to refuse, never
    // derive, so it is checked at runtime and not only in the types.
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, {
      existingRows: undefined,
    } as unknown as PlanOrKeyMaterialOptions);
    expect(plan.mode).toBe('refuse');
  });

  it('REFUSES when the options argument is missing altogether at runtime', () => {
    const untyped = planOrKeyMaterial as unknown as (
      row: OrKeyMaterialRow,
      salt: string,
    ) => ReturnType<typeof planOrKeyMaterial>;
    expect(untyped(EMPTY, CURRENT_SALT).mode).toBe('refuse');
  });

  it('refuses when there is no salt to pin against', () => {
    const plan = planOrKeyMaterial(EMPTY, '', NO_ROWS);
    expect(plan.mode).toBe('refuse');
  });
});

describe('planOrKeyMaterial: fully pinned', () => {
  const pinned: OrKeyMaterialRow = {
    enc_or_mek_ciphertext: 'sealed-key-ciphertext',
    or_subkey_salt: PINNED_SALT,
    or_key_epoch: CURRENT_OR_KEY_EPOCH,
  };

  it('unwraps using the PINNED salt, not the salt in force now', () => {
    const plan = planOrKeyMaterial(pinned, CURRENT_SALT, NO_ROWS);
    expect(plan).toEqual({
      mode: 'unwrap',
      ciphertext: 'sealed-key-ciphertext',
      saltContext: PINNED_SALT,
    });
  });

  it('unwraps regardless of what the current salt is, which is the whole point', () => {
    const a = planOrKeyMaterial(pinned, CURRENT_SALT, NO_ROWS);
    const b = planOrKeyMaterial(pinned, 'a-completely-different-salt', NO_ROWS);
    expect(a).toEqual(b);
  });

  it('unwraps regardless of the evidence, because the derive path is unreachable here', () => {
    const a = planOrKeyMaterial(pinned, CURRENT_SALT, NO_ROWS);
    const b = planOrKeyMaterial(pinned, CURRENT_SALT, UNPROVEN);
    expect(a).toEqual(b);
    expect(a.mode).toBe('unwrap');
  });

  it('refuses a generation NEWER than this build understands', () => {
    const plan = planOrKeyMaterial(
      { ...pinned, or_key_epoch: CURRENT_OR_KEY_EPOCH + 1 },
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('refuse');
  });

  it('refuses a generation OLDER than this build understands', () => {
    const plan = planOrKeyMaterial(
      { ...pinned, or_key_epoch: CURRENT_OR_KEY_EPOCH - 1 },
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('refuse');
  });

  it('reads a generation that arrives as a STRING, which is how a numeric column comes back', () => {
    // PostgREST returns a Postgres numeric as a JSON string and only the
    // integer types as a JSON number. If the string form read as absent, a
    // fully pinned row would look half established and the namespace would be
    // disabled for exactly the customers who do have the material, with a
    // message naming the wrong cause.
    const plan = planOrKeyMaterial(
      { ...pinned, or_key_epoch: String(CURRENT_OR_KEY_EPOCH) },
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('unwrap');
  });

  it('refuses a STRING generation it does not understand, rather than unwrapping it', () => {
    const plan = planOrKeyMaterial(
      { ...pinned, or_key_epoch: String(CURRENT_OR_KEY_EPOCH + 1) },
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('refuse');
  });

  it('treats a generation that is not a whole number as absent, never as current', () => {
    for (const bad of [1.5, Number.NaN, 'one', '1.5', '']) {
      const plan = planOrKeyMaterial({ ...pinned, or_key_epoch: bad }, CURRENT_SALT, NO_ROWS);
      expect(plan.mode).toBe('refuse');
    }
  });
});

describe('planOrKeyMaterial: partly stored', () => {
  it('refuses when the sealed key is missing and names what is missing', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: null, or_subkey_salt: PINNED_SALT, or_key_epoch: 1 },
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/the sealed key/);
  });

  it('refuses when the pinned salt is missing', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: 'x', or_subkey_salt: null, or_key_epoch: 1 },
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/its salt/);
  });

  it('refuses when the generation is missing', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: 'x', or_subkey_salt: PINNED_SALT, or_key_epoch: null },
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/its generation/);
  });

  it('never answers derive-and-pin from a partial state', () => {
    const partials: OrKeyMaterialRow[] = [
      { enc_or_mek_ciphertext: 'x', or_subkey_salt: null, or_key_epoch: null },
      { enc_or_mek_ciphertext: null, or_subkey_salt: PINNED_SALT, or_key_epoch: null },
      { enc_or_mek_ciphertext: null, or_subkey_salt: null, or_key_epoch: 1 },
      { enc_or_mek_ciphertext: 'x', or_subkey_salt: PINNED_SALT, or_key_epoch: null },
    ];
    for (const row of partials) {
      expect(planOrKeyMaterial(row, CURRENT_SALT, NO_ROWS).mode).toBe('refuse');
    }
  });
});

describe('planOrKeyMaterial: an empty string is a bad write, not an empty column', () => {
  // These are asserted here rather than deferred to the Books migration,
  // which has not been written. An empty string is evidence that something
  // wrote and got it wrong, so it must read as a partial state whatever the
  // eventual column definitions turn out to be, including NOT NULL
  // DEFAULT ''. If they had read as absent instead, a row of three empty
  // strings would have fallen through to derive-and-pin.

  it('refuses an empty ciphertext rather than treating it as a usable key', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: '', or_subkey_salt: PINNED_SALT, or_key_epoch: 1 },
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/partly stored/);
  });

  it('refuses an empty pinned salt', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: 'x', or_subkey_salt: '', or_key_epoch: 1 },
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/partly stored/);
  });

  it('refuses an empty generation', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: 'x', or_subkey_salt: PINNED_SALT, or_key_epoch: '' },
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/partly stored/);
  });

  it('does NOT derive-and-pin from a row of three empty strings', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: '', or_subkey_salt: '', or_key_epoch: '' },
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/partly stored/);
  });

  it('still derives from an all-null row, so the empty-string rule has not broken setup', () => {
    expect(planOrKeyMaterial(EMPTY, CURRENT_SALT, NO_ROWS).mode).toBe('derive-and-pin');
  });
});

describe('OrNamespaceDisabledError', () => {
  it('survives instanceof and carries the reason separately from the message', () => {
    const err = new OrNamespaceDisabledError('the salt rotated');
    expect(err).toBeInstanceOf(OrNamespaceDisabledError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('OrNamespaceDisabledError');
    expect(err.reason).toBe('the salt rotated');
    expect(err.message).toContain('the salt rotated');
  });
});

describe('deriveOrOpkSeedFromMek', () => {
  const MEK = new Uint8Array(32).fill(7);
  const OTHER_MEK = new Uint8Array(32).fill(8);

  const hex = (bytes: Uint8Array) =>
    Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  it('returns exactly 32 bytes, the seed length the keypair generator takes', async () => {
    const seed = await deriveOrOpkSeedFromMek(MEK, CURRENT_SALT);
    expect(seed).toBeInstanceOf(Uint8Array);
    expect(seed.length).toBe(32);
  });

  it('is deterministic, so every device reproduces the same keypair', async () => {
    const a = await deriveOrOpkSeedFromMek(MEK, CURRENT_SALT);
    const b = await deriveOrOpkSeedFromMek(MEK, CURRENT_SALT);
    expect(hex(a)).toBe(hex(b));
  });

  it('moves when the salt moves', async () => {
    const a = await deriveOrOpkSeedFromMek(MEK, CURRENT_SALT);
    const b = await deriveOrOpkSeedFromMek(MEK, PINNED_SALT);
    expect(hex(a)).not.toBe(hex(b));
  });

  it('moves when the key material moves', async () => {
    const a = await deriveOrOpkSeedFromMek(MEK, CURRENT_SALT);
    const b = await deriveOrOpkSeedFromMek(OTHER_MEK, CURRENT_SALT);
    expect(hex(a)).not.toBe(hex(b));
  });

  it('is a different key from the credentials and transactions subkeys', async () => {
    const seed = await deriveOrOpkSeedFromMek(MEK, CURRENT_SALT);
    const creds = await deriveOrCredsKeyFromMek(MEK, CURRENT_SALT);
    const txns = await deriveOrTxnsKeyFromMek(MEK, CURRENT_SALT);

    const credsBytes = new Uint8Array(await window.crypto.subtle.exportKey('raw', creds));
    const txnsBytes = new Uint8Array(await window.crypto.subtle.exportKey('raw', txns));

    expect(hex(seed)).not.toBe(hex(credsBytes));
    expect(hex(seed)).not.toBe(hex(txnsBytes));
    expect(hex(credsBytes)).not.toBe(hex(txnsBytes));
  });
});
