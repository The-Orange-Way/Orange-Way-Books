import type { BitcoinDisplay } from '@/types';

/**
 * CSV "currency" column value for spreadsheet exports: plain labels, no symbols.
 * BTC display mode is spelled out so amounts can stay numeric and still be interpretable.
 *
 * Ledger unit labels for the **Currency** column next to a plain numeric **Amount** cell
 * (no ₿ / $ in Amount — those belong in PDF/print only so Excel can SUM).
 *
 * **ZKA (Orange Way Books):** This helper only combines data that already exists in the
 * browser after unlock — row currency codes plus `bitcoinDisplay` from org settings
 * obtained via `decryptOrgSettings` / `useOrgSettings`. It does not call the network,
 * log secrets, or persist exports; callers build CSV locally (see `exportToCsv`) so
 * plaintext exists only on the user’s device.
 */
export function csvExportCurrencyLabel(currency: string, bitcoinDisplay: BitcoinDisplay): string {
  const c = currency.trim().toUpperCase();
  if (c !== 'BTC' && c !== 'SATS') {
    return c;
  }
  if (c === 'SATS') {
    return 'Satoshis';
  }
  switch (bitcoinDisplay) {
    case 'sats':
      return 'Satoshis';
    case 'bitcoins':
      return 'BTC Bitcoins';
    case 'btc':
    case 'btc-easy':
    default:
      return 'BTC';
  }
}
