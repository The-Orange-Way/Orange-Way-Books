// @vitest-environment node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The posting currency is stored only as encrypted_primary_currency_at_posting. The old plaintext
// column no longer exists, so reading it from a raw row always gives undefined (OWB-T0232).
const root = join(__dirname, '..', '..');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === '__tests__' ? [] : files(p);
    return /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
// Takeout import reads the posting currency from the backup file, where it is plain text.
const sources = files(root)
  .filter((p) => !p.endsWith(join('takeout', 'import.ts')))
  .map((p) => ({ p, s: readFileSync(p, 'utf8') }));

describe('posting currency is read from the decrypted fields', () => {
  it('no report or export maps it from the raw row', () => {
    const raw = sources.filter(({ s }) =>
      /(primaryCurrencyAtPosting|primary_currency_at_posting):\s*\(?l\.primary_currency_at_posting/.test(
        s,
      ),
    );
    expect(raw.map(({ p }) => p.slice(root.length + 1))).toEqual([]);
  });

  it('every page that sets the posting currency on a line also passes the unreadable flag', () => {
    const missing = sources.filter(
      ({ s }) =>
        /primaryCurrencyAtPosting:\s*fields\.primary_currency_at_posting/.test(s) &&
        !/postingCurrencyUnreadable:\s*fields\.primary_currency_at_posting_unreadable/.test(s),
    );
    expect(missing.map(({ p }) => p.slice(root.length + 1))).toEqual([]);
  });
});
