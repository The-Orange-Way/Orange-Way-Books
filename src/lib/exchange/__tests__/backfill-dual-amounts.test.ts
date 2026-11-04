// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// A page of rows, then nothing; every upsert payload is kept for inspection.
const db = vi.hoisted(() => ({ rows: [] as any[], upserts: [] as any[], calls: 0 }));
vi.mock('@/lib/supabase', () => {
  const query: any = {
    select: () => query,
    eq: () => query,
    order: () => query,
    limit: () => query,
    gt: () => query,
    then: (resolve: (v: unknown) => void) =>
      resolve({ data: db.calls++ === 0 ? db.rows : [], error: null }),
  };
  return {
    supabase: {
      from: () => ({
        ...query,
        upsert: async (u: any[]) => {
          db.upserts.push(...u);
          return { error: null };
        },
      }),
    },
  };
});
const resolver = vi.hoisted(() => ({ args: [] as any[] }));
vi.mock('../rate-resolver', () => ({
  resolvePinnedRate: async (a: { source: string; target: string; at: string }) => {
    resolver.args.push(a);
    if (!/^[A-Z]{3,4}$/.test(a.target)) throw new Error(`unsupported currency ${a.target}`);
    return { rate: 0.73, rateId: null, bucketTs: '2026-10-29T00:00:00Z', pending: false };
  },
}));

import { backfillDualAmounts, clearBackfillProgress } from '../backfill-dual-amounts';

// A stand-in cipher: ciphertext is clearly not a currency code, and decrypting reverses it.
const encrypt = async (s: string) => `ct:${s}`;
const decrypt = async (s: string) => {
  if (!s.startsWith('ct:')) throw new Error('bad ciphertext');
  return s.slice(3);
};
const row = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  key_version: 2,
  account_id: 'a',
  journal_entry_id: 'je',
  encrypted_debit: 'ct:100',
  encrypted_credit: null,
  encrypted_book_value: null,
  account_name: 'ct:CAD Wallet',
  account_code: null,
  description: null,
  encrypted_amount_native: 'ct:100',
  encrypted_wallet_currency: 'ct:CAD',
  encrypted_primary_currency_at_posting: 'ct:USD',
  rate_pending: true,
  journal_entries: { date: '2026-10-29', org_id: 'o' },
  ...extra,
});
const run = () =>
  backfillDualAmounts('o', 'USD', encrypt, decrypt, {
    onProgress: () => {},
    onDone: () => {},
    onError: () => {},
  } as any);

describe('backfillDualAmounts (OWB-T0237)', () => {
  beforeEach(() => {
    db.rows = [];
    db.upserts = [];
    db.calls = 0;
    resolver.args = [];
    clearBackfillProgress();
  });

  it('prices the line in its decrypted posting currency, not the ciphertext', async () => {
    db.rows = [row('1')];
    await run();
    expect(resolver.args).toEqual([{ source: 'CAD', target: 'USD', at: '2026-10-29' }]);
    const u = db.upserts[0];
    expect(await decrypt(u.encrypted_primary_currency_at_posting)).toBe('USD');
    expect(Number(await decrypt(u.encrypted_amount_primary))).toBeCloseTo(73);
    expect(u.rate_pending).toBe(false);
  });

  it('never writes nulls over a row it failed on', async () => {
    db.rows = [row('2', { encrypted_amount_native: 'garbage', encrypted_debit: 'garbage' })];
    const p = await run();
    expect(p.failed).toBe(1);
    expect(db.upserts).toEqual([]);
  });

  it('leaves a line whose posting currency cannot be read untouched', async () => {
    db.rows = [row('3', { encrypted_primary_currency_at_posting: 'not-ciphertext' })];
    const p = await run();
    expect(p.failed).toBe(1);
    expect(resolver.args).toEqual([]);
    expect(db.upserts).toEqual([]);
  });
});
