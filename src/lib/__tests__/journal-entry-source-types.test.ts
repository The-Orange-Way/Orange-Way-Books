// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every source_type the app writes on journal_entries must be allowed by the
// journal_entries_source_type_check constraint, or the insert fails with
// 23514 and nothing is saved. Unit tests that mock Supabase cannot see that,
// so this test reads the constraint from the migrations and the values from
// the source.

const ROOT = join(__dirname, '..', '..', '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const SRC = join(ROOT, 'src');

// The generated samples write 'seed'; they only reach the database through the
// takeout restore, which stores any value the constraint refuses as null.
const RESTORE_ONLY = new Set([
  'src/lib/takeout/seed/coffee-shop.ts',
  'src/lib/takeout/seed/miner-company.ts',
]);

function allowedSourceTypes(): Set<string> {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  // The last migration that spells out the list is the one in force.
  let list: string | null = null;
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    const m = sql.match(/source_type IS NULL OR source_type IN \(([\s\S]*?)\)\)/);
    if (m) list = m[1];
  }
  if (!list) throw new Error('no migration lists the allowed journal_entries.source_type values');
  return new Set([...list.matchAll(/'([^']+)'/g)].map((x) => x[1]));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [p] : [];
  });
}

function writtenSourceTypes(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const add = (value: string, file: string) =>
    found.set(value, [...(found.get(value) ?? []), file]);
  for (const p of sourceFiles(SRC)) {
    const rel = relative(ROOT, p);
    if (RESTORE_ONLY.has(rel)) continue;
    const code = readFileSync(p, 'utf8');
    for (const m of code.matchAll(/source_type:\s*'([^']+)'/g)) add(m[1], rel);
    // The QuickBooks importer writes source_type: SOURCE_TAG.
    if (/source_type:\s*SOURCE_TAG/.test(code)) {
      const tag = code.match(/const SOURCE_TAG\s*=\s*'([^']+)'/);
      if (tag) add(tag[1], rel);
    }
  }
  return found;
}

describe('journal_entries.source_type', () => {
  it('finds the values the app writes', () => {
    const written = writtenSourceTypes();
    expect(written.has('TRANSACTION_TRANSFER')).toBe(true);
    expect(written.has('quickbooks')).toBe(true);
  });

  it('allows every value the app writes', () => {
    const allowed = allowedSourceTypes();
    const refused = [...writtenSourceTypes()]
      .filter(([value]) => !allowed.has(value))
      .map(([value, files]) => `${value} (${[...new Set(files)].join(', ')})`);
    expect(refused).toEqual([]);
  });
});
