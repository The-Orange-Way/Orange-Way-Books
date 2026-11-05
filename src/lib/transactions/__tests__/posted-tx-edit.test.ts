import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  RECONCILED_REFUSAL,
  loadPostedEditSnapshot,
  postedEditRefusal,
  postedLineAccounts,
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
function fakeClient(
  rows: Array<Record<string, unknown>>,
  rpcError: string | null = null,
  txRows: Array<Record<string, unknown>> = [{ id: 'tx-src', cleared_status: 'CLEARED' }],
  entryRow: Record<string, unknown> | null = null,
  walletRows: Array<Record<string, unknown>> = [],
) {
  const calls: string[] = [];
  const rpcArgs: Array<Record<string, unknown>> = [];
  const c = {
    from: (table: string) => {
      const result = () =>
        table === 'transactions'
          ? { data: txRows, error: null }
          : table === 'wallets'
            ? { data: walletRows, error: null }
            : { data: rows, error: null };
      const q = {
        select: () => {
          calls.push(`select ${table}`);
          return q;
        },
        eq: () => q,
        in: () => q,
        order: async () => result(),
        maybeSingle: async () => ({
          data: table === 'journal_entries' ? entryRow : (txRows[0] ?? null),
          error: null,
        }),
        then: (resolve: (v: unknown) => unknown) => resolve(result()),
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
    expect(calls).toEqual([
      'select transactions',
      'select journal_entry_lines',
      'rpc owb_edit_posted_entry',
    ]);
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

describe('reconciled entries', () => {
  const input = (build: ReturnType<typeof fakeBuild>['build']) => ({
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
  });

  it('refuses when the other side of a transfer is reconciled, and sends nothing', async () => {
    const { c, calls } = fakeClient(transferRows(), null, [
      { id: 'tx-src', cleared_status: 'CLEARED' },
      { id: 'tx-dest', cleared_status: 'RECONCILED' },
    ]);
    await expect(savePostedTxEdit(c, input(fakeBuild().build))).rejects.toThrow(RECONCILED_REFUSAL);
    expect(calls).not.toContain('rpc owb_edit_posted_entry');
  });

  it('saves when no transaction on the entry is reconciled', async () => {
    const { c, calls } = fakeClient(transferRows(), null, [
      { id: 'tx-src', cleared_status: 'CLEARED' },
      { id: 'tx-dest', cleared_status: null },
    ]);
    await savePostedTxEdit(c, input(fakeBuild().build));
    expect(calls).toContain('rpc owb_edit_posted_entry');
  });
});

describe('loadPostedEditSnapshot', () => {
  const entryRow = {
    id: 'je-1',
    status: 'POSTED',
    date: '2026-10-15',
    updated_at: 't2',
    key_version: 2,
    encrypted_memo: 'C_rent',
    encrypted_currency: 'C_MXN',
    source_type: 'TRANSACTION_SPLIT',
  };
  const shown = { id: 'tx-1', amount: -100, date: '2026-10-15', memo: 'rent' };
  const txRow = (over: Record<string, unknown> = {}) => ({
    id: 'tx-1',
    date: '2026-10-15',
    amount: -100,
    memo: 'rent',
    ...over,
  });

  it('reads the version first and finds the list row current', async () => {
    const { c, calls } = fakeClient([], null, [txRow()], entryRow);
    const snap = await loadPostedEditSnapshot(c, 'je-1', shown, decrypt);
    expect(calls).toEqual(['select journal_entries', 'select transactions']);
    expect(snap.entry?.updatedAt).toBe('t2');
    expect(snap.stale).toBe(false);
  });

  it.each([
    ['amount', { amount: -120 }],
    ['date', { date: '2026-10-16' }],
    ['memo', { memo: 'office rent' }],
  ])('marks the list row stale when the %s changed since it was loaded', async (_n, over) => {
    const { c } = fakeClient([], null, [txRow(over)], entryRow);
    expect((await loadPostedEditSnapshot(c, 'je-1', shown, decrypt)).stale).toBe(true);
  });

  it('returns no entry for a draft', async () => {
    const { c } = fakeClient([], null, [txRow()], { ...entryRow, status: 'DRAFT' });
    expect(await loadPostedEditSnapshot(c, 'je-1', shown, decrypt)).toEqual({
      entry: null,
      stale: false,
    });
  });
});

describe('postedLineAccounts', () => {
  const wallets = [
    { id: 'w-usd', external_account_id: 'wallet-usd' },
    { id: 'w-mxn', external_account_id: 'wallet-mxn' },
  ];

  it('returns the accounts the stored lines use, and writes nothing', async () => {
    const { c, calls } = fakeClient(transferRows(), null, [], null, wallets);
    const a = await postedLineAccounts(c, 'je-1', ['w-usd', 'w-mxn'], decrypt);
    expect(a.wallet.get('w-usd')).toBe('wallet-usd');
    expect(a.wallet.get('w-mxn')).toBe('wallet-mxn');
    expect(a.other).toEqual([{ id: 'clearing', name: 'clearing' }]);
    expect(calls.every((x) => x.startsWith('select '))).toBe(true);
  });

  it('refuses a wallet whose account is not on the stored lines, creating nothing', async () => {
    const { c, calls } = fakeClient(transferRows(), null, [], null, [
      { id: 'w-usd', external_account_id: 'wallet-other' },
      { id: 'w-mxn', external_account_id: 'wallet-mxn' },
    ]);
    await expect(postedLineAccounts(c, 'je-1', ['w-usd', 'w-mxn'], decrypt)).rejects.toThrow(
      'Reverse the entry',
    );
    expect(calls.every((x) => x.startsWith('select '))).toBe(true);
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

  /** True when the account setup helpers, which can write, run only after the posted branch. */
  function setupAfterPosted(source: string, name: string, helpers: string[]): boolean {
    const body = handler(source, name);
    const posted = body.indexOf('savePostedTxEdit(');
    return posted > 0 && helpers.every((h) => body.indexOf(h) > posted);
  }

  it('creates no account before a posted edit is sent', () => {
    expect(setupAfterPosted(modalSource, 'handleSaveSplit', ['ensureWalletChartAccountIds('])).toBe(
      true,
    );
    expect(
      setupAfterPosted(modalSource, 'handleSaveTransfer', [
        'ensureWalletChartAccountIds(',
        'ensureTransferClearingAccount(',
      ]),
    ).toBe(true);
  });

  it('catches account setup moved back before the posted branch (broken copy)', () => {
    const body = handler(modalSource, 'handleSaveTransfer');
    const broken = modalSource.replace(
      body,
      body.replace(
        '    // A posted transfer is changed in one call',
        '    await ensureTransferClearingAccount(orgId, encryptText, decryptText);\n    // A posted transfer is changed in one call',
      ),
    );
    expect(setupAfterPosted(broken, 'handleSaveTransfer', ['ensureTransferClearingAccount('])).toBe(
      false,
    );
  });

  it('refuses a save from a stale list row', () => {
    expect(modalSource).toMatch(/if \(postedStale\) \{\s*throw new Error/);
  });

  it('reads the posted version before the transfer and split reads', () => {
    const snap = modalSource.indexOf('loadPostedEditSnapshot(\n');
    const linked = modalSource.indexOf(".eq('id', editingTx.linked_transfer_id!)");
    const lines = modalSource.indexOf(".eq('journal_entry_id', editingTx.journal_entry_id!)");
    expect(snap).toBeGreaterThan(0);
    expect(snap).toBeLessThan(linked);
    expect(snap).toBeLessThan(lines);
  });

  it('asks for a reason only on a posted entry', () => {
    expect(modalSource).toMatch(/postedEntry && !editReason\.trim\(\)/);
  });
});
