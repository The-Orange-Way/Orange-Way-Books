import { describe, it, expect } from 'vitest';
import { getSymbol, getDecimals } from './currency-registry';

describe('getSymbol', () => {
  it('returns correct symbols for major fiat currencies', () => {
    expect(getSymbol('USD')).toBe('$');
    expect(getSymbol('EUR')).toBe('€');
    expect(getSymbol('GBP')).toBe('£');
    expect(getSymbol('JPY')).toBe('¥');
    expect(getSymbol('CAD')).toBe('C$');
    expect(getSymbol('AUD')).toBe('A$');
  });

  it('returns correct symbols for crypto currencies', () => {
    expect(getSymbol('BTC')).toBe('₿');
    expect(getSymbol('SATS')).toBe('⚡');
    expect(getSymbol('ETH')).toBe('Ξ');
  });

  it('is case-insensitive', () => {
    expect(getSymbol('eur')).toBe('€');
    expect(getSymbol('btc')).toBe('₿');
    expect(getSymbol('Gbp')).toBe('£');
  });

  it('a non-USD non-BTC code renders its own symbol, not $', () => {
    // This is the DL-0722 bug: EUR and GBP accounts were showing '$'
    // because call sites used (asset === 'BTC' ? '₿' : '$') ternaries.
    expect(getSymbol('EUR')).toBe('€');
    expect(getSymbol('EUR')).not.toBe('$');
    expect(getSymbol('GBP')).toBe('£');
    expect(getSymbol('GBP')).not.toBe('$');
    expect(getSymbol('JPY')).toBe('¥');
    expect(getSymbol('JPY')).not.toBe('$');
  });

  it('falls back to the currency code for unknown currencies, not $', () => {
    // Unknown codes should be obvious (the code itself), never silently '$'.
    expect(getSymbol('XYZ')).toBe('XYZ');
    expect(getSymbol('XYZ')).not.toBe('$');
    expect(getSymbol('UNKNOWN')).toBe('UNKNOWN');
  });
});

describe('getDecimals', () => {
  it('returns correct decimal places', () => {
    expect(getDecimals('USD')).toBe(2);
    expect(getDecimals('JPY')).toBe(0);
    expect(getDecimals('BTC')).toBe(8);
    expect(getDecimals('SATS')).toBe(0);
  });

  it('falls back to 2 for unknown currencies', () => {
    expect(getDecimals('XYZ')).toBe(2);
  });
});
