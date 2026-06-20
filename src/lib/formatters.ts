import type { BitcoinDisplay } from '@/types';

export function formatCrypto(amount: number, displayMode: BitcoinDisplay = 'sats'): string {
  switch (displayMode) {
    case 'sats': {
      const sats = Math.round(amount * 1e8);
      return `⚡ ${sats.toLocaleString('en-US')} sats`;
    }
    case 'btc':
      return `BTC ${amount.toFixed(8)}`;
    case 'btc-easy': {
      const fixed = amount.toFixed(8);
      const [whole, decimal] = fixed.split('.');
      const grouped = decimal.replace(/(.{2})(?=.)/g, '$1 ');
      return `BTC ${whole}.${grouped}`;
    }
    case 'bitcoins': {
      const sats = Math.round(amount * 1e8);
      return `₿ ${sats.toLocaleString('en-US')}`;
    }
    default:
      return `${amount}`;
  }
}

export function formatFiat(
  amount: number,
  currency: string = 'USD',
  numberFormat: 'US' | 'EU' = 'US',
): string {
  const locale = numberFormat === 'EU' ? 'de-DE' : 'en-US';
  // Intl.NumberFormat throws a RangeError for any currency code that isn't
  // a valid ISO 4217 value. If decryption is still in progress (or failed
  // silently for a limbo row) the caller might pass base64 ciphertext here,
  // which would crash the whole page. Fall back to USD instead.
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  }
}

export function formatRate(rate: number, decimals?: number): string {
  // Crypto rates need more precision, fiat rates need less
  const d = decimals ?? (rate < 0.01 ? 8 : rate < 1 ? 6 : rate > 1000 ? 2 : 4);
  return rate.toFixed(d);
}
