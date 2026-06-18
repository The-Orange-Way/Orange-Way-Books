import type { BitcoinDisplay } from '@/types';

const SATS_PER_BTC = 100_000_000;

/** DB may store SATS as integer sats or BTC as decimal; formatters use BTC. */
function storedAmountToBtc(signedAmount: number, currencyUpper: string): number {
  if (currencyUpper === 'SATS') return signedAmount / SATS_PER_BTC;
  return signedAmount;
}

/**
 * Amount for a CSV numeric cell: same *scale* as the table formatter (no ₿/$/grouping).
 * - sats / bitcoins: whole satoshis (signed integer).
 * - btc / btc-easy: signed BTC decimal.
 * Fiat and other currencies pass through unchanged.
 */
export function transactionAmountNumericForCsv(
  signedAmount: number,
  assetOrCurrency: string,
  bitcoinDisplay: BitcoinDisplay,
): number {
  const c = assetOrCurrency.trim().toUpperCase();
  if (c !== 'BTC' && c !== 'SATS') {
    return signedAmount;
  }
  const btc = storedAmountToBtc(signedAmount, c);
  switch (bitcoinDisplay) {
    case 'sats':
    case 'bitcoins':
      return Math.round(btc * SATS_PER_BTC);
    case 'btc':
    case 'btc-easy':
    default:
      return btc;
  }
}
