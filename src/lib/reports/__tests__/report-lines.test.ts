// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  type AccountInfo,
  type JournalLine,
  computeAccountBalances,
  computeGeneralLedger,
} from '../../ledger-engine';
import { reportLinesFor } from '../report-lines';

// A USD-primary company with a USD bank account and a CAD wallet (OWB-T0232).
const acct = (id: string, name: string, type = 'ASSET', group = 'Assets'): AccountInfo => ({
  id,
  name,
  code: null,
  accountType: type,
  accountGroup: group,
  accountCategory: null,
});
const accounts: AccountInfo[] = [
  acct('usd', 'USD Bank'),
  acct('cad', 'CAD Wallet'),
  acct('clear', 'Transfer Clearing'),
  acct('equity', "Owner's Equity", 'EQUITY', 'Equity'),
];

const line = (
  je: string,
  accountId: string,
  native: number,
  extra: Partial<JournalLine> = {},
): JournalLine => ({
  date: '2026-03-01',
  accountId,
  accountName: accountId,
  accountCode: null,
  debit: native > 0 ? native : 0,
  credit: native < 0 ? -native : 0,
  description: null,
  journalEntryId: je,
  ...extra,
});

// Moving 73 USD into the CAD wallet, where it lands as 100 CAD. The clearing account nets to zero
// only when the CAD side is valued at its primary amount.
const transfer: JournalLine[] = [
  line('t1', 'usd', -73, { amountPrimary: -73, amountNative: -73, walletCurrency: 'USD' }),
  line('t1', 'clear', 73, { amountPrimary: 73, entryCurrency: 'USD' }),
  line('t2', 'clear', -73, { amountPrimary: -73, entryCurrency: 'USD' }),
  line('t2', 'cad', 100, { amountPrimary: 73, amountNative: 100, walletCurrency: 'CAD' }),
];
// A CAD receipt still waiting for its USD rate.
const pending: JournalLine[] = [
  line('p1', 'cad', 50, { amountNative: 50, walletCurrency: 'CAD', ratePending: true }),
  line('p1', 'equity', -50, { entryCurrency: 'CAD', ratePending: true }),
];
// An old imported entry with no currency recorded at all.
const legacy: JournalLine[] = [line('l1', 'usd', 500), line('l1', 'equity', -500)];

const fiat = (mode: 'wallet' | 'primary' | 'secondary', rate: number | null = null) => ({
  primaryCurrency: 'USD',
  effectiveMode: mode,
  bitcoinReport: false,
  secondaryRate: rate,
});
const bal = (ls: JournalLine[], id: string) =>
  computeAccountBalances(ls, accounts).find((b) => b.accountId === id)?.balance ?? 0;
// The General Ledger's last running balance for an account, read from its own rows.
const gl = (ls: JournalLine[], name: string) =>
  computeGeneralLedger(ls, accounts)
    .filter((r) => r.accountName === name)
    .slice(-1)[0]?.runningBalance ?? 0;

describe('reportLinesFor, fiat company (OWB-T0232)', () => {
  it('the General Ledger shows the CAD wallet at its USD amount, matching the balances', () => {
    const { lines, excluded } = reportLinesFor(transfer, fiat('primary'));
    expect(excluded).toEqual([]);
    expect(gl(lines, 'CAD Wallet')).toBe(73);
    expect(gl(lines, 'CAD Wallet')).toBe(bal(lines, 'cad'));
    expect(bal(lines, 'clear')).toBe(0);
  });

  it('on the raw lines the ledger shows 100 while the balance shows 73 (the fault)', () => {
    expect(gl(transfer, 'CAD Wallet')).toBe(100);
    expect(bal(transfer, 'cad')).toBe(73);
  });

  it('leaves out an entry still waiting for a rate, and lists it', () => {
    const { lines, excluded } = reportLinesFor([...transfer, ...pending], fiat('primary'));
    expect(excluded).toEqual([
      { journalEntryId: 'p1', date: '2026-03-01', reason: 'awaiting-rate' },
    ]);
    expect(lines.some((l) => l.journalEntryId === 'p1')).toBe(false);
    expect(bal(lines, 'cad')).toBe(73);
    expect(gl(lines, 'CAD Wallet')).toBe(73);
  });

  it('on the raw lines the pending 50 CAD is added to the USD balance as 50 USD (the fault)', () => {
    expect(bal([...transfer, ...pending], 'cad')).toBe(123);
  });

  it('keeps old entries with no currency and values them exactly as the raw lines', () => {
    const { lines, excluded } = reportLinesFor(legacy, fiat('primary'));
    expect(excluded).toEqual([]);
    for (const id of ['usd', 'equity']) expect(bal(lines, id)).toBe(bal(legacy, id));
    expect(gl(lines, 'USD Bank')).toBe(gl(legacy, 'USD Bank'));
  });

  it('a single-currency company gets the same balances as before', () => {
    const usdOnly = transfer
      .slice(0, 3)
      .concat(line('t2', 'usd', 73, { amountPrimary: 73, walletCurrency: 'USD' }));
    const both = [...usdOnly, ...legacy];
    const { lines } = reportLinesFor(both, fiat('primary'));
    for (const a of accounts) {
      expect(bal(lines, a.id)).toBe(bal(both, a.id));
      expect(gl(lines, a.name)).toBe(gl(both, a.name));
    }
  });

  it('secondary view is the primary amount times the rate, never the native amount', () => {
    const { lines } = reportLinesFor(transfer, fiat('secondary', 2));
    expect(bal(lines, 'cad')).toBe(146);
    expect(gl(lines, 'CAD Wallet')).toBe(146);
    expect(bal(lines, 'clear')).toBe(0);
  });

  it('wallet view returns the lines untouched', () => {
    const all = [...transfer, ...pending];
    const out = reportLinesFor(all, fiat('wallet'));
    expect(out.lines).toBe(all);
    expect(out.excluded).toEqual([]);
  });
});

describe('reportLinesFor, Bitcoin company', () => {
  it('still leaves out entries with no currency recorded', () => {
    const { excluded } = reportLinesFor(legacy, {
      primaryCurrency: 'BTC',
      effectiveMode: 'primary',
      bitcoinReport: true,
      secondaryRate: null,
    });
    expect(excluded.map((e) => e.reason)).toEqual(['unknown-currency']);
  });
});
