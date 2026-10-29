/** The wallets and direction an opened transfer's amounts were saved with. */
export interface SavedTransfer {
  walletId: string;
  counterpartyWalletId: string;
  direction: 'IN' | 'OUT';
}

/**
 * True while an opened transfer should keep its saved amounts instead of following the exchange
 * rate: the currency pair (sending asset to receiving asset) is still the one it was saved with.
 * Once the user picks wallets or a direction giving another pair, the rate applies again. If a
 * saved wallet is not in the list yet, the saved amounts are kept.
 */
export function keepsSavedTransferAmounts(
  saved: SavedTransfer | null,
  wallets: ReadonlyArray<{ id: string; asset: string }>,
  rateBase: string | null,
  rateQuote: string | null,
): boolean {
  if (!saved) return false;
  const own = wallets.find((w) => w.id === saved.walletId)?.asset;
  const other = wallets.find((w) => w.id === saved.counterpartyWalletId)?.asset;
  if (!own || !other) return true;
  const [sent, received] = saved.direction === 'OUT' ? [own, other] : [other, own];
  return sent === rateBase && received === rateQuote;
}
