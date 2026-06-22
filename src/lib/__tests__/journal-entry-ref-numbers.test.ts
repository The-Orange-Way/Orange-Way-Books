/**
 * Unit tests for journal-entry-ref-numbers.
 *
 * Pure-function tests only. The Supabase RPC paths and the
 * VaultContext.blindIndex integration are exercised by the Playwright
 * live test harness when that lands.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildImportRefNumber,
  parseImportRefNumber,
  buildOpeningBalanceRefNumber,
  buildImportHmacInput,
  buildOpeningBalanceHmacInput,
  computeImportExternalIdHmac,
  computeOpeningBalanceHmac,
} from '../journal-entry-ref-numbers';

describe('buildImportRefNumber', () => {
  it('builds WAVE-<id>', () => {
    expect(buildImportRefNumber('wave', '1402433495770403519')).toBe('WAVE-1402433495770403519');
  });
  it('builds QB-<id>', () => {
    expect(buildImportRefNumber('quickbooks', 'abc-123')).toBe('QB-abc-123');
  });
  it('builds OR-<id>', () => {
    expect(buildImportRefNumber('orange_rails', 'x7k2m9')).toBe('OR-x7k2m9');
  });
  it('throws on empty externalId', () => {
    expect(() => buildImportRefNumber('wave', '')).toThrow(/externalId required/);
  });
});

describe('buildOpeningBalanceRefNumber', () => {
  it('produces OPEN-BAL-<date>', () => {
    expect(buildOpeningBalanceRefNumber('2024-01-01')).toBe('OPEN-BAL-2024-01-01');
  });
  it('trims time component', () => {
    expect(buildOpeningBalanceRefNumber('2024-01-01T00:00:00Z')).toBe('OPEN-BAL-2024-01-01');
  });
});

describe('parseImportRefNumber', () => {
  it('parses WAVE prefix', () => {
    expect(parseImportRefNumber('WAVE-1402')).toEqual({ source: 'wave', externalId: '1402' });
  });
  it('parses QB prefix', () => {
    expect(parseImportRefNumber('QB-abc-123')).toEqual({
      source: 'quickbooks',
      externalId: 'abc-123',
    });
  });
  it('parses OR prefix', () => {
    expect(parseImportRefNumber('OR-x7k2m9')).toEqual({
      source: 'orange_rails',
      externalId: 'x7k2m9',
    });
  });
  it('returns null for internal ref numbers', () => {
    expect(parseImportRefNumber('JE-2025-0042')).toBeNull();
  });
  it('returns null for opening-balance ref numbers', () => {
    // Opening balance has its own dedicated path; not an "import" by this function.
    expect(parseImportRefNumber('OPEN-BAL-2024-01-01')).toBeNull();
  });
  it('handles external IDs with embedded hyphens', () => {
    expect(parseImportRefNumber('QB-abc-123-xyz')).toEqual({
      source: 'quickbooks',
      externalId: 'abc-123-xyz',
    });
  });
});

describe('round-trip build → parse', () => {
  it.each([
    ['wave', '1402433495770403519'],
    ['quickbooks', 'abc-123'],
    ['orange_rails', 'x7k2m9'],
    ['wave', 'a'],
  ] as const)('%s/%s round-trips', (source, externalId) => {
    expect(parseImportRefNumber(buildImportRefNumber(source, externalId))).toEqual({
      source,
      externalId,
    });
  });
});

describe('buildImportHmacInput (the HMAC input string)', () => {
  it('lowercases the source prefix', () => {
    expect(buildImportHmacInput('wave', '1402')).toBe('wave-1402');
  });
  it('lowercases the external id', () => {
    expect(buildImportHmacInput('quickbooks', 'AbC-123')).toBe('quickbooks-abc-123');
  });
  it('throws on empty external id', () => {
    expect(() => buildImportHmacInput('wave', '')).toThrow(/externalId required/);
  });
  it('produces a different input than the ref_number label', () => {
    // Belt-and-suspenders: parsing the HMAC input as a ref_number would be wrong.
    // We use the lowercase source word as the prefix in the HMAC input, but the
    // ref_number uses uppercase WAVE/QB/OR prefixes. They must not collide.
    const ref = buildImportRefNumber('wave', '1402');
    const hmac = buildImportHmacInput('wave', '1402');
    expect(ref).not.toBe(hmac);
  });
});

describe('buildOpeningBalanceHmacInput', () => {
  it('produces a stable lowercase input', () => {
    expect(buildOpeningBalanceHmacInput('2024-01-01')).toBe('open-bal-2024-01-01');
  });
  it('trims time component', () => {
    expect(buildOpeningBalanceHmacInput('2024-01-01T12:00:00Z')).toBe('open-bal-2024-01-01');
  });
});

describe('computeImportExternalIdHmac', () => {
  it('forwards the canonical input to the blindIndex callback', async () => {
    const stub = vi.fn(async (v: string | null | undefined) => `HMAC(${v})`);
    const result = await computeImportExternalIdHmac(stub, 'wave', '1402');
    expect(stub).toHaveBeenCalledWith('wave-1402');
    expect(result).toBe('HMAC(wave-1402)');
  });

  it('passes through null when the blindIndex returns null (locked vault)', async () => {
    const stub = vi.fn(async () => null);
    const result = await computeImportExternalIdHmac(stub, 'wave', '1402');
    expect(result).toBeNull();
  });
});

describe('computeOpeningBalanceHmac', () => {
  it('forwards the canonical opening-balance input', async () => {
    const stub = vi.fn(async (v: string | null | undefined) => `HMAC(${v})`);
    const result = await computeOpeningBalanceHmac(stub, '2024-01-01');
    expect(stub).toHaveBeenCalledWith('open-bal-2024-01-01');
    expect(result).toBe('HMAC(open-bal-2024-01-01)');
  });
});
