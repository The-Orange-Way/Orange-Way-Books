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
 * The ordinary finding that permits deriving: the caller looked and there is
 * nothing sealed, so deriving cannot orphan anything. Spelled out at every
 * call, because a caller of this module should never be able to inherit the
 * permissive answer by omission.
 */
const NO_SEALED_ROWS: PlanOrKeyMaterialOptions = { sealedRows: 'none' };

describe('planOrKeyMaterial: nothing pinned yet', () => {
  it('derives and pins when the caller found no sealed rows', () => {
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, NO_SEALED_ROWS);
    expect(plan).toEqual({
      mode: 'derive-and-pin',
      saltContext: CURRENT_SALT,
      epoch: CURRENT_OR_KEY_EPOCH,
    });
  });

  it('derives and pins when the derived key was PROVEN to open an existing sealed row', () => {
    // The only form of "the salt still matches" that is evidence rather than
    // a claim. It exists so an account that predates pinning is not made to
    // re-sync when its salt has in fact never moved.
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, {
      sealedRows: 'opens-with-derived-key',
    });
    expect(plan).toEqual({
      mode: 'derive-and-pin',
      saltContext: CURRENT_SALT,
      epoch: CURRENT_OR_KEY_EPOCH,
    });
  });

  it('REFUSES when sealed rows exist and the derived key was not shown to open them', () => {
    // The account that rotated its vault password before pinning existed:
    // new salt, old rows, and nothing anywhere that records which salt those
    // rows were sealed under. Deriving would look exactly like success.
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, { sealedRows: 'present' });
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/never pinned/i);
    expect(plan.reason).toMatch(/re-sync/i);
  });

  it('REFUSES when the caller did not look', () => {
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, { sealedRows: 'unknown' });
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/re-sync/i);
  });

  it('REFUSES when the caller passes undefined rather than stating what it found', () => {
    // The shape a recovery-path caller falls into by accident:
    // { sealedRows: fetched?.finding } is the value or undefined, which
    // TypeScript did not complain about while the option was optional.
    // Absence has to refuse, never derive, so it is checked at runtime and
    // not only in the types.
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, {
      sealedRows: undefined,
    } as unknown as PlanOrKeyMaterialOptions);
    expect(plan.mode).toBe('refuse');
  });

  it('REFUSES an unrecognised finding rather than treating it as permissive', () => {
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, {
      sealedRows: 'probably-fine',
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
    const plan = planOrKeyMaterial(EMPTY, '', NO_SEALED_ROWS);
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
    const plan = planOrKeyMaterial(pinned, CURRENT_SALT, NO_SEALED_ROWS);
    expect(plan).toEqual({
      mode: 'unwrap',
      ciphertext: 'sealed-key-ciphertext',
      saltContext: PINNED_SALT,
    });
  });

  it('unwraps regardless of what the current salt is, which is the whole point', () => {
    const a = planOrKeyMaterial(pinned, CURRENT_SALT, NO_SEALED_ROWS);
    const b = planOrKeyMaterial(pinned, 'a-completely-different-salt', NO_SEALED_ROWS);
    expect(a).toEqual(b);
  });

  it('unwraps whatever the caller found about sealed rows, because pinned material is not a guess', () => {
    for (const finding of ['none', 'opens-with-derived-key', 'present', 'unknown'] as const) {
      expect(planOrKeyMaterial(pinned, CURRENT_SALT, { sealedRows: finding }).mode).toBe('unwrap');
    }
  });

  it('refuses a generation NEWER than this build understands', () => {
    const plan = planOrKeyMaterial(
      { ...pinned, or_key_epoch: CURRENT_OR_KEY_EPOCH + 1 },
      CURRENT_SALT,
      NO_SEALED_ROWS,
    );
    expect(plan.mode).toBe('refuse');
  });

  it('refuses a generation OLDER than this build understands', () => {
    const plan = planOrKeyMaterial(
      { ...pinned, or_key_epoch: CURRENT_OR_KEY_EPOCH - 1 },
      CURRENT_SALT,
      NO_SEALED_ROWS,
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
      NO_SEALED_ROWS,
    );
    expect(plan.mode).toBe('unwrap');
  });

  it('refuses a STRING generation it does not understand, rather than unwrapping it', () => {
    const plan = planOrKeyMaterial(
      { ...pinned, or_key_epoch: String(CURRENT_OR_KEY_EPOCH + 1) },
      CURRENT_SALT,
      NO_SEALED_ROWS,
    );
    expect(plan.mode).toBe('refuse');
  });

  it('treats a generation that is not a whole number as a bad write, never as current', () => {
    for (const bad of [1.5, Number.NaN, 'one', '1.5', '']) {
      const plan = planOrKeyMaterial({ ...pinned, or_key_epoch: bad }, CURRENT_SALT, NO_SEALED_ROWS);
      expect(plan.mode).toBe('refuse');
    }
  });
});

describe('planOrKeyMaterial: partly stored', () => {
  it('refuses when the sealed key is missing and names what is missing', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: null, or_subkey_salt: PINNED_SALT, or_key_epoch: 1 },
      CURRENT_SALT,
      NO_SEALED_ROWS,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/the sealed key/);
  });

  it('refuses when the pinned salt is missing', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: 'x', or_subkey_salt: null, or_key_epoch: 1 },
      CURRENT_SALT,
      NO_SEALED_ROWS,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/its salt/);
  });

  it('refuses when the generation is missing', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: 'x', or_subkey_salt: PINNED_SALT, or_key_epoch: null },
      CURRENT_SALT,
      NO_SEALED_ROWS,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/its generation/);
  });

  it('treats an empty-string ciphertext as a failed write, not as a usable key', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: '', or_subkey_salt: PINNED_SALT, or_key_epoch: 1 },
      CURRENT_SALT,
      NO_SEALED_ROWS,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/cannot be read/i);
  });

  it('REFUSES an all-empty-string row instead of deriving over it', () => {
    // This is the row a migration declaring these columns NOT NULL DEFAULT ''
    // would produce for every account on day one. Read as absent, it falls
    // through to derive-and-pin and destroys anything already sealed. The
    // Books migration is not written yet, so the rule is asserted against the
    // value rather than against a column definition that does not exist.
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: '', or_subkey_salt: '', or_key_epoch: null },
      CURRENT_SALT,
      NO_SEALED_ROWS,
    );
    expect(plan.mode).toBe('refuse');
  });

  it('never answers derive-and-pin from a partial state', () => {
    const partials: OrKeyMaterialRow[] = [
      { enc_or_mek_ciphertext: 'x', or_subkey_salt: null, or_key_epoch: null },
      { enc_or_mek_ciphertext: null, or_subkey_salt: PINNED_SALT, or_key_epoch: null },
      { enc_or_mek_ciphertext: null, or_subkey_salt: null, or_key_epoch: 1 },
      { enc_or_mek_ciphertext: 'x', or_subkey_salt: PINNED_SALT, or_key_epoch: null },
      { enc_or_mek_ciphertext: '', or_subkey_salt: null, or_key_epoch: null },
      { enc_or_mek_ciphertext: null, or_subkey_salt: '', or_key_epoch: null },
    ];
    for (const row of partials) {
      expect(planOrKeyMaterial(row, CURRENT_SALT, NO_SEALED_ROWS).mode).toBe('refuse');
    }
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
