export type CurrencyType = 'fiat' | 'crypto';

export interface CurrencyInfo {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
  type: CurrencyType;
  /** CoinGecko asset ID (crypto only) */
  coingeckoId?: string;
  /** CoinGecko vs_currency key for price lookups (fiat only, lowercase) */
  coingeckoVsCurrency?: string;
}

const CURRENCIES: CurrencyInfo[] = [
  // ── Major fiat ──────────────────────────────────────────────────────────
  { code: 'USD', name: 'US Dollar',            symbol: '$',    decimals: 2, type: 'fiat', coingeckoVsCurrency: 'usd' },
  { code: 'EUR', name: 'Euro',                 symbol: '€',    decimals: 2, type: 'fiat', coingeckoVsCurrency: 'eur' },
  { code: 'GBP', name: 'British Pound',        symbol: '£',    decimals: 2, type: 'fiat', coingeckoVsCurrency: 'gbp' },
  { code: 'CAD', name: 'Canadian Dollar',      symbol: 'C$',   decimals: 2, type: 'fiat', coingeckoVsCurrency: 'cad' },
  { code: 'AUD', name: 'Australian Dollar',    symbol: 'A$',   decimals: 2, type: 'fiat', coingeckoVsCurrency: 'aud' },
  { code: 'JPY', name: 'Japanese Yen',         symbol: '¥',    decimals: 0, type: 'fiat', coingeckoVsCurrency: 'jpy' },
  { code: 'CHF', name: 'Swiss Franc',          symbol: 'Fr',   decimals: 2, type: 'fiat', coingeckoVsCurrency: 'chf' },
  // ── Latin America ───────────────────────────────────────────────────────
  { code: 'MXN', name: 'Mexican Peso',         symbol: '$',    decimals: 2, type: 'fiat', coingeckoVsCurrency: 'mxn' },
  { code: 'BRL', name: 'Brazilian Real',       symbol: 'R$',   decimals: 2, type: 'fiat', coingeckoVsCurrency: 'brl' },
  { code: 'CLP', name: 'Chilean Peso',         symbol: '$',    decimals: 0, type: 'fiat', coingeckoVsCurrency: 'clp' },
  { code: 'COP', name: 'Colombian Peso',       symbol: '$',    decimals: 2, type: 'fiat', coingeckoVsCurrency: 'cop' },
  { code: 'PEN', name: 'Peruvian Sol',         symbol: 'S/',   decimals: 2, type: 'fiat', coingeckoVsCurrency: 'pen' },
  { code: 'ARS', name: 'Argentine Peso',       symbol: '$',    decimals: 2, type: 'fiat', coingeckoVsCurrency: 'ars' },
  // ── Asia Pacific ────────────────────────────────────────────────────────
  { code: 'INR', name: 'Indian Rupee',         symbol: '₹',    decimals: 2, type: 'fiat', coingeckoVsCurrency: 'inr' },
  { code: 'KRW', name: 'South Korean Won',     symbol: '₩',    decimals: 0, type: 'fiat', coingeckoVsCurrency: 'krw' },
  { code: 'SGD', name: 'Singapore Dollar',     symbol: 'S$',   decimals: 2, type: 'fiat', coingeckoVsCurrency: 'sgd' },
  { code: 'HKD', name: 'Hong Kong Dollar',     symbol: 'HK$',  decimals: 2, type: 'fiat', coingeckoVsCurrency: 'hkd' },
  { code: 'THB', name: 'Thai Baht',            symbol: '฿',    decimals: 2, type: 'fiat', coingeckoVsCurrency: 'thb' },
  { code: 'IDR', name: 'Indonesian Rupiah',    symbol: 'Rp',   decimals: 0, type: 'fiat', coingeckoVsCurrency: 'idr' },
  { code: 'MYR', name: 'Malaysian Ringgit',    symbol: 'RM',   decimals: 2, type: 'fiat', coingeckoVsCurrency: 'myr' },
  { code: 'PHP', name: 'Philippine Peso',      symbol: '₱',    decimals: 2, type: 'fiat', coingeckoVsCurrency: 'php' },
  // ── Europe (non-euro) ───────────────────────────────────────────────────
  { code: 'NOK', name: 'Norwegian Krone',      symbol: 'kr',   decimals: 2, type: 'fiat', coingeckoVsCurrency: 'nok' },
  { code: 'SEK', name: 'Swedish Krona',        symbol: 'kr',   decimals: 2, type: 'fiat', coingeckoVsCurrency: 'sek' },
  { code: 'DKK', name: 'Danish Krone',         symbol: 'kr',   decimals: 2, type: 'fiat', coingeckoVsCurrency: 'dkk' },
  { code: 'CZK', name: 'Czech Koruna',         symbol: 'Kč',   decimals: 2, type: 'fiat', coingeckoVsCurrency: 'czk' },
  { code: 'PLN', name: 'Polish Zloty',         symbol: 'zł',   decimals: 2, type: 'fiat', coingeckoVsCurrency: 'pln' },
  { code: 'HUF', name: 'Hungarian Forint',     symbol: 'Ft',   decimals: 0, type: 'fiat', coingeckoVsCurrency: 'huf' },
  { code: 'TRY', name: 'Turkish Lira',         symbol: '₺',    decimals: 2, type: 'fiat', coingeckoVsCurrency: 'try' },
  { code: 'ILS', name: 'Israeli Shekel',       symbol: '₪',    decimals: 2, type: 'fiat', coingeckoVsCurrency: 'ils' },
  // ── Middle East / Africa ────────────────────────────────────────────────
  { code: 'AED', name: 'UAE Dirham',           symbol: 'د.إ',  decimals: 2, type: 'fiat', coingeckoVsCurrency: 'aed' },
  { code: 'ZAR', name: 'South African Rand',   symbol: 'R',    decimals: 2, type: 'fiat', coingeckoVsCurrency: 'zar' },
  { code: 'NZD', name: 'New Zealand Dollar',   symbol: 'NZ$',  decimals: 2, type: 'fiat', coingeckoVsCurrency: 'nzd' },
  // ── Crypto ──────────────────────────────────────────────────────────────
  { code: 'BTC',  name: 'Bitcoin',   symbol: '₿',  decimals: 8, type: 'crypto', coingeckoId: 'bitcoin' },
  { code: 'SATS', name: 'Satoshis',  symbol: '⚡', decimals: 0, type: 'crypto', coingeckoId: 'bitcoin' },
  { code: 'ETH',  name: 'Ethereum',  symbol: 'Ξ',  decimals: 8, type: 'crypto', coingeckoId: 'ethereum' },
  { code: 'LTC',  name: 'Litecoin',  symbol: 'Ł',  decimals: 8, type: 'crypto', coingeckoId: 'litecoin' },
  { code: 'XRP',  name: 'XRP',       symbol: '✕',  decimals: 6, type: 'crypto', coingeckoId: 'ripple' },
  { code: 'SOL',  name: 'Solana',    symbol: '◎',  decimals: 9, type: 'crypto', coingeckoId: 'solana' },
];

const REGISTRY = new Map<string, CurrencyInfo>(CURRENCIES.map(c => [c.code, c]));

export function getCurrency(code: string): CurrencyInfo | undefined {
  return REGISTRY.get(code.toUpperCase());
}

export function getCurrencyOrThrow(code: string): CurrencyInfo {
  const c = getCurrency(code);
  if (!c) throw new Error(`Unsupported currency: ${code}`);
  return c;
}

export function isCrypto(code: string): boolean {
  return getCurrency(code)?.type === 'crypto';
}

export function isFiat(code: string): boolean {
  return getCurrency(code)?.type === 'fiat';
}

export function getCurrencyKind(code: string): CurrencyType | undefined {
  return getCurrency(code)?.type;
}

export function getDecimals(code: string): number {
  return getCurrency(code)?.decimals ?? 2;
}

export function getAllCurrencies(): CurrencyInfo[] {
  return CURRENCIES;
}

export function getFiatCurrencies(): CurrencyInfo[] {
  return CURRENCIES.filter(c => c.type === 'fiat');
}

export function getCryptoCurrencies(): CurrencyInfo[] {
  return CURRENCIES.filter(c => c.type === 'crypto');
}

/** All codes accepted by the edge function (for allow-list validation). */
export function getAllCurrencyCodes(): string[] {
  return CURRENCIES.map(c => c.code);
}
