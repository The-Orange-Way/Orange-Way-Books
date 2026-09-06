/**
 * Tests for the sync-all orchestration pair.
 *
 * Pure functions, no vault, no network, no WebCrypto: this module never
 * touches key material, only which ids to send and what to say about what
 * came back.
 */
import { describe, it, expect } from 'vitest';
import { planSyncAll, reportSyncAll, type SyncAllResultEntry } from '@/lib/or/sync-all';

describe('planSyncAll', () => {
  it('routes every connection to syncable when is_stealth is absent', () => {
    const plan = planSyncAll([{ id: 'a' }, { id: 'b' }]);
    expect(plan.syncableIds).toEqual(['a', 'b']);
    expect(plan.skippedPrivateIds).toEqual([]);
  });

  it('routes is_stealth === true to skipped, never to syncable', () => {
    const plan = planSyncAll([
      { id: 'a', is_stealth: true },
      { id: 'b', is_stealth: false },
      { id: 'c' },
    ]);
    expect(plan.syncableIds).toEqual(['b', 'c']);
    expect(plan.skippedPrivateIds).toEqual(['a']);
  });

  it('returns two empty arrays for no connections', () => {
    const plan = planSyncAll([]);
    expect(plan.syncableIds).toEqual([]);
    expect(plan.skippedPrivateIds).toEqual([]);
  });
});

const entry = (connection_id: string, synced: number, error?: string): SyncAllResultEntry => ({
  connection_id,
  synced,
  ...(error ? { error } : {}),
});

describe('reportSyncAll: nothing syncable', () => {
  it('says there is nothing to sync when no ids were requested and none were skipped', () => {
    const report = reportSyncAll({
      requestedIds: [],
      returned: [],
      synced: 0,
      skippedPrivateCount: 0,
      stealthSyncEnabled: false,
    });
    expect(report.toasts).toEqual([{ level: 'info', message: 'There is nothing to sync.' }]);
    expect(report.missingIds).toEqual([]);
  });

  it('names the skipped private connections instead, when that is the whole reason', () => {
    const report = reportSyncAll({
      requestedIds: [],
      returned: [],
      synced: 0,
      skippedPrivateCount: 2,
      stealthSyncEnabled: true,
    });
    expect(report.toasts).toEqual([
      { level: 'info', message: '2 private connections can only be scanned one at a time. Use Sync on each one.' },
    ]);
  });
});

describe('reportSyncAll: missing ids are never folded into success', () => {
  it('reports "nothing was attempted" when every requested id came back absent', () => {
    const report = reportSyncAll({
      requestedIds: ['a', 'b'],
      returned: [],
      synced: 0,
      skippedPrivateCount: 0,
      stealthSyncEnabled: false,
    });
    expect(report.missingIds).toEqual(['a', 'b']);
    expect(report.toasts[0].level).toBe('warning');
    expect(report.toasts[0].message).toContain('nothing was attempted for 2 connections');
  });

  it('reports a partial miss alongside a real success, never silencing either', () => {
    const report = reportSyncAll({
      requestedIds: ['a', 'b'],
      returned: [entry('a', 3)],
      synced: 3,
      skippedPrivateCount: 0,
      stealthSyncEnabled: false,
    });
    expect(report.missingIds).toEqual(['b']);
    expect(report.toasts).toHaveLength(2);
    expect(report.toasts[0]).toEqual({
      level: 'success',
      message: 'Sync all: 3 transactions across 1 wallet.',
    });
    expect(report.toasts[1].message).toContain('1 connection was not attempted');
  });
});

describe('reportSyncAll: errors', () => {
  it('reports an all-error result as error level with the first message', () => {
    const report = reportSyncAll({
      requestedIds: ['a', 'b'],
      returned: [entry('a', 0, 'timeout'), entry('b', 0, 'timeout')],
      synced: 0,
      skippedPrivateCount: 0,
      stealthSyncEnabled: false,
      firstErrorMessage: 'timeout',
    });
    expect(report.toasts[0]).toEqual({
      level: 'error',
      message: "2 connections couldn't sync: timeout (and 1 other)",
    });
  });

  it('reports a mix of success and error as warning, not success', () => {
    const report = reportSyncAll({
      requestedIds: ['a', 'b'],
      returned: [entry('a', 5), entry('b', 0, 'rate limited')],
      synced: 5,
      skippedPrivateCount: 0,
      stealthSyncEnabled: false,
      firstErrorMessage: 'rate limited',
    });
    expect(report.toasts[0]).toEqual({
      level: 'warning',
      message: 'Synced 5 across 1 wallet; 1 had trouble: rate limited',
    });
  });
});

describe('reportSyncAll: success and skip together', () => {
  it('reports a real success plus a skipped-private note as two toasts', () => {
    const report = reportSyncAll({
      requestedIds: ['a'],
      returned: [entry('a', 2)],
      synced: 2,
      skippedPrivateCount: 1,
      stealthSyncEnabled: true,
    });
    expect(report.toasts).toEqual([
      { level: 'success', message: 'Sync all: 2 transactions across 1 wallet.' },
      { level: 'info', message: '1 private connection was skipped. Use Sync on each one to scan it.' },
    ]);
  });

  it('reports no-new-transactions when everything ran with zero synced and no errors', () => {
    const report = reportSyncAll({
      requestedIds: ['a'],
      returned: [entry('a', 0)],
      synced: 0,
      skippedPrivateCount: 0,
      stealthSyncEnabled: false,
    });
    expect(report.toasts).toEqual([
      { level: 'info', message: 'Sync all: no new transactions across any wallet.' },
    ]);
  });
});
