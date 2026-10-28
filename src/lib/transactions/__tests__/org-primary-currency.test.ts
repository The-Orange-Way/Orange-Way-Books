// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../crypto-fields', () => ({
  decryptOrgSettings: async (row: { primary_currency: string | null }) => ({
    primary_currency: row.primary_currency,
  }),
}));

import { loadOrgPrimaryCurrency, OrgPrimaryCurrencyError } from '../org-primary-currency';

const ORG = '00000000-0000-0000-0000-000000000001';
const decrypt = async (v: string) => v;

// Just enough of the query builder for .from().select().eq().maybeSingle().
function client(
  row: { primary_currency: string | null } | null,
  error: { message: string } | null = null,
) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: error ? null : row, error }) }),
      }),
    }),
  } as unknown as SupabaseClient;
}

/** Source of `async function <name>(` up to the next `async function`. */
function fnBody(code: string, name: string): string {
  const start = code.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  const next = code.indexOf('async function ', start + 1);
  return code.slice(start, next === -1 ? undefined : next);
}

/** The `primary_currency:` argument of every buildJournalEntryLineInsert call. */
function primaryArgs(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/buildJournalEntryLineInsert\(\{/g)) {
    const end = body.indexOf('})', m.index);
    const call = body.slice(m.index, end);
    const arg = call.match(/primary_currency:\s*([^,\n]+)/);
    out.push(arg ? arg[1].trim() : '<missing>');
  }
  return out;
}

/** True when the org primary is read before the first table write. */
function primaryReadBeforeWrites(body: string): boolean {
  const readAt = body.indexOf('await loadOrgPrimaryCurrency(');
  const writes = [
    ...body.matchAll(
      /\.from\(\s*'(journal_entries|journal_entry_lines|transactions)'\s*\)\s*\.(insert|update|delete|upsert)\(/g,
    ),
  ];
  return readAt !== -1 && writes.length > 0 && writes.every((m) => (m.index ?? 0) > readAt);
}

describe('loadOrgPrimaryCurrency', () => {
  it("returns the org's primary currency, normalised", async () => {
    await expect(
      loadOrgPrimaryCurrency(client({ primary_currency: ' btc ' }), ORG, decrypt),
    ).resolves.toBe('BTC');
  });

  it('refuses when the org has no settings row', async () => {
    await expect(loadOrgPrimaryCurrency(client(null), ORG, decrypt)).rejects.toBeInstanceOf(
      OrgPrimaryCurrencyError,
    );
  });

  it('refuses when the primary currency is empty, rather than defaulting', async () => {
    await expect(
      loadOrgPrimaryCurrency(client({ primary_currency: null }), ORG, decrypt),
    ).rejects.toBeInstanceOf(OrgPrimaryCurrencyError);
  });

  it('passes a read error through', async () => {
    await expect(
      loadOrgPrimaryCurrency(client(null, { message: 'network' }), ORG, decrypt),
    ).rejects.toEqual({ message: 'network' });
  });
});

describe('transaction modal prices every line into the org primary currency', () => {
  const code = readFileSync(
    join(__dirname, '..', '..', '..', 'components', 'transactions', 'transaction-modal.tsx'),
    'utf8',
  );

  it('split and transfer pass orgPrimary on every line and read it before writing', () => {
    for (const name of ['handleSaveSplit', 'handleSaveTransfer']) {
      const body = fnBody(code, name);
      const args = primaryArgs(body);
      expect(args.length).toBeGreaterThan(0);
      expect(args.every((a) => a === 'orgPrimary')).toBe(true);
      expect(primaryReadBeforeWrites(body)).toBe(true);
    }
    // Transfer writes four lines, split at least two.
    expect(primaryArgs(fnBody(code, 'handleSaveTransfer'))).toHaveLength(4);
  });

  it('no line in the file is priced with the picked wallet currency', () => {
    const all = primaryArgs(code);
    expect(all.length).toBeGreaterThanOrEqual(6);
    expect(all.filter((a) => a !== 'orgPrimary')).toEqual([]);
  });

  it('catches the old shape (negative controls)', () => {
    const old = `async function handleSaveSplit() {
      await supabase.from('journal_entries').insert(x);
      const r = await buildJournalEntryLineInsert({
        wallet_currency: walletCurrency,
        primary_currency: primaryCurrency,
      });
    }`;
    expect(primaryArgs(old)).toEqual(['primaryCurrency']);
    expect(primaryReadBeforeWrites(old)).toBe(false);
    const lateRead = `await supabase.from('transactions').insert(x);\nconst p = await loadOrgPrimaryCurrency(a, b, c);`;
    expect(primaryReadBeforeWrites(lateRead)).toBe(false);
  });
});
