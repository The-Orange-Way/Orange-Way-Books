// @vitest-environment node
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { postJournalEntry } from '../journal-entry-post';

function client(error: { message: string } | null = null) {
  const calls: Array<{ table: string; payload: unknown; id: unknown }> = [];
  const c = {
    from: (table: string) => ({
      update: (payload: unknown) => ({
        eq: async (_col: string, id: unknown) => {
          calls.push({ table, payload, id });
          return { data: null, error };
        },
      }),
    }),
  } as unknown as SupabaseClient;
  return { c, calls };
}

describe('postJournalEntry', () => {
  it('writes the plaintext status the database accepts', async () => {
    const { c, calls } = client();
    expect(await postJournalEntry(c, 'je-1')).toEqual({ error: null });
    expect(calls).toEqual([
      { table: 'journal_entries', payload: { status: 'POSTED' }, id: 'je-1' },
    ]);
  });

  it('returns the error instead of hiding it', async () => {
    const { c } = client({ message: 'violates check constraint' });
    expect((await postJournalEntry(c, 'je-1')).error).toEqual({
      message: 'violates check constraint',
    });
  });
});

/** Every `.from('journal_entries')...update({ status: X` whose X is not a string literal. */
function nonLiteralStatusWrites(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\.from\(\s*'journal_entries'\s*\)/g)) {
    const tail = code.slice(m.index, (m.index ?? 0) + 200);
    const u = tail.match(/^[^;]*?\.update\(\s*\{\s*status:\s*([^,}\s]+)/);
    if (u && !/^'[A-Z_]+'$/.test(u[1])) out.push(u[1]);
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe('journal_entries.status is written as plaintext everywhere', () => {
  const src = join(__dirname, '..', '..');

  it('no source file writes an encrypted value into journal_entries.status', () => {
    const offenders = sourceFiles(src).flatMap((f) =>
      nonLiteralStatusWrites(readFileSync(f, 'utf8')).map((x) => `${f}: ${x}`),
    );
    expect(offenders).toEqual([]);
  });

  it('both bulk Post handlers use the helper and check its error', () => {
    for (const page of ['JournalEntries.tsx', 'Transactions.tsx']) {
      const code = readFileSync(join(src, 'pages', page), 'utf8');
      const start = code.indexOf('const handleBulkPost = async');
      const body = code.slice(start, code.indexOf('\n  const ', start + 1));
      expect(body).toMatch(/const \{ error[^}]*\} = await postJournalEntry\(/);
    }
  });

  it('catches the old shape (negative controls)', () => {
    const old = `const encStatus = await encryptText('POSTED');
      const { error } = await supabase
        .from('journal_entries')
        .update({ status: encStatus, key_version: 2 } as any)
        .eq('id', id);`;
    expect(nonLiteralStatusWrites(old)).toEqual(['encStatus']);
    const ok = `await supabase.from('journal_entries').update({ status: 'VOID' } as any).eq('id', id);`;
    expect(nonLiteralStatusWrites(ok)).toEqual([]);
  });
});
