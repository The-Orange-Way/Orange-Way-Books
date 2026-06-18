/**
 * Unit tests for the StagedImportPayload contract validator.
 */

import { describe, it, expect } from 'vitest';
import {
  assertStagedImportPayload,
  StagedImportValidationError,
  mapSourceToType,
  type StagedImportPayload,
} from '../contract';

function validPayload(over: Partial<StagedImportPayload> = {}): StagedImportPayload {
  return {
    contractVersion: 1,
    source: { name: 'wave', version: '1.0.0', exportedAt: '2026-05-19T12:00:00Z' },
    manifest: { files: [{ name: 'accounts.csv', sizeBytes: 100 }] },
    summary: { accounts: 0, contacts: 0, journalEntries: 0, journalLines: 0, warnings: [], errors: [] },
    staged: {},
    ...over,
  };
}

describe('assertStagedImportPayload', () => {
  it('accepts a minimal valid payload', () => {
    const result = assertStagedImportPayload(validPayload());
    expect(result.contractVersion).toBe(1);
    expect(result.source.name).toBe('wave');
  });

  it('rejects non-object', () => {
    expect(() => assertStagedImportPayload(null)).toThrow(StagedImportValidationError);
    expect(() => assertStagedImportPayload('foo')).toThrow(StagedImportValidationError);
  });

  it('rejects unsupported contractVersion', () => {
    const bad = { ...validPayload(), contractVersion: 2 as any };
    expect(() => assertStagedImportPayload(bad)).toThrow(/Unsupported contractVersion/);
  });

  it('rejects missing source.name', () => {
    const bad = { ...validPayload(), source: { name: '', version: '1', exportedAt: 'x' } as any };
    expect(() => assertStagedImportPayload(bad)).toThrow(/source.name/);
  });

  it('rejects missing manifest.files', () => {
    const bad = { ...validPayload(), manifest: {} as any };
    expect(() => assertStagedImportPayload(bad)).toThrow(/manifest.files/);
  });

  it('rejects summary counts that are not numbers', () => {
    const bad = { ...validPayload(), summary: { ...validPayload().summary, accounts: 'three' as any } };
    expect(() => assertStagedImportPayload(bad)).toThrow(/summary.accounts/);
  });

  it('rejects non-array staged.accounts', () => {
    const bad = { ...validPayload(), staged: { accounts: 'foo' as any } };
    expect(() => assertStagedImportPayload(bad)).toThrow(/staged.accounts/);
  });

  it('accepts staged with empty arrays', () => {
    const result = assertStagedImportPayload(validPayload({
      staged: { accounts: [], contacts: [], journalEntries: [] },
    }));
    expect(result.staged.accounts).toEqual([]);
  });

  it('rejects non-object row in staged.journalEntries', () => {
    const bad = validPayload({ staged: { journalEntries: ['a string' as any] } });
    expect(() => assertStagedImportPayload(bad)).toThrow(/journalEntries\[0\]/);
  });
});

describe('mapSourceToType', () => {
  it('maps wave', () => expect(mapSourceToType('wave')).toBe('wave'));
  it('maps WAVE (case-insensitive)', () => expect(mapSourceToType('WAVE')).toBe('wave'));
  it('maps qb / QBO / quickbooks', () => {
    expect(mapSourceToType('qb')).toBe('quickbooks');
    expect(mapSourceToType('qbo')).toBe('quickbooks');
    expect(mapSourceToType('quickbooks')).toBe('quickbooks');
  });
  it('maps or / orange_rails', () => {
    expect(mapSourceToType('or')).toBe('orange_rails');
    expect(mapSourceToType('orange_rails')).toBe('orange_rails');
  });
  it('returns null for unknown source', () => {
    expect(mapSourceToType('plaid')).toBeNull();
    expect(mapSourceToType('')).toBeNull();
  });
});
