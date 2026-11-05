import { describe, expect, it } from 'vitest';
import { keepsSavedTransferAmounts, type SavedTransfer } from '../transfer-saved-amounts';

const wallets = [
  { id: 'cad', asset: 'CAD' },
  { id: 'usd', asset: 'USD' },
  { id: 'usd2', asset: 'USD' },
  { id: 'eur', asset: 'EUR' },
];
const out: SavedTransfer = { walletId: 'cad', counterpartyWalletId: 'usd', direction: 'OUT' };
const inn: SavedTransfer = { walletId: 'usd', counterpartyWalletId: 'cad', direction: 'IN' };

describe('keepsSavedTransferAmounts', () => {
  it('keeps the saved amounts while the pair is unchanged, opened from either side', () => {
    expect(keepsSavedTransferAmounts(out, wallets, 'CAD', 'USD')).toBe(true);
    expect(keepsSavedTransferAmounts(inn, wallets, 'CAD', 'USD')).toBe(true);
  });

  it('lets the rate apply once the pair changes', () => {
    expect(keepsSavedTransferAmounts(out, wallets, 'CAD', 'EUR')).toBe(false);
    expect(keepsSavedTransferAmounts(out, wallets, 'USD', 'CAD')).toBe(false);
    expect(keepsSavedTransferAmounts(inn, wallets, 'EUR', 'USD')).toBe(false);
  });

  it('a same-currency transfer moved to another currency follows the rate', () => {
    const same: SavedTransfer = { walletId: 'usd', counterpartyWalletId: 'usd2', direction: 'OUT' };
    expect(keepsSavedTransferAmounts(same, wallets, 'USD', 'EUR')).toBe(false);
  });

  it('a new transaction has nothing saved; unknown wallets keep what was saved', () => {
    expect(keepsSavedTransferAmounts(null, wallets, 'CAD', 'USD')).toBe(false);
    expect(keepsSavedTransferAmounts(out, [], 'CAD', 'USD')).toBe(true);
  });
});
