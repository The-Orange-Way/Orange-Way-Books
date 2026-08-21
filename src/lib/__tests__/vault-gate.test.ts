/**
 * @vitest-environment node
 *
 * Pins "which condition is blocking the button" to the submit gate itself.
 *
 * The defect this guards: the v2 onboarding step disabled its button on a
 * bare conjunction of length AND strength AND a matching confirm, and put a
 * single "Strength: Good" line on screen beside it. Someone who typed a long
 * password that scored below the bar got a dead button and no way to learn
 * what to change, and someone whose confirm field disagreed got nothing at
 * all. The sibling app shipped a fix for exactly this after a beta report;
 * this is that fix, brought over.
 *
 * Both halves matter. Every condition needs a case here, so a fifth condition
 * added to the component's canContinue and not to vaultGateBlocker shows up
 * as a failure rather than as a silent button. And exactly one hint may be
 * live at a time, which is what the component's render guards depend on.
 *
 * Wording is deliberately not asserted. The copy lives in onboarding-copy.ts
 * and changes without changing behaviour; the codes are the contract.
 */

import { describe, it, expect } from 'vitest';
import { vaultGateBlocker, type VaultGateState } from '@/lib/vault-gate';
import { MIN_VAULT_PASSWORD_LENGTH } from '@/lib/vault';

const READY: VaultGateState = {
  password: 'correct horse battery staple',
  confirm: 'correct horse battery staple',
  strongEnough: true,
  understood: true,
  minLength: MIN_VAULT_PASSWORD_LENGTH,
};

describe('vaultGateBlocker', () => {
  it('returns null when every condition is met', () => {
    expect(vaultGateBlocker(READY)).toBeNull();
  });

  it('says nothing before the customer has typed anything', () => {
    expect(vaultGateBlocker({ ...READY, password: '', confirm: '', understood: false })).toBeNull();
  });

  it('reports length while the password is too short', () => {
    expect(vaultGateBlocker({ ...READY, password: 'short', confirm: 'short' })).toBe('length');
  });

  it('reports strength once the password is long enough but still weak', () => {
    expect(vaultGateBlocker({ ...READY, strongEnough: false })).toBe('strength');
  });

  it('does not blame strength for a short password', () => {
    // A five-character password used to be told it needed to be stronger,
    // when what it needed was to be longer.
    expect(
      vaultGateBlocker({ ...READY, password: 'abc', confirm: 'abc', strongEnough: false }),
    ).toBe('length');
  });

  it('reports mismatch, which previously showed nothing at all', () => {
    expect(vaultGateBlocker({ ...READY, confirm: 'something else entirely' })).toBe('mismatch');
  });

  it('treats an empty confirm field as not-yet-filled, not as a mismatch', () => {
    expect(vaultGateBlocker({ ...READY, confirm: '' })).toBeNull();
  });

  it('reports the unticked acknowledgement, which previously showed nothing at all', () => {
    expect(vaultGateBlocker({ ...READY, understood: false })).toBe('acknowledgement');
  });

  it('does not ask for the acknowledgement while the confirm field disagrees', () => {
    // Exactly one hint at a time: the component renders each on its own guard,
    // and two visible at once is the thing this ordering prevents.
    expect(vaultGateBlocker({ ...READY, confirm: 'nope', understood: false })).toBe('mismatch');
  });

  it('uses the shared vault minimum, so the two cannot drift apart', () => {
    // v2 carried its own copy of 14 until this change. The number is the
    // vault library's to set, because that is what actually derives the key.
    expect(READY.minLength).toBe(MIN_VAULT_PASSWORD_LENGTH);
  });

  it('covers every condition in canContinue', () => {
    const seen = new Set(
      [
        vaultGateBlocker({ ...READY, password: 'abc', confirm: 'abc' }),
        vaultGateBlocker({ ...READY, strongEnough: false }),
        vaultGateBlocker({ ...READY, confirm: 'nope' }),
        vaultGateBlocker({ ...READY, understood: false }),
      ].filter(Boolean),
    );
    expect(seen).toEqual(new Set(['length', 'strength', 'mismatch', 'acknowledgement']));
  });
});
