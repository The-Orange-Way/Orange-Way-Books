import { describe, it, expect } from 'vitest';
import {
  applyDefaultMappings,
  payloadHasEmptyAccountRows,
  payloadHasEmptyContactRows,
} from './apply-defaults';
import { STAGED_IMPORT_CONTRACT_VERSION } from './contract';
import type { StagedImportPayload, V3StagedRow } from './contract';

function payload(rows: V3StagedRow[]): StagedImportPayload {
  return {
    contractVersion: STAGED_IMPORT_CONTRACT_VERSION,
    source: { name: 'strike', version: '0.1.0', exportedAt: '2026-05-21T00:00:00Z' },
    manifest: { files: [] },
    summary: {
      accounts: 0,
      contacts: 0,
      journalEntries: rows.length,
      journalLines: rows.length,
      warnings: [],
      errors: [],
    },
    staged: { journalEntries: rows },
  };
}

const ACCT = { code: '1010', name: 'Cash on Hand' };
const CONTACT = { code: 'c-1', name: 'Strike Counterparty' };

describe('applyDefaultMappings', () => {
  it('returns payload unchanged when no defaults set', () => {
    const p = payload([{ account_code: '', account_name: '', contact_name: '' }]);
    const out = applyDefaultMappings(p, {});
    expect(out).toBe(p);
  });

  it('fills only Account fields when only default account is set', () => {
    const p = payload([{ account_code: '', account_name: '', contact_name: '' }]);
    const out = applyDefaultMappings(p, { defaultAccount: ACCT });
    expect(out.staged.journalEntries?.[0]).toEqual({
      account_code: '1010',
      account_name: 'Cash on Hand',
      contact_name: '',
    });
  });

  it('fills both fields when both defaults are set', () => {
    const p = payload([{ account_code: '', account_name: '', contact_name: '' }]);
    const out = applyDefaultMappings(p, { defaultAccount: ACCT, defaultContact: CONTACT });
    expect(out.staged.journalEntries?.[0]).toEqual({
      account_code: '1010',
      account_name: 'Cash on Hand',
      contact_name: 'Strike Counterparty',
    });
  });

  it('preserves explicit account values (never overwrites)', () => {
    const p = payload([{ account_code: '4000', account_name: 'Sales', contact_name: 'ACME Corp' }]);
    const out = applyDefaultMappings(p, { defaultAccount: ACCT, defaultContact: CONTACT });
    expect(out.staged.journalEntries?.[0]).toEqual({
      account_code: '4000',
      account_name: 'Sales',
      contact_name: 'ACME Corp',
    });
  });

  it('treats whitespace-only Account/Contact as empty', () => {
    const p = payload([{ account_code: '   ', account_name: '', contact_name: '  ' }]);
    const out = applyDefaultMappings(p, { defaultAccount: ACCT, defaultContact: CONTACT });
    expect(out.staged.journalEntries?.[0].account_code).toBe('1010');
    expect(out.staged.journalEntries?.[0].contact_name).toBe('Strike Counterparty');
  });

  it('only fills Account on the rows missing it (mixed payload)', () => {
    const p = payload([
      { account_code: '', account_name: '', contact_name: '' },
      { account_code: '4000', account_name: 'Sales', contact_name: '' },
    ]);
    const out = applyDefaultMappings(p, { defaultAccount: ACCT });
    expect(out.staged.journalEntries?.[0].account_code).toBe('1010');
    expect(out.staged.journalEntries?.[1].account_code).toBe('4000');
  });

  it('does not mutate the original payload', () => {
    const rows: V3StagedRow[] = [{ account_code: '', account_name: '', contact_name: '' }];
    const p = payload(rows);
    applyDefaultMappings(p, { defaultAccount: ACCT });
    expect(rows[0].account_code).toBe('');
    expect(p.staged.journalEntries?.[0].account_code).toBe('');
  });

  it('returns empty section unchanged (no crash)', () => {
    const p: StagedImportPayload = {
      contractVersion: STAGED_IMPORT_CONTRACT_VERSION,
      source: { name: 'strike', version: '0.1.0', exportedAt: '2026-05-21T00:00:00Z' },
      manifest: { files: [] },
      summary: {
        accounts: 0,
        contacts: 0,
        journalEntries: 0,
        journalLines: 0,
        warnings: [],
        errors: [],
      },
      staged: { journalEntries: [] },
    };
    const out = applyDefaultMappings(p, { defaultAccount: ACCT, defaultContact: CONTACT });
    expect(out.staged.journalEntries).toEqual([]);
  });

  it('handles missing journalEntries section (no crash)', () => {
    const p: StagedImportPayload = {
      contractVersion: STAGED_IMPORT_CONTRACT_VERSION,
      source: { name: 'strike', version: '0.1.0', exportedAt: '2026-05-21T00:00:00Z' },
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
    const out = applyDefaultMappings(p, { defaultAccount: ACCT });
    expect(out.staged.journalEntries).toBeUndefined();
  });
});

describe('payloadHasEmptyAccountRows / payloadHasEmptyContactRows', () => {
  it('detects empty Account rows', () => {
    const p = payload([{ account_code: '', account_name: '', contact_name: 'X' }]);
    expect(payloadHasEmptyAccountRows(p)).toBe(true);
    expect(payloadHasEmptyContactRows(p)).toBe(false);
  });

  it('detects empty Contact rows', () => {
    const p = payload([{ account_code: '1010', account_name: 'Cash', contact_name: '' }]);
    expect(payloadHasEmptyAccountRows(p)).toBe(false);
    expect(payloadHasEmptyContactRows(p)).toBe(true);
  });

  it('returns false when everything is populated', () => {
    const p = payload([{ account_code: '1010', account_name: 'Cash', contact_name: 'ACME' }]);
    expect(payloadHasEmptyAccountRows(p)).toBe(false);
    expect(payloadHasEmptyContactRows(p)).toBe(false);
  });
});
