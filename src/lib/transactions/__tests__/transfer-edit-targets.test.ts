// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { transferEditTargets } from '../transfer-edit-targets';

// Measured on dev: the sending row S sits on the CAD wallet, the receiving row R on the USD wallet.
// Saving takes the source payload (CAD wallet) and the destination payload (USD wallet).
const walletAfterSave = (direction: 'IN' | 'OUT', edited: string, partner: string) => {
  const t = transferEditTargets(direction, edited, partner);
  return { [t.srcId!]: 'CAD', [t.destId!]: 'USD' };
};

describe('which row each transfer leg updates on edit', () => {
  it('edited from the sending side: S stays on CAD, R on USD', () => {
    expect(walletAfterSave('OUT', 'S', 'R')).toEqual({ S: 'CAD', R: 'USD' });
  });

  it('edited from the receiving side: R stays on USD, S on CAD', () => {
    expect(walletAfterSave('IN', 'R', 'S')).toEqual({ S: 'CAD', R: 'USD' });
  });

  it('a missing leg is inserted: the null id is the side the edited row is not', () => {
    expect(transferEditTargets('IN', 'R', null)).toEqual({ srcId: null, destId: 'R' });
    expect(transferEditTargets('OUT', 'S', null)).toEqual({ srcId: 'S', destId: null });
  });

  it('negative control: the old rule (edited row is always the source) swaps the wallets', () => {
    const old = { srcId: 'R', destId: 'S' }; // editing R from the receiving side
    expect({ [old.srcId]: 'CAD', [old.destId]: 'USD' }).toEqual({ R: 'CAD', S: 'USD' });
  });
});
