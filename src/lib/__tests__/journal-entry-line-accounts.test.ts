// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// journal_entry_lines.account_id is NOT NULL and references
// chart_of_accounts(id). A line written without it is refused with 23503 and
// the entry is left with no lines. Unit tests that mock Supabase cannot see
// that, so this test walks the source: every call to the line builder must
// pass account_id, and every insert into journal_entry_lines must read its
// error. Each walk is also run against a broken sample to prove it can fail.

vi.mock('../exchange/rate-resolver', () => ({
  resolvePinnedRate: async () => ({ rate: 1, rateId: null, bucketTs: null, pending: false }),
}));

const ROOT = join(__dirname, '..', '..', '..');
const SRC = join(ROOT, 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

/** The argument text of each `buildJournalEntryLineInsert({ ... })` call. */
function builderCalls(code: string): string[] {
  const calls: string[] = [];
  const re = /buildJournalEntryLineInsert\(\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let depth = 0;
    const start = m.index + m[0].length - 1;
    for (let i = start; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}' && --depth === 0) {
        calls.push(code.slice(start, i + 1));
        break;
      }
    }
  }
  return calls;
}

/** Calls that name no account. A spread is only accepted when the spread
 *  value's type requires account_id (the JournalEntries wrapper). */
function callsWithoutAccount(code: string): string[] {
  return builderCalls(code).filter(
    (args) => !/\baccount_id\b/.test(args) && !/\.\.\.params\b/.test(args),
  );
}

/** Inserts into journal_entry_lines whose result is not read for an error. */
function uncheckedLineInserts(code: string): string[] {
  const found: string[] = [];
  const re = /\.from\(\s*'journal_entry_lines'\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const rest = code.slice(m.index);
    const end = rest.indexOf(';');
    const statementTail = end === -1 ? rest : rest.slice(0, end);
    if (!/\.insert\(/.test(statementTail)) continue;
    const before = code.slice(0, m.index);
    const stmtStart = Math.max(
      before.lastIndexOf(';'),
      before.lastIndexOf('{\n'),
      before.lastIndexOf('}\n'),
    );
    const head = code.slice(stmtStart + 1, m.index);
    if (!/const\s*\{[^}]*\berror\b/.test(head))
      found.push(head.trim() + statementTail.slice(0, 80));
  }
  return found;
}

function walk(check: (code: string) => string[]): string[] {
  return sourceFiles(SRC).flatMap((p) =>
    check(readFileSync(p, 'utf8')).map((hit) => `${relative(ROOT, p)}: ${hit.slice(0, 120)}`),
  );
}

describe('journal entry lines name their account', () => {
  it('finds the builder calls it checks', () => {
    // Positive control: the walk must see the known callers, or a passing
    // result below means nothing.
    const files = sourceFiles(SRC).filter((p) => builderCalls(readFileSync(p, 'utf8')).length > 0);
    expect(files.length).toBeGreaterThanOrEqual(10);
  });

  it('passes account_id on every builder call', () => {
    expect(walk(callsWithoutAccount)).toEqual([]);
  });

  it('catches a builder call with no account (negative control)', () => {
    const broken = `await buildJournalEntryLineInsert({ wallet_currency: 'USD', debit: 1, credit: 0, encrypt });`;
    const fixed = `await buildJournalEntryLineInsert({ wallet_currency: 'USD', account_id: id, debit: 1, credit: 0, encrypt });`;
    expect(callsWithoutAccount(broken)).toHaveLength(1);
    expect(callsWithoutAccount(fixed)).toHaveLength(0);
  });

  it('finds the line inserts it checks', () => {
    const inserts = sourceFiles(SRC).reduce(
      (n, p) =>
        n +
        (readFileSync(p, 'utf8').match(/\.from\(\s*'journal_entry_lines'\s*\)\s*\.insert\(/g) ?? [])
          .length,
      0,
    );
    expect(inserts).toBeGreaterThanOrEqual(10);
  });

  it('reads the error of every insert into journal_entry_lines', () => {
    expect(walk(uncheckedLineInserts)).toEqual([]);
  });

  it('catches an insert whose error is ignored (negative control)', () => {
    const broken = `{\n  await supabase.from('journal_entry_lines').insert(rows as any);\n}`;
    const fixed = `{\n  const { error: e } = await supabase.from('journal_entry_lines').insert(rows as any);\n}`;
    expect(uncheckedLineInserts(broken)).toHaveLength(1);
    expect(uncheckedLineInserts(fixed)).toHaveLength(0);
  });
});

describe('buildJournalEntryLineInsert', () => {
  const encrypt = async (s: string) => `enc:${s}`;
  const base = {
    wallet_currency: 'USD',
    primary_currency: 'USD',
    date: '2026-01-15',
    debit: 10,
    credit: 0,
    encrypt,
  };

  it('puts account_id on the row it returns', async () => {
    const { buildJournalEntryLineInsert } = await import('../exchange/build-je-line-insert');
    const res = await buildJournalEntryLineInsert({ ...base, account_id: 'acct-1' });
    expect(res.insert.account_id).toBe('acct-1');
  });

  it('refuses a line with no account', async () => {
    const { buildJournalEntryLineInsert } = await import('../exchange/build-je-line-insert');
    await expect(buildJournalEntryLineInsert({ ...base, account_id: '' })).rejects.toThrow(
      'needs an account',
    );
  });
});
