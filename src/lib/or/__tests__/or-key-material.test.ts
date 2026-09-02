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

/** Nothing has been sealed yet, so deriving cannot cost anything. */
const NO_ROWS: PlanOrKeyMaterialOptions = { existingSealedRows: 'none' };

/** Rows exist AND the derived key was tried against one and opened it. */
const PROVEN: PlanOrKeyMaterialOptions = { existingSealedRows: 'opens-with-candidate' };

describe('planOrKeyMaterial: nothing pinned yet', () => {
  it('derives and pins when the org has no sealed rows to lose', () => {
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, NO_ROWS);
    expect(plan).toEqual({
      mode: 'derive-and-pin',
      saltContext: CURRENT_SALT,
      epoch: CURRENT_OR_KEY_EPOCH,
    });
  });

  it('derives and pins when the derived key was PROVEN to open an existing sealed row', () => {
    // This is the upgrade path for a customer who already synced under the
    // current salt: proof rather than inference, and no re-sync.
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, PROVEN);
    expect(plan.mode).toBe('derive-and-pin');
  });

  it('REFUSES for an account that rotated its vault password before pinning existed', () => {
    // The situation the old boolean got wrong: rows were sealed under the old
    // salt, the password change minted a new one, nothing was pinned because
    // this build did not exist, and no record of the old salt survives. A
    // caller can see that sealed rows exist and cannot show the derived key
    // opens them, so the only answer that is not a lie is refuse.
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, {
      existingSealedRows: 'present-unverified',
    });
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/never pinned/i);
    expect(plan.reason).toMatch(/re-sync/i);
  });

  it('REFUSES when the caller could not check whether sealed rows exist', () => {
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, { existingSealedRows: 'unknown' });
    expect(plan.mode).toBe('refuse');
  });

  it('REFUSES when the caller passes undefined rather than stating what it found', () => {
    // The shape a caller falls into by accident when the value comes from a
    // lookup. Checked at runtime and not only in the types, because an
    // untyped caller is exactly the one that will do it.
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, {
      existingSealedRows: undefined,
    } as unknown as PlanOrKeyMaterialOptions);
    expect(plan.mode).toBe('refuse');
  });

  it('REFUSES an unrecognised evidence value instead of treating it as safe', () => {
    const plan = planOrKeyMaterial(EMPTY, CURRENT_SALT, {
      existingSealedRows: 'no-rows',
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

describe('planOrKeyMaterial: the row itself could not be read', () => {
  // A failed metadata read that hands back null rather than throwing is an
  // "I cannot know", and this module's whole doctrine is that those refuse.
  // Before the guard, null read as three absent columns, which is exactly the
  // shape of a fresh account, and with evidence 'none' it answered
  // derive-and-pin: a well formed key, pinned as authoritative, opening none
  // of the rows the customer already synced.
  it('REFUSES a null row instead of deriving over it', () => {
    const plan = planOrKeyMaterial(null as unknown as OrKeyMaterialRow, CURRENT_SALT, NO_ROWS);
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/could not be read/i);
    // Distinct from the partial-write refusal, so a log can tell a failed read
    // from a write that stopped halfway.
    expect(plan.reason).not.toMatch(/partly stored/i);
  });

  it('REFUSES an undefined row', () => {
    const plan = planOrKeyMaterial(
      undefined as unknown as OrKeyMaterialRow,
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/could not be read/i);
  });

  it('REFUSES an unreadable row even when the caller PROVED the derived key opens a row', () => {
    // Evidence is about what deriving would cost, not about whether the read
    // succeeded. Proof cannot rescue a state we never observed.
    const plan = planOrKeyMaterial(null as unknown as OrKeyMaterialRow, CURRENT_SALT, PROVEN);
    expect(plan.mode).toBe('refuse');
  });

  it('still derives for a genuinely empty row, so the guard has not eaten the fresh-account path', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: null, or_subkey_salt: null, or_key_epoch: null },
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('derive-and-pin');
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

  it('unwraps whatever the caller found about sealed rows, because pinned material settles it', () => {
    const plan = planOrKeyMaterial(pinned, CURRENT_SALT, {
      existingSealedRows: 'unknown',
    });
    expect(plan.mode).toBe('unwrap');
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

  it('treats a generation that is not a whole number as unusable, never as current', () => {
    for (const bad of [1.5, Number.NaN, 'one', '1.5', '']) {
      const plan = planOrKeyMaterial({ ...pinned, or_key_epoch: bad }, CURRENT_SALT, NO_ROWS);
      expect(plan.mode).toBe('refuse');
    }
  });

  it('refuses a generation beyond exact representation in BOTH spellings', () => {
    // The number and string branches must agree. They did not: the number
    // branch asked only for a whole number while the string branch asked for a
    // safe one, so the same magnitude was accepted written one way and rejected
    // written the other. Nothing depended on it, because such a value is never
    // the current generation and refuses on the comparison, but an asymmetry
    // inside a rule whose job is refusing is worth not having.
    const unsafe = Number.MAX_SAFE_INTEGER + 2;
    expect(planOrKeyMaterial({ ...pinned, or_key_epoch: unsafe }, CURRENT_SALT, NO_ROWS).mode).toBe(
      'refuse',
    );
    expect(
      planOrKeyMaterial({ ...pinned, or_key_epoch: '9007199254740993' }, CURRENT_SALT, NO_ROWS)
        .mode,
    ).toBe('refuse');
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

  it('treats an empty-string ciphertext as unusable, not as a usable key', () => {
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: '', or_subkey_salt: PINNED_SALT, or_key_epoch: 1 },
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('refuse');
  });

  it('refuses an ALL-EMPTY row rather than deriving over it', () => {
    // A row holding empty strings is a write that went wrong partway, not a
    // row nobody has touched. Reading it as absent sent it to derive-and-pin,
    // which is the destructive answer. This holds whatever the eventual Books
    // migration chooses for defaults, which is why it is decided here and not
    // left to that file.
    const plan = planOrKeyMaterial(
      { enc_or_mek_ciphertext: '', or_subkey_salt: '', or_key_epoch: '' },
      CURRENT_SALT,
      NO_ROWS,
    );
    expect(plan.mode).toBe('refuse');
    if (plan.mode !== 'refuse') throw new Error('unreachable');
    expect(plan.reason).toMatch(/partly stored/);
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
      expect(planOrKeyMaterial(row, CURRENT_SALT, NO_ROWS).mode).toBe('refuse');
      expect(planOrKeyMaterial(row, CURRENT_SALT, PROVEN).mode).toBe('refuse');
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
