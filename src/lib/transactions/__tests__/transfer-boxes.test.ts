// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TRANSFER_BOX_LABEL, transferBoxOrder, type TransferBox } from '../transfer-boxes';

// The modal's own wallet mapping: going OUT the edited wallet sends, coming IN it receives.
const walletOf = (box: TransferBox, direction: 'IN' | 'OUT') => {
  const sent = direction === 'OUT' ? 'edited' : 'other';
  const received = direction === 'OUT' ? 'other' : 'edited';
  return box === 'sent' ? sent : received;
};

describe('transfer amount boxes', () => {
  it.each(['IN', 'OUT'] as const)(
    '%s: the left box is the edited wallet, right box the other',
    (d) => {
      const [left, right] = transferBoxOrder(d);
      expect([walletOf(left, d), walletOf(right, d)]).toEqual(['edited', 'other']);
    },
  );

  it('editing the receiving side: left says Amount Received, right says Amount Sent', () => {
    expect(transferBoxOrder('IN').map((b) => TRANSFER_BOX_LABEL[b])).toEqual([
      'Amount Received',
      'Amount Sent',
    ]);
  });

  it('negative control: the old fixed order put the other wallet on the left when receiving', () => {
    const old: [TransferBox, TransferBox] = ['sent', 'received'];
    expect(walletOf(old[0], 'IN')).toBe('other');
  });

  it('the modal renders the boxes in this order', () => {
    const src = readFileSync('src/components/transactions/transaction-modal.tsx', 'utf8');
    expect(src).toContain('transferBoxOrder(direction).map(');
    expect(src).not.toContain("direction === 'OUT' ? 'Amount Sent' : 'Amount Received'");
  });
});
