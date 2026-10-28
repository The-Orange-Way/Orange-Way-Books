// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { POSTED_ENTRY_LOCKED_MESSAGE, saveErrorText } from '../save-error-text';

// Shape of the PostgREST error the database returns when a posted entry is edited.
const finalized = {
  code: '23000',
  details: 'Only workflow metadata may change after an entry is finalized.',
  hint: 'Use the reversal workflow to record an opposing entry.',
  message: 'Cannot modify finalized journal entry 00000000-0000-0000-0000-000000000000.',
};

describe('saveErrorText', () => {
  it('explains a refused edit of a posted entry in plain words', () => {
    expect(saveErrorText(finalized)).toBe(POSTED_ENTRY_LOCKED_MESSAGE);
  });

  it('uses the message of any other error object', () => {
    expect(saveErrorText({ code: '42501', message: 'permission denied' })).toBe(
      'permission denied',
    );
    expect(saveErrorText(new Error('boom'))).toBe('boom');
  });

  it('never returns [object Object]', () => {
    for (const e of [finalized, {}, { message: '' }, null, undefined, 42]) {
      expect(saveErrorText(e)).not.toContain('[object Object]');
    }
  });

  it('negative control: the old formatting prints [object Object] for the same error', () => {
    const old = (err: unknown) => (err instanceof Error ? err.message : String(err));
    expect(old(finalized)).toBe('[object Object]');
  });

  it('the transaction modal uses it for the save failure toast', () => {
    const modal = readFileSync(
      join(__dirname, '..', '..', '..', 'components', 'transactions', 'transaction-modal.tsx'),
      'utf8',
    );
    expect(modal).toContain("toast.error('Save failed: ' + saveErrorText(err));");
    expect(modal).not.toContain(
      "'Save failed: ' + (err instanceof Error ? err.message : String(err))",
    );
  });
});
