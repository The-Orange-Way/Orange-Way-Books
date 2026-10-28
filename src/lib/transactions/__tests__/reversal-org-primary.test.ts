// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** The `primary_currency:` argument of every buildJournalEntryLineInsert call. */
function primaryArgs(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/buildJournalEntryLineInsert\(\{/g)) {
    const end = code.indexOf('})', m.index);
    const arg = code.slice(m.index, end).match(/primary_currency:\s*([^,\n]+)/);
    out.push(arg ? arg[1].trim() : '<missing>');
  }
  return out;
}

/** True when the org primary is read before the first table write. */
function primaryReadBeforeWrites(code: string): boolean {
  const readAt = code.indexOf('await loadOrgPrimaryCurrency(');
  const writes = [
    ...code.matchAll(
      /\.from\(\s*'(journal_entries|journal_entry_lines|transactions)'\s*\)\s*\.(insert|update|delete|upsert)\(/g,
    ),
  ];
  return readAt !== -1 && writes.length > 0 && writes.every((m) => (m.index ?? 0) > readAt);
}

describe('void and reverse value reversal lines in the org primary currency', () => {
  for (const file of ['void-transaction.ts', 'reverse-journal-entry.ts']) {
    it(file, () => {
      const code = readFileSync(join(__dirname, '..', file), 'utf8');
      const args = primaryArgs(code);
      expect(args.length).toBeGreaterThan(0);
      expect(args.every((a) => a === 'orgPrimary')).toBe(true);
      expect(primaryReadBeforeWrites(code)).toBe(true);
    });
  }

  it('catches the old shape (negative controls)', () => {
    const old = `await supabase.from('journal_entries').insert(x);
      const r = await buildJournalEntryLineInsert({
        wallet_currency: dec.wallet_currency ?? origJeDec.currency,
        primary_currency: origJeDec.currency,
      });`;
    expect(primaryArgs(old)).toEqual(['origJeDec.currency']);
    expect(primaryReadBeforeWrites(old)).toBe(false);
  });
});
