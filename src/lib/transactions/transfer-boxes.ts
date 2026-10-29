/**
 * Which transfer amount sits in which column. The left column is under the wallet being edited,
 * the right column under the other wallet. Going OUT, the left wallet sends; coming IN, it
 * receives. Each box keeps its own label, amount and currency, so only the order changes.
 */
export type TransferBox = 'sent' | 'received';

export function transferBoxOrder(direction: 'IN' | 'OUT'): [TransferBox, TransferBox] {
  return direction === 'OUT' ? ['sent', 'received'] : ['received', 'sent'];
}

export const TRANSFER_BOX_LABEL: Record<TransferBox, string> = {
  sent: 'Amount Sent',
  received: 'Amount Received',
};
