// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const page = readFileSync(join(__dirname, '..', '..', 'pages', 'Transactions.tsx'), 'utf8');

/** Body of openEdit, the only path that hands a row to the edit modal. */
function openEditBody(code: string): string {
  const start = code.indexOf('const openEdit = (tx: TxRow) => {');
  if (start === -1) throw new Error('openEdit not found');
  return code.slice(start, code.indexOf('setEditingTx(tx);', start));
}
const refusesVoid = (body: string) =>
  /if \(tx\.status === 'VOID'\) \{\s*toast\.error\(VOID_NOT_EDITABLE_MESSAGE\);\s*return;/.test(
    body,
  );

describe('a voided transaction cannot be edited', () => {
  it('openEdit refuses a VOID row before the modal gets it', () => {
    expect(refusesVoid(openEditBody(page))).toBe(true);
  });

  it('every row edit path goes through openEdit', () => {
    expect(page.match(/setEditingTx\(tx\)/g)).toHaveLength(1);
  });

  it('both Edit buttons are disabled for a VOID row', () => {
    const buttons = page.split('data-testid="tx-edit-button"').slice(0, -1);
    expect(buttons).toHaveLength(2);
    for (const before of buttons) {
      expect(before.slice(-300)).toContain("disabled={tx.status === 'VOID'}");
    }
  });

  it('negative control: the old openEdit is caught', () => {
    const old = `const openEdit = (tx: TxRow) => {
    if (tx.cleared_status === 'RECONCILED') {
      setLockedDialogOpen(true);
      return;
    }
    setEditingTx(tx);`;
    expect(refusesVoid(openEditBody(old))).toBe(false);
  });
});
