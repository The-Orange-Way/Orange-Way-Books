// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { linkedLegAmount } from '../linked-leg';

// Fake cipher: "enc:<plain>". Real rows look the same to the code path under test.
const decrypt = async (v: string) => v.replace(/^enc:/, '');

// Shape of an encrypted transfer leg: plain amount is 0, the value is in encrypted_amount.
const encryptedLeg = {
  id: 'leg-2',
  account_id: 'wallet-usd',
  amount: 0,
  encrypted_amount: 'enc:14.6',
  encrypted_usd_value: null,
  encrypted_exchange_rate: null,
  usd_value: null,
  exchange_rate: null,
  memo: null,
  asset: 'enc:USD',
  type: 'enc:TRANSFER',
  status: null,
  cleared_status: null,
  key_version: 2,
};

describe('editing a transfer reads the other leg amount', () => {
  it('returns the decrypted amount of an encrypted leg', async () => {
    expect(await linkedLegAmount(encryptedLeg, decrypt)).toBe(14.6);
  });

  it('returns a positive number for a negative (source) leg', async () => {
    expect(await linkedLegAmount({ ...encryptedLeg, encrypted_amount: 'enc:-20' }, decrypt)).toBe(
      20,
    );
  });

  it('still reads the plain amount of a legacy row with no key version', async () => {
    expect(
      await linkedLegAmount({ ...encryptedLeg, key_version: null, amount: -7.5 }, decrypt),
    ).toBe(7.5);
  });

  it('negative control: the old read of the plain column gives 0 for the same row', () => {
    expect(Math.abs(Number(encryptedLeg.amount))).toBe(0);
  });

  it('the transaction modal uses it for both sent and received', () => {
    const modal = readFileSync(
      join(__dirname, '..', '..', '..', 'components', 'transactions', 'transaction-modal.tsx'),
      'utf8',
    );
    expect(modal).toContain('await linkedLegAmount(linkedRow, decryptText)');
    expect(modal).not.toContain('Number(linkedRow.amount)');
    // Sent is this row when it is the source, otherwise the other leg; received is the reverse.
    const sent = modal.indexOf(
      'setSentAmount(\n              formatAmountForInput(\n                editingIsSource ? Math.abs(Number(editingTx.amount)) : linkedAmount,',
    );
    const received = modal.indexOf(
      'setReceivedAmount(\n              formatAmountForInput(\n                editingIsSource ? linkedAmount : Math.abs(Number(editingTx.amount)),',
    );
    expect(sent).toBeGreaterThan(-1);
    expect(received).toBeGreaterThan(sent);
    // The row is checked for a closed modal after the async decrypt, before any state is set.
    const decryptAt = modal.indexOf('await linkedLegAmount(linkedRow, decryptText);');
    expect(modal.slice(decryptAt, decryptAt + 120)).toContain('if (cancelled) return;');
    expect(sent).toBeGreaterThan(decryptAt);
  });
});
