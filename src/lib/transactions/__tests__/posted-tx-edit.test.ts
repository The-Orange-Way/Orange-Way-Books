import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  postedEditRefusal,
  savePostedTxEdit,
  type PostedEditedLine,
  type PostedEntry,
  type PostedTxShape,
} from '../posted-tx-edit';
import type { BuildLineParams, EditLine } from '@/lib/journal-entry-edit-posted';

const decrypt = async (s: string) => s.replace(/^C_/, '');
const encrypt = async (s: string) => `C_${s}`;

const entry: PostedEntry = {
  id: 'je-1',
  date: '2026-10-15',
  updatedAt: 't1',
  keyVersion: 2,
  encryptedMemo: 'C_rent',
  encryptedCurrency: 'C_MXN',
  sourceType: 'TRANSACTION_TRANSFER',
};

function stored(
  id: string,
  account: string,
  currency: string,
  debit: number,
  credit: number,
  over: Record<string, unknown> = {},
) {
  return {
    id,
    journal_entry_id: 'je-1',
    account_id: account,
    account_name: `C_${account}`,
    account_code: null,
    description: 'C_rent',
    encrypted_debit: `C_${debit}`,
    encrypted_credit: `C_${credit}`,
    encrypted_book_value: null,
    encrypted_amount_native: `C_${debit || credit}`,
    encrypted_amount_primary: `C_stored-${id}`,
    encrypted_posted_rate: `C_rate-${id}`,
    encrypted_wallet_currency: `C_${currency}`,
    encrypted_primary_currency_at_posting: 'C_BTC',
    encrypted_manual_rate_reason: null,
    encrypted_manual_rate_source: null,
    encrypted_metadata: null,
    pinned_rate_id: `pin-${id}`,
    rate_asof: null,
    rate_pending: false,
    dual_amounts_backfilled: true,
    key_version: 2,
    created_at: '2026-10-01T00:00:00Z',
    ...over,
  };
}

/** A transfer of 100 USD that arrived as 1700 MXN. */
const transferRows = () => [
  stored('l1', 'wallet-mxn', 'MXN', 1700, 0),
  stored('l2', 'clearing', 'MXN', 0, 1700),
  stored('l3', 'clearing', 'USD', 100, 0),
  stored('l4', 'wallet-usd', 'USD', 0, 100),
];

const line = (
  accountId: string,
  currency: string,
  debit: number,
  credit: number,
): PostedEditedLine => ({
  accountId,
  accountName: accountId,
  accountCode: null,
  description: 'rent',
  debit,
  credit,
  currency,
});

/** Records every call. Only reads and the one edit function are allowed. */
function fakeClient(rows: Array<Record<string, unknown>>, rpcError: string | null = null) {
  const calls: string[] = [];
  const rpcArgs: Array<Record<string, unknown>> = [];
  const c = {
    from: (table: string) => {
      const q = {
        select: () => {
          calls.push(`select ${table}`);
          return q;
        },
        eq: () => q,
        order: async () => ({ data: rows, error: null }),
        insert: () => {
          calls.push(`insert ${table}`);
          return q;
        },
        update: () => {
          calls.push(`update ${table}`);
          return q;
        },
        delete: () => {
          calls.push(`delete ${table}`);
          return q;
        },
      };
      return q;
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push(`rpc ${fn}`);
      rpcArgs.push(args);
      return rpcError ? { data: null, error: { message: rpcError } } : { data: 3, error: null };
    },
  } as unknown as SupabaseClient;
  return { c, calls, rpcArgs };
}

function fakeBuild() {
  const seen: BuildLineParams[] = [];
  const build = async (p: BuildLineParams) => {
    seen.push(p);
    const insert = {
      account_id: p.account_id,
      account_name: `C_${p.account_name}`,
      account_code: null,
      description: `C_${p.description}`,
      encrypted_debit: `C_${p.debit}`,
      encrypted_credit: `C_${p.credit}`,
      encrypted_amount_native: `C_${p.debit || p.credit}`,
      encrypted_amount_primary: 'C_rebuilt',
      encrypted_posted_rate: 'C_new-rate',
      encrypted_wallet_currency: `C_${p.wallet_currency}`,
      encrypted_primary_currency_at_posting: `C_${p.primary_currency}`,
      rate_pending: false,
      pinned_rate_id: 'pin-new',
      key_version: 2,
    } as unknown as EditLine;
    return { insert, pending: false };
  };
  return { build, seen };
}

const txs = [
  {
    id: 'tx-src',
    date: '2026-10-16',
    encrypted_amount: 'C_-100',
    signature_b64: 's1',
    signature_key_version: 1,
  },
  {
    id: 'tx-dest',
    date: '2026-10-16',
    encrypted_amount: 'C_1800',
    signature_b64: 's2',
    signature_key_version: 1,
  },
];

describe('savePostedTxEdit', () => {
  it('saves a posted transfer in one edit call, with no direct line or transaction writes', async () => {
    const { c, calls, rpcArgs } = fakeClient(transferRows());
    const { build } = fakeBuild();
    const version = await savePostedTxEdit(c, {
      entry,
      date: '2026-10-15',
      primaryCurrency: 'BTC',
      reason: 'Bank statement shows 1800 MXN arrived',
      encrypt,
      decrypt,
      build,
      lines: [
        line('wallet-mxn', 'MXN', 1800, 0),
        line('clearing', 'MXN', 0, 1800),
        line('clearing', 'USD', 100, 0),
        line('wallet-usd', 'USD', 0, 100),
      ],
      txs,
    });
    expect(version).toBe(3);
    expect(calls).toEqual(['select journal_entry_lines', 'rpc owb_edit_posted_entry']);
    const a = rpcArgs[0];
    expect(a.p_je_id).toBe('je-1');
    expect(a.p_expected_updated_at).toBe('t1');
    expect(a.p_encrypted_reason).toBe('C_Bank statement shows 1800 MXN arrived');
    expect(a.p_header).toEqual({ encrypted_memo: 'C_rent', encrypted_currency: 'C_MXN' });
    expect(a.p_txs).toEqual(txs);
  });

  it('keeps the stored rate on lines whose value did not change, per currency', async () => {
    const { c, rpcArgs } = fakeClient(transferRows());
    const { build, seen } = fakeBuild();
    await savePostedTxEdit(c, {
      entry,
      date: '2026-10-15',
      primaryCurrency: 'BTC',
      reason: 'Corrected received amount',
      encrypt,
      decrypt,
      build,
      lines: [
        line('wallet-mxn', 'MXN', 1800, 0),
        line('clearing', 'MXN', 0, 1800),
        line('clearing', 'USD', 100, 0),
        line('wallet-usd', 'USD', 0, 100),
      ],
      txs,
    });
    const sent = rpcArgs[0].p_lines as Array<Record<string, unknown>>;
    // The two MXN lines changed and are rebuilt in MXN under the entry's primary.
    expect(seen.map((p) => [p.account_id, p.wallet_currency, p.primary_currency])).toEqual([
      ['wallet-mxn', 'MXN', 'BTC'],
      ['clearing', 'MXN', 'BTC'],
    ]);
    expect(sent[0].encrypted_amount_primary).toBe('C_rebuilt');
    // The USD lines are sent back as stored, in the same order.
    expect(sent[2].pinned_rate_id).toBe('pin-l3');
    expect(sent[3].pinned_rate_id).toBe('pin-l4');
    expect(sent[3].encrypted_amount_primary).toBe('C_stored-l4');
  });

  it('refuses a missing reason before reading or sending anything', async () => {
    const { c, calls } = fakeClient(transferRows());
    const { build } = fakeBuild();
    await expect(
      savePostedTxEdit(c, {
        entry,
        date: '2026-10-15',
        primaryCurrency: 'BTC',
        reason: '  ',
        encrypt,
        decrypt,
        build,
        lines: [line('wallet-mxn', 'MXN', 1700, 0), line('clearing', 'MXN', 0, 1700)],
        txs,
      }),
    ).rejects.toThrow('Say why');
    expect(calls).toEqual([]);
  });

  it('refuses unbalanced lines without calling the edit function', async () => {
    const { c, calls } = fakeClient(transferRows());
    const { build } = fakeBuild();
    await expect(
      savePostedTxEdit(c, {
        entry,
        date: '2026-10-15',
        primaryCurrency: 'BTC',
        reason: 'typo',
        encrypt,
        decrypt,
        build,
        lines: [line('wallet-mxn', 'MXN', 1800, 0), line('clearing', 'MXN', 0, 1700)],
        txs,
      }),
    ).rejects.toThrow('Debits and credits must be equal');
    expect(calls).not.toContain('rpc owb_edit_posted_entry');
  });

  it('passes on the database refusal', async () => {
    const { c } = fakeClient(transferRows(), 'The month is closed.');
    const { build } = fakeBuild();
    await expect(
      savePostedTxEdit(c, {
        entry,
        date: '2026-10-15',
        primaryCurrency: 'BTC',
        reason: 'typo',
        encrypt,
        decrypt,
        build,
        lines: [
          line('wallet-mxn', 'MXN', 1700, 0),
          line('clearing', 'MXN', 0, 1700),
          line('clearing', 'USD', 100, 0),
          line('wallet-usd', 'USD', 0, 100),
        ],
        txs,
      }),
    ).rejects.toThrow('The month is closed.');
  });
});

describe('postedEditRefusal', () => {
  const was: PostedTxShape = {
    mode: 'transfer',
    walletId: 'w1',
    counterpartyWalletId: 'w2',
    direction: 'OUT',
    memo: 'rent',
  };

  it('allows a change to amounts and date only', () => {
    expect(postedEditRefusal(was, { ...was, memo: ' rent ' })).toBeNull();
  });

  it.each([
    ['mode', { mode: 'standard' as const }, 'cannot be changed into'],
    ['wallet', { walletId: 'w9' }, 'another wallet'],
    ['other wallet', { counterpartyWalletId: 'w9' }, 'another wallet'],
    ['direction', { direction: 'IN' as const }, 'direction'],
    ['memo', { memo: 'office rent' }, 'memo'],
  ])('refuses a change of %s', (_name, change, text) => {
    expect(postedEditRefusal(was, { ...was, ...change })).toContain(text);
  });
});

// The transaction screen itself: a posted split or transfer must go through
// savePostedTxEdit and return before the draft path deletes or inserts lines.
const modalSource = readFileSync(
  join(__dirname, '..', '..', '..', 'components', 'transactions', 'transaction-modal.tsx'),
  'utf8',
);

function handler(source: string, name: string): string {
  const start = source.indexOf(`async function ${name}(`);
  if (start < 0) return '';
  const end = source.indexOf('\n  async function ', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}

/** True when the posted branch runs, and returns, before any direct line write. */
function postedGoesFirst(source: string, name: string): boolean {
  const body = handler(source, name);
  const posted = body.indexOf('savePostedTxEdit(');
  const firstLineWrite = body.indexOf(".from('journal_entry_lines')");
  if (posted < 0 || firstLineWrite < 0) return false;
  const branch = body.slice(posted, firstLineWrite);
  return posted < firstLineWrite && /\n\s+return;\n/.test(branch);
}

describe('transaction screen, posted entries', () => {
  it.each(['handleSaveSplit', 'handleSaveTransfer'])(
    '%s sends a posted entry through the edit function first',
    (name) => {
      expect(postedGoesFirst(modalSource, name)).toBe(true);
    },
  );

  it('catches the old draft path (broken copy: the posted branch removed)', () => {
    // The old save: header to DRAFT, delete lines, insert lines, three calls.
    const broken = modalSource.replace(/savePostedTxEdit\(/g, 'notCalled(');
    expect(postedGoesFirst(broken, 'handleSaveSplit')).toBe(false);
    expect(postedGoesFirst(broken, 'handleSaveTransfer')).toBe(false);
  });

  it('catches a posted branch that falls through to the draft path', () => {
    const body = handler(modalSource, 'handleSaveSplit');
    const posted = body.indexOf('savePostedTxEdit(');
    const firstLineWrite = body.indexOf(".from('journal_entry_lines')");
    const branch = body.slice(posted, firstLineWrite);
    const broken = modalSource.replace(branch, branch.replace(/\n(\s+)return;\n/, '\n'));
    expect(postedGoesFirst(broken, 'handleSaveSplit')).toBe(false);
  });

  it('asks for a reason only on a posted entry', () => {
    expect(modalSource).toMatch(/postedEntry && !editReason\.trim\(\)/);
  });
});
