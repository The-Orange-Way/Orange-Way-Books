// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { glWalletCsvCell } from '../gl-wallet-csv';

describe('wallet-mode General Ledger CSV: the number and its label come from the row currency', () => {
  it('BTC follows the Bitcoin display setting', () => {
    expect(glWalletCsvCell(0.00000019, 'BTC', 'sats')).toEqual({ value: 19, label: 'Satoshis' });
    expect(glWalletCsvCell(0.00000019, 'BTC', 'btc')).toEqual({ value: 0.00000019, label: 'BTC' });
  });

  it('SATS stays in satoshis whatever the display, and says so', () => {
    expect(glWalletCsvCell(19, 'SATS', 'btc')).toEqual({ value: 19, label: 'Satoshis' });
    expect(glWalletCsvCell(19, 'sats', 'sats')).toEqual({ value: 19, label: 'Satoshis' });
  });

  it('fiat passes through with its own code, never the company currency', () => {
    expect(glWalletCsvCell(10.5, 'cad', 'sats')).toEqual({ value: 10.5, label: 'CAD' });
  });

  it('a row with no currency is labelled Unknown', () => {
    expect(glWalletCsvCell(3, null, 'sats')).toEqual({ value: 3, label: 'Unknown' });
  });
});
