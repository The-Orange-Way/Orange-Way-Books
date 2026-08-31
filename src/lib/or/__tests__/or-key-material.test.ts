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

/** The only statement that permits deriving. Spelled out at every call. */
const MATCHES: PlanOrKeyMaterialOptions = { saltMatchesExistingRows: true };

describe('planOrKeyMaterial: nothing pinned yet', () => {
  it('derives and pins when the caller states the salt still matches', () => {
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, MATCHES);
    expect(plan).toEqual({
      mode: 'derive-and-pin',
      saltContext: CURRENT_SALT,
      epoch: CURRENT_OR_KEY_EPOCH,
    });
  });

  it('REFUSES when the salt has just rotated, instead of deriving a key that opens nothing', () => {
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, { saltMatchesExistingRows: false });
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/never pinned/i);
    expect(plan.reason).toMatch(/re-sync/i);
  });

  it('REFUSES when the caller passes undefined rather than stating the flag', () => {
    // The shape a recovery-path caller falls into by accident:
    // { saltMatchesExistingRows: fetched?.matches } is boolean | undefined,
    // which TypeScript did not complain about while the option was optional.
    // Absence has to refuse, never derive, so it is checked at runtime and
    // not only in the types.
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, {
      saltMatchesExistingRows: undefined,
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
    const plan = planOrKeyMaterial(EMPTY, '', MATCHES);
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
    const plan = planOrKeyMaterial(pinned, CURRENT_SALT, MATCHES);
    expect(plan).toEqual({
      mode: 'unwrap',
      ciphertext: 'sealed-key-ciphertext',
      saltContext: PINNED_SALT,
    });
  });

  it('unwraps regardless of what the current salt is, which is the whole point', () => {
    const a = planOrKeyMaterial(pinned, CURRENT_SALT, MATCHES);
    const b = planOrKeyMaterial(pinned, 'a-completely-different-salt', MATCHES);
    expect(a).toEqual(b);
  });

  it('refuses a generation NEWER than this build understands', () => {
    const plan = planOrKeyMaterial(
      { ...pinned, or_key_epoch: CURRENT_OR_KEY_EPOCH + 1 },
      CURRENT_SALT,
      MATCHES,
    );
    expect(plan.mode).toBe('refuse');
  });

  it('refuses a generation OLDER than this build understands', () => {
    const plan = planOrKeyMaterial(
      { ...pinned, or_key_epoch: CURRENT_OR_KEY_EPOCH - 1 },
      CURRENT_SALT,
      MATCHES,
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
      MATCHES,
    );
    expect(plan.mode).toBe('unwrap');
  });

  it('refuses a STRING generation it does not understand, rather than unwrapping it', () => {
    const plan = planOrKeyMaterial(
      { ...pinned, or_key_epoch: String(CURRENT_OR_KEY_EPOCH + 1) },
      CURRENT_SALT,
      MATCHES,
    );
    expect(plan.mode).toBe('refuse');
  });

  it('treats a generation that is not a whole number as absent, never as current', () => {
    for (const bad of [1.5, Number.NaN, 'one', '1.5', '']) {
      const plan = planOrKeyMaterial({ ...pinned, or_key_epoch: bad }, CURRENT_SALT, MATCHES);
      expect(plan.mode).toBe('refuse');
    }
  });
});

describe('planOrKeyMaterial: partly stored', () => {
  it('refuses when the sealed key is missing and names what is missing', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: null, or_subkey_salt: PINNED_SALT, or_key_epoch: 1 },
      CURRENT_SALT,
      MATCHES,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/the sealed key/);
  });

  it('refuses when the pinned salt is missing', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: 'x', or_subkey_salt: null, or_key_epoch: 1 },
      CURRENT_SALT,
      MATCHES,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/its salt/);
  });

  it('refuses when the generation is missing', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: 'x', or_subkey_salt: PINNED_SALT, or_key_epoch: null },
      CURRENT_SALT,
      MATCHES,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/its generation/);
  });

  it('treats an empty-string ciphertext as absent, not as a usable key', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: '', or_subkey_salt: PINNED_SALT, or_key_epoch: 1 },
      CURRENT_SALT,
      MATCHES,
    );
    expect(plan.mode).toBe('refuse');
  });

  it('never answers derive-and-pin from a partial state', () => {
    const partials: OrKeyMaterialRow[] = [
      { enc_or_mek_ciphertext: 'x', or_subkey_salt: null, or_key_epoch: null },
      { enc_or_mek_ciphertext: null, or_subkey_salt: PINNED_SALT, or_key_epoch: null },
      { enc_or_mek_ciphertext: null, or_subkey_salt: null, or_key_epoch: 1 },
      { enc_or_mek_ciphertext: 'x', or_subkey_salt: PINNED_SALT, or_key_epoch: null },
    ];
    for (const row of partials) {
      expect(planOrKeyMaterial(row, CURRENT_SALT, MATCHES).mode).toBe('refuse');
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
