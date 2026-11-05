// @vitest-environment jsdom
import type { SupabaseClient } from '@supabase/supabase-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  backfillDualAmounts,
  loadBackfillProgress,
  type BackfillCallbacks,
} from '../backfill-dual-amounts';

vi.mock('@/lib/supabase', () => ({ supabase: {} }));

type Page = { data: unknown[] | null; error: { message: string } | null };

function client(pages: Page[]) {
  const gts: unknown[] = [];
  let n = 0;
  const c = {
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        limit: () => q,
        gt: (_col: string, v: unknown) => (gts.push(v), q),
        then: (resolve: (v: Page) => void) => resolve(pages[n++] ?? { data: [], error: null }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { c, gts };
}

const line = (entry: string, status = 'POSTED') => ({
  journal_entry_id: entry,
  journal_entries: { status, org_id: 'org-1' },
});

const enc = async (s: string) => `C_${s}`;
const dec = async (s: string) => s.replace(/^C_/, '');

function callbacks(signal?: AbortSignal) {
  const done: unknown[] = [];
  const cb: BackfillCallbacks = { onProgress: () => {}, onDone: (p) => done.push(p), signal };
  return { cb, done };
}

beforeEach(() => localStorage.clear());

describe('backfillDualAmounts', () => {
  it('fills each posted entry once, through the edit path', async () => {
    const { c } = client([{ data: [line('je-1'), line('je-1'), line('je-2')], error: null }]);
    const fillPosted = vi.fn(async (_c: unknown, id: string) =>
      id === 'je-1'
        ? { filled: 2, stillPending: 0, version: 1 }
        : { filled: 0, stillPending: 1, version: null },
    );
    const { cb, done } = callbacks();
    const p = await backfillDualAmounts('org-1', enc, dec, cb, { client: c, fillPosted });
    expect(fillPosted.mock.calls.map((a) => a[1])).toEqual(['je-1', 'je-2']);
    expect(p).toMatchObject({ processed: 3, resolved: 2, pending: 1, failed: 0 });
    expect(done).toHaveLength(1);
    expect(loadBackfillProgress('org-1').processed).toBe(0);
  });

  it('leaves drafts and voided entries alone', async () => {
    const { c } = client([{ data: [line('je-1', 'DRAFT'), line('je-2', 'VOID')], error: null }]);
    const fillPosted = vi.fn();
    const { cb } = callbacks();
    const p = await backfillDualAmounts('org-1', enc, dec, cb, { client: c, fillPosted });
    expect(fillPosted).not.toHaveBeenCalled();
    expect(p).toMatchObject({ processed: 2, resolved: 0, pending: 2, failed: 0 });
  });

  it('counts a refused entry as failed and carries on', async () => {
    const { c } = client([{ data: [line('je-1'), line('je-2')], error: null }]);
    const fillPosted = vi.fn(async (_c: unknown, id: string) => {
      if (id === 'je-1') throw new Error('The month is closed.');
      return { filled: 1, stillPending: 0, version: 1 };
    });
    const { cb } = callbacks();
    const p = await backfillDualAmounts('org-1', enc, dec, cb, { client: c, fillPosted });
    expect(p).toMatchObject({ processed: 2, resolved: 1, failed: 1 });
  });

  it('counts a waiting line that is neither filled nor pending as failed', async () => {
    const { c } = client([{ data: [line('je-1'), line('je-1')], error: null }]);
    const fillPosted = vi.fn(async () => ({ filled: 1, stillPending: 0, version: 1 }));
    const { cb } = callbacks();
    const p = await backfillDualAmounts('org-1', enc, dec, cb, { client: c, fillPosted });
    expect(p).toMatchObject({ resolved: 1, failed: 1 });
  });

  it('does not report a run as done when the lines cannot be read', async () => {
    const { c } = client([{ data: null, error: { message: 'permission denied' } }]);
    const { cb, done } = callbacks();
    await expect(
      backfillDualAmounts('org-1', enc, dec, cb, { client: c, fillPosted: vi.fn() }),
    ).rejects.toThrow('permission denied');
    expect(done).toHaveLength(0);
  });

  it('after Stop, saves its place and does not report done; the next run resumes there', async () => {
    const ac = new AbortController();
    const { c } = client([{ data: [line('je-1'), line('je-2')], error: null }]);
    const fillPosted = vi.fn(async () => {
      ac.abort();
      return { filled: 1, stillPending: 0, version: 1 };
    });
    const { cb, done } = callbacks(ac.signal);
    await backfillDualAmounts('org-1', enc, dec, cb, { client: c, fillPosted });
    expect(done).toHaveLength(0);
    expect(fillPosted).toHaveBeenCalledTimes(1);
    expect(loadBackfillProgress('org-1').lastCursor).toBe('je-1');

    const next = client([{ data: [line('je-2')], error: null }]);
    await backfillDualAmounts('org-1', enc, dec, callbacks().cb, {
      client: next.c,
      fillPosted: vi.fn(async () => ({ filled: 1, stillPending: 0, version: 1 })),
    });
    expect(next.gts).toEqual(['je-1']);
  });

  it('keeps progress per organization', async () => {
    const ac = new AbortController();
    const { c } = client([{ data: [line('je-1'), line('je-2')], error: null }]);
    const fillPosted = vi.fn(async () => {
      ac.abort();
      return { filled: 1, stillPending: 0, version: 1 };
    });
    await backfillDualAmounts('org-1', enc, dec, callbacks(ac.signal).cb, {
      client: c,
      fillPosted,
    });
    expect(loadBackfillProgress('org-1').lastCursor).toBe('je-1');
    expect(loadBackfillProgress('org-2').lastCursor).toBeNull();
  });
});
