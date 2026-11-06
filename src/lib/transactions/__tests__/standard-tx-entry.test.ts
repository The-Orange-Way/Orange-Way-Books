/**
 * A standard send or receive saved on the Transactions screen writes a
 * TRANSACTION_STANDARD journal entry through the split writer (OWB-T0241).
 *
 * Each check is also run against a broken copy, so a check that cannot fail
 * is caught here rather than trusted.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { postedEntryMode, type PostedEntry } from '../posted-tx-edit';

const root = join(__dirname, '..', '..', '..', '..');
const modalSrc = readFileSync(
  join(root, 'src', 'components', 'transactions', 'transaction-modal.tsx'),
  'utf8',
);
const migrationSrc = readFileSync(
  join(
    root,
    'supabase',
    'migrations',
    '20261106190000_journal_entries_source_type_transaction_standard.sql',
  ),
  'utf8',
);

const handler = (src: string, name: string) => {
  const start = src.indexOf(`async function ${name}(`);
  if (start < 0) return '';
  const end = src.indexOf('\n  async function ', start + 1);
  return src.slice(start, end < 0 ? undefined : end);
};

const entry = (sourceType: string | null): PostedEntry => ({
  id: 'je-1',
  date: '2026-01-15',
  updatedAt: '2026-01-15T00:00:00Z',
  keyVersion: 1,
  encryptedMemo: null,
  encryptedCurrency: 'enc:USD',
  sourceType,
});

type ModeFn = (e: PostedEntry) => 'standard' | 'split' | 'transfer' | null;

function modesAreRight(fn: ModeFn): boolean {
  return (
    fn(entry('TRANSACTION_STANDARD')) === 'standard' &&
    fn(entry('TRANSACTION_SPLIT')) === 'split' &&
    fn(entry('TRANSACTION_TRANSFER')) === 'transfer' &&
    fn(entry('or_import')) === null &&
    fn(entry(null)) === null
  );
}

describe('postedEntryMode', () => {
  it('reads a standard entry as standard', () => {
    expect(modesAreRight(postedEntryMode)).toBe(true);
  });

  it('the check fails on a copy that does not know standard', () => {
    const broken: ModeFn = (e) =>
      e.sourceType === 'TRANSACTION_SPLIT'
        ? 'split'
        : e.sourceType === 'TRANSACTION_TRANSFER'
          ? 'transfer'
          : null;
    expect(modesAreRight(broken)).toBe(false);
  });
});

/** The standard save goes through the split writer as kind 'standard'. */
function standardUsesEntryWriter(src: string): boolean {
  const body = handler(src, 'handleSaveStandard');
  return (
    body.includes("await handleSaveSplit(dateStr, 'standard');") &&
    body.includes("source !== 'TRANSACTION_STANDARD' && source !== 'TRANSACTION_SPLIT'") &&
    body.includes('await saveStandardRowOnly(dateStr);')
  );
}

/** The split writer marks a standard entry TRANSACTION_STANDARD. */
function writerMarksStandard(src: string): boolean {
  const body = handler(src, 'handleSaveSplit');
  return (
    body.includes("kind: 'split' | 'standard' = 'split'") &&
    body.includes("source_type: standard ? 'TRANSACTION_STANDARD' : 'TRANSACTION_SPLIT'")
  );
}

/** The row-only save sets account_id once, to the wallet. */
function rowOnlyKeepsWallet(src: string): boolean {
  const body = handler(src, 'saveStandardRowOnly');
  const payload = body.slice(body.indexOf('const payload = {'));
  const keys = payload.slice(0, payload.indexOf('};')).match(/\baccount_id:/g) ?? [];
  return keys.length === 1 && payload.includes('account_id: walletId,');
}

describe('transaction screen, standard save', () => {
  it('writes the entry through the split writer as standard', () => {
    expect(standardUsesEntryWriter(modalSrc)).toBe(true);
  });

  it('the check fails on a copy that saves only the row', () => {
    const broken = modalSrc.replace(
      "await handleSaveSplit(dateStr, 'standard');",
      'await saveStandardRowOnly(dateStr);',
    );
    expect(broken).not.toBe(modalSrc);
    expect(standardUsesEntryWriter(broken)).toBe(false);
  });

  it('marks the entry TRANSACTION_STANDARD', () => {
    expect(writerMarksStandard(modalSrc)).toBe(true);
  });

  it('the check fails on a copy that marks every entry a split', () => {
    const broken = modalSrc.replace(
      "source_type: standard ? 'TRANSACTION_STANDARD' : 'TRANSACTION_SPLIT'",
      "source_type: 'TRANSACTION_SPLIT'",
    );
    expect(broken).not.toBe(modalSrc);
    expect(writerMarksStandard(broken)).toBe(false);
  });

  it('keeps account_id as the wallet on the row-only save', () => {
    expect(rowOnlyKeepsWallet(modalSrc)).toBe(true);
  });

  it('the check fails on a copy with the category written over the wallet', () => {
    const broken = modalSrc.replace(
      'account_id: walletId,\n      // Customer',
      'account_id: walletId,\n      account_id: accountId || null,\n      // Customer',
    );
    expect(broken).not.toBe(modalSrc);
    expect(rowOnlyKeepsWallet(broken)).toBe(false);
  });
});

/** The constraint allows the new value and keeps every earlier one. */
function migrationAllowsStandard(sql: string): boolean {
  const earlier = [
    'manual',
    'or_import',
    'invoice',
    'payment',
    'void_reversal',
    'fx_revaluation',
    'opening_balance',
    'takeout_import',
    'TRANSACTION_TRANSFER',
    'TRANSACTION_SPLIT',
    'fx_revaluation_reversal',
    'quickbooks',
    'wave',
    'invoice_payment',
    'invoice_payment_merge',
  ];
  const check = sql.slice(sql.indexOf('CHECK ('), sql.indexOf('));'));
  return check.includes("'TRANSACTION_STANDARD'") && earlier.every((v) => check.includes(`'${v}'`));
}

describe('source type migration', () => {
  it('allows TRANSACTION_STANDARD and keeps the earlier values', () => {
    expect(migrationAllowsStandard(migrationSrc)).toBe(true);
  });

  it('the check fails on a copy that drops an earlier value', () => {
    const broken = migrationSrc.replace("    'wave',\n", '');
    expect(broken).not.toBe(migrationSrc);
    expect(migrationAllowsStandard(broken)).toBe(false);
  });
});
