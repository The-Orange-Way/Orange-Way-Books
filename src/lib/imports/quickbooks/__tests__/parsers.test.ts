// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fingerprintQuickBooksWorkbook } from '../fingerprint';
import { parseContacts, parseJournal, parseTrialBalance, parseValidationReport } from '../parsers';
import { classifyQuickBooksAccounts } from '../classifyAccounts';

const FIXTURE_DIR = path.resolve(__dirname, '../../../../../docs/fixtures/quickbooks');

async function readFixture(name: string): Promise<Uint8Array> {
  const buf = await readFile(path.join(FIXTURE_DIR, name));
  return new Uint8Array(buf);
}

describe('QuickBooks fingerprint', () => {
  it.each([
    ['Trial_balance.xlsx', 'TRIAL_BALANCE'],
    ['Journal.xlsx', 'JOURNAL'],
    ['Customers.xlsx', 'CUSTOMERS'],
    ['Vendors.xlsx', 'VENDORS'],
    ['Employees.xlsx', 'EMPLOYEES'],
    ['Balance_sheet.xlsx', 'BALANCE_SHEET'],
    ['Profit_and_loss.xlsx', 'PROFIT_AND_LOSS'],
    ['General_ledger.xlsx', 'GENERAL_LEDGER'],
  ])('detects %s as %s', async (file, expected) => {
    const buf = await readFixture(file);
    const type = await fingerprintQuickBooksWorkbook(buf);
    expect(type).toBe(expected);
  });
});

describe('Trial balance parser', () => {
  it('parses 20 accounts and balances', async () => {
    const buf = await readFixture('Trial_balance.xlsx');
    const { accounts, errors } = await parseTrialBalance(buf, 'Trial_balance.xlsx');
    expect(errors).toEqual([]);
    expect(accounts).toHaveLength(20);

    const debitSum = accounts.reduce((s, a) => s + Number(a.debit), 0);
    const creditSum = accounts.reduce((s, a) => s + Number(a.credit), 0);
    expect(Math.abs(debitSum - creditSum)).toBeLessThan(0.01);
  });

  it('skips the export-timestamp footer row', async () => {
    const buf = await readFixture('Trial_balance.xlsx');
    const { accounts } = await parseTrialBalance(buf);
    expect(accounts.every((a) => !/^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,/i.test(a.name))).toBe(
      true,
    );
  });
});

describe('Contacts parser', () => {
  it('parses 3 contact files summing to 275 contacts', async () => {
    const [customers, vendors, employees] = await Promise.all([
      readFixture('Customers.xlsx').then((b) => parseContacts(b, 'CUSTOMER')),
      readFixture('Vendors.xlsx').then((b) => parseContacts(b, 'VENDOR')),
      readFixture('Employees.xlsx').then((b) => parseContacts(b, 'EMPLOYEE')),
    ]);
    const total = customers.contacts.length + vendors.contacts.length + employees.contacts.length;
    expect(total).toBe(275);
    expect(customers.errors).toEqual([]);
    expect(vendors.errors).toEqual([]);
    expect(employees.errors).toEqual([]);
  });
});

describe('Journal parser', () => {
  it('parses 427 journal entries, every entry balances, each has >= 2 lines', async () => {
    const buf = await readFixture('Journal.xlsx');
    const { journalEntries, errors } = await parseJournal(buf, 'Journal.xlsx');
    expect(errors).toEqual([]);
    expect(journalEntries).toHaveLength(427);

    for (const entry of journalEntries) {
      expect(entry.lines.length).toBeGreaterThanOrEqual(2);
      const debitSum = entry.lines.reduce((s, l) => s + Number(l.debit), 0);
      const creditSum = entry.lines.reduce((s, l) => s + Number(l.credit), 0);
      expect(Math.abs(debitSum - creditSum)).toBeLessThan(0.01);
    }
  });

  it('does not treat the export-timestamp footer as a new entry', async () => {
    const buf = await readFixture('Journal.xlsx');
    const { journalEntries } = await parseJournal(buf);
    const bogus = journalEntries.find((entry) =>
      /^(mon|tue|wed|thu|fri|sat|sun)[a-z]*,/i.test(entry.type ?? ''),
    );
    expect(bogus).toBeUndefined();
  });
});

describe('Validation reports', () => {
  it('parses balance sheet and P&L lines without errors', async () => {
    const [bs, pl] = await Promise.all([
      readFixture('Balance_sheet.xlsx').then((b) => parseValidationReport(b, 'Balance_sheet.xlsx')),
      readFixture('Profit_and_loss.xlsx').then((b) =>
        parseValidationReport(b, 'Profit_and_loss.xlsx'),
      ),
    ]);
    expect(bs.errors).toEqual([]);
    expect(pl.errors).toEqual([]);
    expect(bs.lines.length).toBeGreaterThan(0);
    expect(pl.lines.length).toBeGreaterThan(0);
  });
});

describe('Account classifier', () => {
  it('classifies Undeposited Funds as ASSET / OTHER_CURRENT_ASSETS (not SUSPENSE)', () => {
    const { confident } = classifyQuickBooksAccounts(['Undeposited Funds']);
    expect(confident['Undeposited Funds']).toEqual({
      accountType: 'ASSET',
      accountSubType: 'OTHER_CURRENT_ASSETS',
      normalBalance: 'DEBIT',
      isWallet: false,
      isSystem: true,
    });
  });

  it('classifies Bank Charges as EXPENSE (not WALLETS)', () => {
    const { confident } = classifyQuickBooksAccounts(['Bank Charges']);
    expect(confident['Bank Charges']?.accountType).toBe('EXPENSE');
    expect(confident['Bank Charges']?.accountSubType).toBe('GENERAL_AND_ADMINISTRATIVE');
  });

  it('classifies Checking as WALLETS', () => {
    const { confident } = classifyQuickBooksAccounts(['Primary Checking']);
    expect(confident['Primary Checking']?.accountSubType).toBe('WALLETS');
    expect(confident['Primary Checking']?.isWallet).toBe(true);
  });

  it('classifies the real 20-account fixture with few ambiguous', async () => {
    const buf = await readFixture('Trial_balance.xlsx');
    const { accounts } = await parseTrialBalance(buf);
    const { confident, ambiguous } = classifyQuickBooksAccounts(accounts.map((a) => a.name));
    expect(Object.keys(confident).length + ambiguous.length).toBe(accounts.length);
    // Sanity: at least half are auto-classified from a realistic QB book.
    expect(Object.keys(confident).length).toBeGreaterThanOrEqual(accounts.length / 2);
  });
});

describe('End-to-end reconciliation', () => {
  it('journal imports tie back to the trial balance within $0.01 per account', async () => {
    const [tbBuf, jrBuf] = await Promise.all([
      readFixture('Trial_balance.xlsx'),
      readFixture('Journal.xlsx'),
    ]);
    const { accounts } = await parseTrialBalance(tbBuf);
    const { journalEntries } = await parseJournal(jrBuf);

    const tbByName = new Map<string, number>();
    for (const a of accounts) {
      tbByName.set(a.name, Number(a.debit) - Number(a.credit));
    }

    const importedByName = new Map<string, number>();
    for (const entry of journalEntries) {
      for (const line of entry.lines) {
        importedByName.set(
          line.accountName,
          (importedByName.get(line.accountName) ?? 0) + Number(line.debit) - Number(line.credit),
        );
      }
    }

    // For each account that appears in both TB and Journal, imported ~= TB.
    // Journal may reference a few accounts the TB doesn't list (or vice versa)
    // on sparse books, only assert on the overlap.
    let overlap = 0;
    for (const [name, tb] of tbByName.entries()) {
      if (!importedByName.has(name)) continue;
      overlap += 1;
      const imported = importedByName.get(name) ?? 0;
      expect(Math.abs(tb - imported)).toBeLessThan(0.01);
    }
    expect(overlap).toBeGreaterThan(0);
  });
});
