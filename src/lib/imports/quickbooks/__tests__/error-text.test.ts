// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { describeImportError } from '../error-text';

describe('describeImportError', () => {
  it('reads the message of a Supabase error object', () => {
    const err = {
      code: '23514',
      details: null,
      hint: null,
      message: 'new row for relation "journal_entries" violates check constraint',
    };
    expect(describeImportError(err)).toBe(
      'new row for relation "journal_entries" violates check constraint (23514)',
    );
  });

  it('never prints [object Object]', () => {
    expect(describeImportError({ details: 'x' })).not.toContain('[object Object]');
    expect(describeImportError({ message: '' })).not.toContain('[object Object]');
  });

  it('keeps Error messages and plain values as before', () => {
    expect(describeImportError(new Error('boom'))).toBe('boom');
    expect(describeImportError('plain')).toBe('plain');
  });
});
