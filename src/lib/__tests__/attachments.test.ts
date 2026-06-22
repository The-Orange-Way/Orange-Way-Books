/**
 * Unit tests for attachments service.
 *
 * Covers the pure / dependency-injected paths only. The Supabase storage
 * round-trip is exercised by integration tests on V3DEV (out of scope here).
 */

import { describe, it, expect, vi } from 'vitest';

import { bulkLinkAttachmentsByImportExternalId, type BulkLinkInput } from '../attachments';

// Mock supabase client that records inserts + serves canned JE lookups
function makeMockSupabase(matches: Record<string, string | null>) {
  const inserts: any[] = [];

  const fromBuilder = (table: string) => {
    if (table === 'journal_entries') {
      return {
        select: () => ({
          eq: (col1: string, val1: string) => ({
            eq: (col2: string, val2: string) => ({
              limit: async (_n: number) => {
                const id = matches[val2] ?? null;
                return { data: id ? [{ id }] : [], error: null };
              },
            }),
          }),
        }),
      };
    }
    if (table === 'attachments') {
      return {
        insert: (row: any) => {
          inserts.push(row);
          return {
            select: () => ({
              single: async () => ({
                data: {
                  id: `att-${inserts.length}`,
                  org_id: row.org_id,
                  entity_type: row.entity_type,
                  entity_id: row.entity_id,
                  file_size: row.file_size,
                  storage_path: row.storage_path,
                  created_at: new Date().toISOString(),
                },
                error: null,
              }),
            }),
          };
        },
      };
    }
    throw new Error(`mockSupabase: unexpected table ${table}`);
  };

  const storageBucket = {
    upload: vi.fn(async () => ({ error: null })),
    download: vi.fn(),
    remove: vi.fn(async () => ({ error: null })),
  };

  return {
    client: {
      from: fromBuilder,
      storage: { from: () => storageBucket },
    } as any,
    inserts,
    storageBucket,
  };
}

const fakeEncrypt = async (plaintext: string) => `cipher(${plaintext})`;
const fakeBlindIndex = async (v: string | null | undefined) =>
  v ? `hmac(${v.toLowerCase()})` : null;

function fakeFile(name: string, size = 100): File {
  return new File([new Uint8Array(size)], name, { type: 'application/pdf' });
}

describe('bulkLinkAttachmentsByImportExternalId', () => {
  it('attaches a single Wave receipt when the JE exists', async () => {
    const matches = { 'hmac(wave-1402433495770403519)': 'je-uuid-1' };
    const { client, inserts } = makeMockSupabase(matches);

    const inputs: BulkLinkInput[] = [
      {
        source: 'wave',
        externalId: '1402433495770403519',
        file: fakeFile('homedepot.pdf'),
        fileName: 'homedepot.pdf',
        mimeType: 'application/pdf',
      },
    ];

    const results = await bulkLinkAttachmentsByImportExternalId(
      client,
      fakeEncrypt,
      fakeBlindIndex,
      'org-1',
      inputs,
    );

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('attached');
    expect(results[0].journalEntryId).toBe('je-uuid-1');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].entity_type).toBe('journal_entry');
    expect(inserts[0].entity_id).toBe('je-uuid-1');
  });

  it('returns no_match when the JE is not in the org', async () => {
    const { client, inserts } = makeMockSupabase({});

    const inputs: BulkLinkInput[] = [
      {
        source: 'wave',
        externalId: 'unknown-id',
        file: fakeFile('orphan.pdf'),
        fileName: 'orphan.pdf',
        mimeType: 'application/pdf',
      },
    ];

    const results = await bulkLinkAttachmentsByImportExternalId(
      client,
      fakeEncrypt,
      fakeBlindIndex,
      'org-1',
      inputs,
    );

    expect(results[0].status).toBe('no_match');
    expect(inserts).toHaveLength(0);
  });

  it('returns error when vault is locked (blindIndex returns null)', async () => {
    const { client, inserts } = makeMockSupabase({});

    const inputs: BulkLinkInput[] = [
      {
        source: 'wave',
        externalId: '1402',
        file: fakeFile('a.pdf'),
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
      },
    ];

    const lockedBlindIndex = async () => null;
    const results = await bulkLinkAttachmentsByImportExternalId(
      client,
      fakeEncrypt,
      lockedBlindIndex,
      'org-1',
      inputs,
    );

    expect(results[0].status).toBe('error');
    expect(results[0].error).toMatch(/vault locked/i);
    expect(inserts).toHaveLength(0);
  });

  it('handles a mixed batch: some matches, some misses', async () => {
    const matches = {
      'hmac(wave-1)': 'je-1',
      'hmac(wave-3)': 'je-3',
    };
    const { client, inserts } = makeMockSupabase(matches);

    const inputs: BulkLinkInput[] = [
      {
        source: 'wave',
        externalId: '1',
        file: fakeFile('a.pdf'),
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
      },
      {
        source: 'wave',
        externalId: '2',
        file: fakeFile('b.pdf'),
        fileName: 'b.pdf',
        mimeType: 'application/pdf',
      },
      {
        source: 'wave',
        externalId: '3',
        file: fakeFile('c.pdf'),
        fileName: 'c.pdf',
        mimeType: 'application/pdf',
      },
    ];

    const results = await bulkLinkAttachmentsByImportExternalId(
      client,
      fakeEncrypt,
      fakeBlindIndex,
      'org-1',
      inputs,
    );

    expect(results.map((r) => r.status)).toEqual(['attached', 'no_match', 'attached']);
    expect(inserts).toHaveLength(2);
    expect(inserts.map((i) => i.entity_id)).toEqual(['je-1', 'je-3']);
  });

  it('lowercases source and externalId before HMAC (consistency with P5)', async () => {
    const matches = { 'hmac(wave-abc-123)': 'je-1' };
    const { client } = makeMockSupabase(matches);

    const inputs: BulkLinkInput[] = [
      {
        source: 'wave',
        externalId: 'ABC-123',
        file: fakeFile('a.pdf'),
        fileName: 'a.pdf',
        mimeType: 'application/pdf',
      },
    ];

    const results = await bulkLinkAttachmentsByImportExternalId(
      client,
      fakeEncrypt,
      fakeBlindIndex,
      'org-1',
      inputs,
    );

    expect(results[0].status).toBe('attached');
  });
});
