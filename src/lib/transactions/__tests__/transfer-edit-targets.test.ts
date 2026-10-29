// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  type TransferEditDb,
  saveTransferEditLegs,
  transferEditTargets,
} from '../transfer-edit-targets';

type Row = {
  id: string;
  account_id: string;
  linked_transfer_id: string | null;
  signed: boolean;
  [k: string]: unknown;
};

// An in-memory transactions table. Like the database trigger, it refuses any write that leaves a
// row without a signature once the org signs, and it can be told to fail one call.
function fakeDb(rows: Row[], failOn?: { op: 'update' | 'insert'; id?: string }) {
  const table = new Map(rows.map((r) => [r.id, { ...r }]));
  const calls: string[] = [];
  let n = 0;
  let failed = false;
  const check = (r: Row) => {
    if (!r.signed) throw new Error('Mutation requires an Org Signing Key signature.');
  };
  const db: TransferEditDb = {
    async findLinkedTo(id) {
      const hits = [...table.values()].filter((r) => r.linked_transfer_id === id);
      if (hits.length > 1) throw new Error('multiple rows');
      return hits[0]?.id ?? null;
    },
    async update(id, values) {
      calls.push(`update ${id}`);
      if (!failed && failOn?.op === 'update' && failOn.id === id) {
        failed = true;
        throw new Error('network');
      }
      const next = { ...table.get(id)!, ...values, signed: values.sig === true } as Row;
      check(next);
      table.set(id, next);
    },
    async insert(values) {
      calls.push('insert');
      if (!failed && failOn?.op === 'insert') {
        failed = true;
        throw new Error('network');
      }
      const id = `new${++n}`;
      const row = { id, ...values, signed: values.sig === true } as Row;
      check(row);
      table.set(id, row);
      return id;
    },
  };
  return { db, table, calls };
}

// The source leg goes to the CAD wallet, the destination leg to the USD wallet.
const params = (direction: 'IN' | 'OUT', editedId: string, linkedId: string | null) => ({
  direction,
  editedId,
  linkedId,
  orgId: 'org',
  date: '2026-10-29',
  journalEntryId: 'je',
  src: { account_id: 'CAD', enc: { amount: -20 }, sig: { sig: true } },
  dest: { account_id: 'USD', enc: { amount: 14.6 }, sig: { sig: true } },
});
const pair = (): Row[] => [
  { id: 'S', account_id: 'CAD', linked_transfer_id: 'R', signed: true },
  { id: 'R', account_id: 'USD', linked_transfer_id: 'S', signed: true },
];
const wallets = (t: Map<string, Row>) =>
  Object.fromEntries([...t.values()].map((r) => [r.id, r.account_id]));

describe('saving an edited transfer', () => {
  it('edited from the sending side: S stays on CAD, R on USD', async () => {
    const { db, table } = fakeDb(pair());
    expect(await saveTransferEditLegs(db, params('OUT', 'S', 'R'))).toEqual({
      srcId: 'S',
      destId: 'R',
    });
    expect(wallets(table)).toEqual({ S: 'CAD', R: 'USD' });
  });

  it('edited from the receiving side: R stays on USD, S on CAD, links both ways', async () => {
    const { db, table } = fakeDb(pair());
    expect(await saveTransferEditLegs(db, params('IN', 'R', 'S'))).toEqual({
      srcId: 'S',
      destId: 'R',
    });
    expect(wallets(table)).toEqual({ S: 'CAD', R: 'USD' });
    expect([table.get('S')!.linked_transfer_id, table.get('R')!.linked_transfer_id]).toEqual([
      'R',
      'S',
    ]);
  });

  it('negative control: the old rule (edited row is always the source) swaps the wallets', async () => {
    const { db, table } = fakeDb(pair());
    const p = params('IN', 'R', 'S');
    await db.update('R', { account_id: p.src.account_id, ...p.src.sig });
    await db.update('S', { account_id: p.dest.account_id, ...p.dest.sig });
    expect(wallets(table)).toEqual({ S: 'USD', R: 'CAD' });
  });

  it('an unsigned receiving row with no partner gets one signed update carrying its link', async () => {
    const { db, table, calls } = fakeDb([
      { id: 'R', account_id: 'USD', linked_transfer_id: null, signed: false },
    ]);
    const out = await saveTransferEditLegs(db, params('IN', 'R', null));
    expect(calls).toEqual(['insert', 'update R']);
    expect(out).toEqual({ srcId: 'new1', destId: 'R' });
    expect(table.get('R')).toMatchObject({ linked_transfer_id: 'new1', signed: true });
    expect(table.get('new1')).toMatchObject({ account_id: 'CAD', linked_transfer_id: 'R' });
  });

  it('negative control: a link-only update of an unsigned row is refused', async () => {
    const { db } = fakeDb([
      { id: 'R', account_id: 'USD', linked_transfer_id: null, signed: false },
    ]);
    await expect(db.update('R', { linked_transfer_id: 'x' })).rejects.toThrow('Signing Key');
  });

  it('a save that failed after inserting the new leg is repaired by the next save', async () => {
    const { db, table } = fakeDb(
      [{ id: 'R', account_id: 'USD', linked_transfer_id: null, signed: true }],
      { op: 'update', id: 'R' },
    );
    await expect(saveTransferEditLegs(db, params('IN', 'R', null))).rejects.toThrow('network');
    expect(table.get('R')!.linked_transfer_id).toBeNull();
    await saveTransferEditLegs(db, params('IN', 'R', null));
    expect(table.size).toBe(2);
    expect(table.get('R')!.linked_transfer_id).toBe('new1');
    expect(table.get('new1')!.linked_transfer_id).toBe('R');
  });

  it('a lookup error stops the save instead of inserting another leg', async () => {
    const { db, calls } = fakeDb([
      { id: 'R', account_id: 'USD', linked_transfer_id: null, signed: true },
      { id: 'A', account_id: 'CAD', linked_transfer_id: 'R', signed: true },
      { id: 'B', account_id: 'CAD', linked_transfer_id: 'R', signed: true },
    ]);
    await expect(saveTransferEditLegs(db, params('IN', 'R', null))).rejects.toThrow('multiple');
    expect(calls).toEqual([]);
  });

  it('flipping the direction in the modal keeps the edited row on the left wallet', () => {
    expect(transferEditTargets('OUT', 'R', 'S')).toEqual({ srcId: 'R', destId: 'S' });
    expect(transferEditTargets('IN', 'R', 'S')).toEqual({ srcId: 'S', destId: 'R' });
  });
});
