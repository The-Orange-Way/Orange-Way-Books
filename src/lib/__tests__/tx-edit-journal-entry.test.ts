// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8');

/** The object passed as the modal's editingTx prop. */
function editingTxProp(code: string): string {
  const start = code.indexOf('editingTx={');
  if (start === -1) throw new Error('editingTx prop not found');
  const end = code.indexOf('orgId={', start);
  return code.slice(start, end === -1 ? undefined : end);
}
const passesJournalEntry = (block: string) =>
  /journal_entry_id:\s*editingTx\.journal_entry_id/.test(block);

describe('editing a transaction keeps its journal entry', () => {
  it('Transactions page passes journal_entry_id to the edit modal', () => {
    expect(passesJournalEntry(editingTxProp(src('pages/Transactions.tsx')))).toBe(true);
  });

  it('the modal still decides split loading and update-vs-insert on journal_entry_id', () => {
    const modal = src('components/transactions/transaction-modal.tsx');
    expect(modal).toContain('if (!editingTx.journal_entry_id && !isTransfer) return;');
    // Split save and transfer save each update the existing entry only when the id is present.
    expect(modal.match(/if \(editingTx && editingTx\.journal_entry_id\) \{/g)).toHaveLength(2);
  });

  it('negative control: the old prop without journal_entry_id is caught', () => {
    const old = `editingTx={
            editingTx
              ? {
                  id: editingTx.id,
                  linked_transfer_id: editingTx.linked_transfer_id ?? null,
                  account_id: editingTx.account_id ?? null,
                }
              : null
          }
          orgId={orgId}`;
    expect(passesJournalEntry(editingTxProp(old))).toBe(false);
  });
});
