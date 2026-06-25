import { describe, it, expect } from 'vitest';
import {
  STAGED_IMPORT_CONTRACT_VERSION,
  assertStagedImportPayload,
  stagedRowsToPreview,
} from './contract';

const MINIMAL = {
  contractVersion: STAGED_IMPORT_CONTRACT_VERSION,
  source: { name: 'wave', version: '0.1.0', exportedAt: '2026-05-19T15:00:00Z' },
  manifest: { files: [] },
  summary: {
    accounts: 0,
    contacts: 0,
    journalEntries: 0,
    journalLines: 0,
    warnings: [],
    errors: [],
  },
  staged: {},
};

describe('Orange Rails contract (OWB side)', () => {
  it('accepts a minimal valid payload', () => {
    expect(() => assertStagedImportPayload(MINIMAL)).not.toThrow();
  });

  it('rejects wrong contractVersion', () => {
    expect(() => assertStagedImportPayload({ ...MINIMAL, contractVersion: 99 })).toThrow(
      /contractVersion/,
    );
  });

  it('rejects missing source', () => {
    const bad = { ...MINIMAL, source: undefined };
    expect(() => assertStagedImportPayload(bad)).toThrow(/source/);
  });

  it('rejects staged.accounts that is not an array', () => {
    const bad = { ...MINIMAL, staged: { accounts: 'oops' } };
    expect(() => assertStagedImportPayload(bad)).toThrow(/array/);
  });

  it('rejects null / non-object input', () => {
    expect(() => assertStagedImportPayload(null)).toThrow();
    expect(() => assertStagedImportPayload(42)).toThrow();
  });

  it('stagedRowsToPreview preserves row data exactly and adds rowIndex', () => {
    const rows = [
      { name: 'Cash', code: '1010' },
      { name: 'Sales', code: '4000' },
    ];
    const preview = stagedRowsToPreview(rows);
    expect(preview).toEqual([
      { rowIndex: 0, data: rows[0] },
      { rowIndex: 1, data: rows[1] },
    ]);
  });
});
