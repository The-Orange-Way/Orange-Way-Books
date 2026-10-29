/**
 * previewRevaluation must never produce a line for a Bitcoin wallet. Bitcoin is a
 * capital asset, not a foreign currency, so the foreign-currency revaluation run
 * leaves BTC (and SATS, its satoshi unit) alone while still revaluing fiat wallets.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePinnedRate } from '@/lib/exchange/rate-resolver';
import type { AccountBalance, AccountInfo } from '@/lib/ledger-engine';
import { previewRevaluation, type RevaluationRunParams } from './run';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));
vi.mock('@/lib/exchange/rate-resolver', () => ({ resolvePinnedRate: vi.fn() }));

const PERIOD_END = '2026-09-30';

// Closing rates keyed by "SOURCE:TARGET". Every pair a test needs is listed, so a
// Bitcoin wallet WOULD produce a line if the exclusion were missing.
const RATES: Record<string, number> = {
  'EUR:USD': 1.1,
  'BTC:USD': 60000,
  'SATS:USD': 0.0006,
  'EUR:BTC': 0.00002,
};

interface Wallet {
  account: AccountInfo;
  currency: string;
  native: number;
}

function asset(id: string, name: string): AccountInfo {
  return {
    id,
    name,
    code: null,
    accountType: 'Asset',
    accountGroup: 'Cash',
    accountCategory: null,
  };
}

function balance(wallet: Wallet): AccountBalance {
  const { account, native } = wallet;
  return {
    accountId: account.id,
    accountName: account.name,
    accountCode: account.code,
    accountType: account.accountType,
    accountGroup: account.accountGroup,
    accountCategory: account.accountCategory,
    totalDebits: native,
    totalCredits: 0,
    balance: native,
  };
}

function runParams(primaryCurrency: string, wallets: Wallet[]): RevaluationRunParams {
  return {
    orgId: 'org-1',
    periodEnd: PERIOD_END,
    primaryCurrency,
    framework: 'IFRS',
    method: 'closing-rate',
    accounts: wallets.map((w) => w.account),
    balances: wallets.map(balance),
    walletCurrencies: new Map(wallets.map((w) => [w.account.id, w.currency])),
  };
}

beforeEach(() => {
  const resolve = vi.mocked(resolvePinnedRate);
  resolve.mockReset();
  resolve.mockImplementation(async ({ source, target }) => {
    const rate = RATES[`${source.toUpperCase()}:${target.toUpperCase()}`];
    if (rate === undefined) throw new Error(`no test rate for ${source}:${target}`);
    return {
      rate,
      rateId: null,
      bucketTs: `${PERIOD_END}T00:00:00.000Z`,
      bucketGranularity: 'DAY',
      provider: 'test',
      sourceKind: 'FIAT_FIAT',
      pending: false,
      stale: false,
    };
  });
});

describe('previewRevaluation', () => {
  const eur = asset('eur', 'EUR bank');
  const btc = asset('btc', 'Bitcoin wallet');
  const sats = asset('sats', 'Lightning wallet');
  const btcLower = asset('btc-lower', 'Bitcoin wallet (lowercase code)');

  it('revalues a foreign-currency wallet at the closing rate', async () => {
    const params = runParams('USD', [{ account: eur, currency: 'EUR', native: 1000 }]);
    const preview = await previewRevaluation(params);

    expect(preview.lines.map((l) => l.accountId)).toEqual(['eur']);
    expect(preview.lines[0].delta).toBeCloseTo(100, 6);
    expect(preview.netDelta).toBeCloseTo(100, 6);
  });

  it('never revalues a Bitcoin wallet, whatever the unit or letter case', async () => {
    const params = runParams('USD', [
      { account: eur, currency: 'EUR', native: 1000 },
      { account: btc, currency: 'BTC', native: 2 },
      { account: sats, currency: 'SATS', native: 100000 },
      { account: btcLower, currency: 'btc', native: 1 },
    ]);
    const preview = await previewRevaluation(params);

    // Only the EUR wallet produces a line, so Bitcoin adds no unrealized FX gain or loss.
    expect(preview.lines.map((l) => l.accountId)).toEqual(['eur']);
    expect(preview.totalGain).toBeCloseTo(100, 6);
    expect(preview.totalLoss).toBe(0);
    expect(preview.netDelta).toBeCloseTo(100, 6);

    // Bitcoin is skipped before any rate lookup, so no rate is fetched for it.
    const sources = vi.mocked(resolvePinnedRate).mock.calls.map(([args]) => args.source);
    expect(sources).toEqual(['EUR']);
  });

  it('still revalues a fiat wallet when Bitcoin is the primary currency', async () => {
    const params = runParams('BTC', [
      { account: eur, currency: 'EUR', native: 1000 },
      { account: btc, currency: 'BTC', native: 2 },
    ]);
    const preview = await previewRevaluation(params);

    expect(preview.lines.map((l) => l.accountId)).toEqual(['eur']);
  });
});
