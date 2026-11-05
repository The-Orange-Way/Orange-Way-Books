import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { RATE_FILL_REASON, fillPendingRatesOnPostedEntry } from '../fill-posted-pending-rates';
import type { BuildJeLineInsertParams, BuildJeLineInsertResult } from '../build-je-line-insert';

const decrypt = async (s: string) => s.replace(/^C_/, '');
const encrypt = async (s: string) => `C_${s}`;

function storedLine(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    journal_entry_id: 'je-1',
    account_id: `acct-${id}`,
    account_name: `C_Account ${id}`,
    account_code: null,
    description: null,
    encrypted_debit: 'C_0',
    encrypted_credit: 'C_0',
    encrypted_book_value: null,
    encrypted_amount_native: 'C_0',
    encrypted_amount_primary: null,
    encrypted_posted_rate: null,
    encrypted_wallet_currency: 'C_MXN',
    encrypted_primary_currency_at_posting: 'C_BTC',
    encrypted_manual_rate_reason: null,
    encrypted_manual_rate_source: null,
    encrypted_metadata: null,
    pinned_rate_id: null,
    rate_asof: null,
    rate_pending: false,
    dual_amounts_backfilled: true,
    key_version: 2,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

function setup(opts: {
  status?: string;
  lines: Array<Record<string, unknown>>;
  rpcError?: { message: string } | null;
}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const c = {
    from: (table: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        single: async () => ({
          data: {
            id: 'je-1',
            status: opts.status ?? 'POSTED',
            date: '2026-10-15',
            key_version: 2,
            encrypted_memo: 'C_memo',
            encrypted_currency: 'C_MXN',
          },
          error: null,
        }),
        order: async () => ({
          data: table === 'journal_entry_lines' ? opts.lines : [],
          error: null,
        }),
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return opts.rpcError ? { data: null, error: opts.rpcError } : { data: 4, error: null };
    },
  } as unknown as SupabaseClient;
  return { c, rpcCalls };
}

function fakeBuild(pending: boolean) {
  const seen: BuildJeLineInsertParams[] = [];
  const build = async (p: BuildJeLineInsertParams): Promise<BuildJeLineInsertResult> => {
    seen.push(p);
    return {
      pending,
      rate: pending ? 0 : 0.05,
      rateBucketTs: '2026-10-15T00:00:00Z',
      insert: {
        account_id: p.account_id,
        account_name: 'C_rebuilt',
        account_code: null,
        description: null,
        encrypted_debit: `C_${p.debit}`,
        encrypted_credit: `C_${p.credit}`,
        encrypted_book_value: null,
        key_version: 2,
        encrypted_amount_native: 'C_N',
        encrypted_amount_primary: pending ? null : 'C_FILLED',
        encrypted_posted_rate: pending ? null : 'C_0.05',
        encrypted_wallet_currency: 'C_MXN',
        encrypted_primary_currency_at_posting: 'C_BTC',
        encrypted_manual_rate_reason: p.manualRate ? 'C_why' : null,
        encrypted_manual_rate_source: null,
        rate_pending: pending,
        rate_asof: '2026-10-15T00:00:00Z',
        pinned_rate_id: pending ? null : 'rate-1',
        dual_amounts_backfilled: true,
      },
    };
  };
  return { build, seen };
}

const twoLines = () => [
  storedLine('a', { encrypted_debit: 'C_100', rate_pending: true }),
  storedLine('b', {
    encrypted_credit: 'C_100',
    encrypted_amount_primary: 'C_5',
    encrypted_posted_rate: 'C_0.05',
    pinned_rate_id: 'rate-0',
  }),
];

describe('fillPendingRatesOnPostedEntry', () => {
  it('fills the pending line through owb_edit_posted_entry and keeps the other line as stored', async () => {
    const { c, rpcCalls } = setup({ lines: twoLines() });
    const { build, seen } = fakeBuild(false);
    const r = await fillPendingRatesOnPostedEntry(c, 'je-1', { encrypt, decrypt, build });
    expect(r).toEqual({ filled: 1, stillPending: 0, version: 4 });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe('owb_edit_posted_entry');
    const lines = rpcCalls[0].args.p_lines as Array<Record<string, unknown>>;
    expect(lines[0].encrypted_amount_primary).toBe('C_FILLED');
    expect(lines[0].rate_pending).toBe(false);
    // The already-priced line is sent back byte for byte.
    expect(lines[1].encrypted_amount_primary).toBe('C_5');
    expect(lines[1].pinned_rate_id).toBe('rate-0');
    expect(lines[1].account_name).toBe('C_Account b');
    expect(rpcCalls[0].args.p_encrypted_reason).toBe(`C_${RATE_FILL_REASON}`);
    expect(rpcCalls[0].args.p_date).toBe('2026-10-15');
    expect(rpcCalls[0].args.p_header).toEqual({
      encrypted_memo: 'C_memo',
      encrypted_currency: 'C_MXN',
    });
  });

  it('rebuilds only pending lines, at the entry date and the currency they were posted under', async () => {
    const { c } = setup({ lines: twoLines() });
    const { build, seen } = fakeBuild(false);
    await fillPendingRatesOnPostedEntry(c, 'je-1', { encrypt, decrypt, build });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      account_id: 'acct-a',
      wallet_currency: 'MXN',
      primary_currency: 'BTC',
      date: '2026-10-15',
      debit: 100,
      credit: 0,
    });
  });

  it('sends nothing and writes no history when no rate can be found', async () => {
    const { c, rpcCalls } = setup({ lines: twoLines() });
    const { build } = fakeBuild(true);
    const r = await fillPendingRatesOnPostedEntry(c, 'je-1', { encrypt, decrypt, build });
    expect(r).toEqual({ filled: 0, stillPending: 1, version: null });
    expect(rpcCalls).toHaveLength(0);
  });

  it('uses a rate entered by hand for that line', async () => {
    const { c } = setup({ lines: twoLines() });
    const { build, seen } = fakeBuild(false);
    const manual = { rate: 0.06, reason: 'x'.repeat(40), source: 'Bank' };
    await fillPendingRatesOnPostedEntry(c, 'je-1', {
      encrypt,
      decrypt,
      build,
      manualRates: { a: manual },
    });
    expect(seen[0].manualRate).toEqual(manual);
  });

  it('leaves a pending line alone when its currencies cannot be read', async () => {
    const lines = twoLines();
    lines[0].encrypted_wallet_currency = null;
    const { c, rpcCalls } = setup({ lines });
    const { build, seen } = fakeBuild(false);
    const r = await fillPendingRatesOnPostedEntry(c, 'je-1', { encrypt, decrypt, build });
    expect(seen).toHaveLength(0);
    expect(r.stillPending).toBe(1);
    expect(rpcCalls).toHaveLength(0);
  });

  it('refuses an entry that is not posted', async () => {
    const { c, rpcCalls } = setup({ status: 'DRAFT', lines: twoLines() });
    const { build } = fakeBuild(false);
    await expect(
      fillPendingRatesOnPostedEntry(c, 'je-1', { encrypt, decrypt, build }),
    ).rejects.toThrow('Only a posted entry');
    expect(rpcCalls).toHaveLength(0);
  });

  it('passes on the database refusal', async () => {
    const { c } = setup({ lines: twoLines(), rpcError: { message: 'The month is closed.' } });
    const { build } = fakeBuild(false);
    await expect(
      fillPendingRatesOnPostedEntry(c, 'je-1', { encrypt, decrypt, build }),
    ).rejects.toThrow('The month is closed.');
  });

  it('keeps a pending line as stored when the rate lookup fails', async () => {
    const { c, rpcCalls } = setup({ lines: twoLines() });
    const build = async () => {
      throw new Error('rate service down');
    };
    const r = await fillPendingRatesOnPostedEntry(c, 'je-1', { encrypt, decrypt, build });
    expect(r).toEqual({ filled: 0, stillPending: 1, version: null });
    expect(rpcCalls).toHaveLength(0);
  });

  it('does not rebuild a pending line whose amounts are missing', async () => {
    const lines = twoLines();
    lines[0].encrypted_debit = null as unknown as string;
    lines[0].encrypted_credit = null as unknown as string;
    const { c, rpcCalls } = setup({ lines });
    const { build, seen } = fakeBuild(false);
    const r = await fillPendingRatesOnPostedEntry(c, 'je-1', { encrypt, decrypt, build });
    expect(seen).toHaveLength(0);
    expect(r.stillPending).toBe(1);
    expect(rpcCalls).toHaveLength(0);
  });
});
