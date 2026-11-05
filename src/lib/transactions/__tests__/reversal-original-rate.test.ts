import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decryptJournalEntryLine } from '@/lib/crypto-fields';
import { reversalLineAtOriginalRate } from '../reverse-journal-entry';
import { firstOpenDay } from '@/lib/journal-entry-edit-posted';

const encrypt = async (s: string) => `C_${s}`;
const decrypt = async (s: string) => s.replace(/^C_/, '');

type Dec = Awaited<ReturnType<typeof decryptJournalEntryLine>>;
function dec(over: Partial<Dec> = {}): Dec {
  return {
    account_name: 'Cash',
    account_code: '1000',
    description: 'Sale',
    debit: 100,
    credit: 0,
    book_value: null,
    amount_native: 100,
    amount_primary: 0.00123,
    posted_rate: 0.0000123,
    wallet_currency: 'MXN',
    primary_currency_at_posting: 'BTC',
    primary_currency_at_posting_unreadable: false,
    ...over,
  } as Dec;
}
const row = { rate_pending: false, rate_asof: '2026-09-10T00:00:00Z', pinned_rate_id: 'rate-9' };

describe('reversalLineAtOriginalRate', () => {
  it('swaps the sides and negates both amounts at the original rate and currency', async () => {
    const line = await reversalLineAtOriginalRate(row, dec(), encrypt);
    expect(line).not.toBeNull();
    const back = await decryptJournalEntryLine(
      { ...line, key_version: line!.key_version },
      decrypt,
    );
    expect(back.debit).toBe(0);
    expect(back.credit).toBe(100);
    expect(back.amount_native).toBe(-100);
    expect(back.amount_primary).toBe(-0.00123);
    expect(back.posted_rate).toBe(0.0000123);
    expect(back.wallet_currency).toBe('MXN');
    expect(back.primary_currency_at_posting).toBe('BTC');
    expect(line!.pinned_rate_id).toBe('rate-9');
    expect(line!.rate_asof).toBe('2026-09-10T00:00:00Z');
    expect(line!.rate_pending).toBe(false);
    expect(line!.dual_amounts_backfilled).toBe(true);
  });

  it('cancels the original exactly in the primary currency', async () => {
    const orig = dec({ debit: 0, credit: 37.5, amount_native: -37.5, amount_primary: -0.000461 });
    const line = await reversalLineAtOriginalRate(row, orig, encrypt);
    const back = await decryptJournalEntryLine({ ...line }, decrypt);
    expect(back.amount_primary! + orig.amount_primary!).toBe(0);
    expect(back.amount_native! + orig.amount_native!).toBe(0);
  });

  it('returns null for a line the original never priced', async () => {
    expect(
      await reversalLineAtOriginalRate({ ...row, rate_pending: true }, dec(), encrypt),
    ).toBeNull();
    expect(
      await reversalLineAtOriginalRate(row, dec({ amount_primary: null }), encrypt),
    ).toBeNull();
    expect(await reversalLineAtOriginalRate(row, dec({ posted_rate: null }), encrypt)).toBeNull();
    expect(
      await reversalLineAtOriginalRate(row, dec({ primary_currency_at_posting: null }), encrypt),
    ).toBeNull();
    expect(
      await reversalLineAtOriginalRate(row, dec({ wallet_currency: null }), encrypt),
    ).toBeNull();
  });

  it('reverseJournalEntry tries the original rate before pricing afresh', () => {
    const code = readFileSync(join(__dirname, '..', 'reverse-journal-entry.ts'), 'utf8');
    const tryAt = code.indexOf('await reversalLineAtOriginalRate(row, dec');
    const buildAt = code.indexOf('await buildJournalEntryLineInsert({');
    expect(tryAt).toBeGreaterThan(-1);
    expect(buildAt).toBeGreaterThan(tryAt);
    expect(code).toMatch(
      /if \(atOriginal\) \{\s*return \{ journal_entry_id: reversalId, account_id: accountId, \.\.\.atOriginal \};/,
    );
  });
});

describe('firstOpenDay', () => {
  it('is the day after the lock date, across month and year ends', () => {
    expect(firstOpenDay('2026-09-30')).toBe('2026-10-01');
    expect(firstOpenDay('2026-12-31')).toBe('2027-01-01');
    expect(firstOpenDay('2028-02-28')).toBe('2028-02-29');
  });
});

describe('Journal screen: a posted entry in a closed month', () => {
  const page = readFileSync(join(__dirname, '../../../pages/JournalEntries.tsx'), 'utf8');
  it('offers a reversal dated the first open day', () => {
    expect(page).toMatch(
      /const day = firstOpenDay\(lockDate\);\s*const done = await reverseOn\(\s*editingEntry\.id,\s*day,/,
    );
    expect(page).toMatch(
      /\{editingPostedClosed && \(\s*<Button[^>]*onClick=\{handleReverseClosed\}/,
    );
  });
  it('decides "closed" from the stored date, not the date in the form', () => {
    expect(page).toMatch(/entryFallsInLockedPeriod\(editingEntry\.date, lockDate\)/);
  });
});
