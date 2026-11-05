// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

import { BUSINESS_TABLES } from '../rekey';

// The edit history of posted entries (OWB-T0238) holds ciphertext. Key rotation must rewrite every
// encrypted text column of both history tables, so the list here is checked against the columns
// the database guard lets rotation change.
const migration = readFileSync(
  resolve(__dirname, '../../../supabase/migrations/20261105160000_owb_edit_posted_entry.sql'),
  'utf8',
);

const rekeyBatch = readFileSync(
  resolve(__dirname, '../../../supabase/functions/rekey-batch/index.ts'),
  'utf8',
);

// The server-side rotation writer only accepts listed tables and columns.
function serverColumns(table: string): string[] | null {
  if (!new RegExp(`ALLOWED_REKEY_TABLES = new Set\\(\\[[^\\]]*'${table}'`).test(rekeyBatch))
    return null;
  const m = rekeyBatch.match(new RegExp(`\\n  ${table}: new Set\\(\\[([^\\]]+)\\]`));
  return m ? [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort() : null;
}

function guardColumns(table: string): string[] {
  const branch =
    table === 'journal_entry_versions'
      ? /IF TG_TABLE_NAME = 'journal_entry_versions' THEN\s+v_keep := ARRAY\[([^\]]+)\]/
      : /ELSE\s+v_keep := ARRAY\[([^\]]+)\]/;
  const m = migration.match(branch);
  if (!m) throw new Error(`guard list for ${table} not found`);
  return (
    [...m[1].matchAll(/'([a-z_]+)'/g)]
      .map((x) => x[1])
      // key_version and dek_key_version are version stamps; encrypted_metadata is JSON, which
      // rotation does not rewrite on the live tables either.
      .filter((c) => !['key_version', 'dek_key_version', 'encrypted_metadata'].includes(c))
      .sort()
  );
}

describe('key rotation covers the entry history', () => {
  for (const table of ['journal_entry_versions', 'journal_entry_line_versions']) {
    it(`rewrites every encrypted column of ${table}`, () => {
      const desc = BUSINESS_TABLES.find((d) => d.table === table);
      expect(desc, `${table} is missing from the rotation list`).toBeDefined();
      expect(desc!.orgColumn).toBe('org_id');
      expect([...desc!.encryptedColumns].sort()).toEqual(guardColumns(table));
      expect(serverColumns(table), `rekey-batch does not accept ${table}`).toEqual(
        guardColumns(table),
      );
    });
  }
});
