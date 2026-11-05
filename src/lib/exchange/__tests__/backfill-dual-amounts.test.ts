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

// Pages of the search, plus the number of waiting lines on each entry (the
// whole entry, whatever page its lines fall on). Unlisted entries count the
// rows the pages hold for them.
function client(pages: Page[], counts: Record<string, number> = {}) {
  const gts: unknown[] = [];
  const ors: unknown[] = [];
  let n = 0;
  const onPages = (id: string) =>
    pages
      .flatMap((pg) => pg.data ?? [])
      .filter((r) => (r as { journal_entry_id: string }).journal_entry_id === id).length;
  const c = {
    from: () => {
      let head = false;
      let entry = '';
      const q = {
        select: (_cols: string, opts?: { head?: boolean }) => ((head = !!opts?.head), q),
        eq: (col: string, v: string) => (col === 'journal_entry_id' && (entry = v), q),
        or: (f: string) => (head ? null : ors.push(f), q),
        order: () => q,
        limit: () => q,
        gt: (_col: string, v: unknown) => (gts.push(v), q),
        then: (resolve: (v: unknown) => void) =>
          head
            ? resolve({ count: counts[entry] ?? onPages(entry), error: null })
            : resolve(pages[n++] ?? { data: [], error: null }),
      };
      return q;
    },
  } as unknown as SupabaseClient;
  return { c, gts, ors };
}

const res = (waiting: number, filled: number, stillPending: number) => ({
  waiting,
  filled,
  stillPending,
  version: filled ? 1 : null,
});

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
      id === 'je-1' ? res(2, 2, 0) : res(1, 0, 1),
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
      return res(1, 1, 0);
    });
    const { cb } = callbacks();
    const p = await backfillDualAmounts('org-1', enc, dec, cb, { client: c, fillPosted });
    expect(p).toMatchObject({ processed: 2, resolved: 1, failed: 1 });
  });

  it('counts a waiting line that is neither filled nor pending as failed', async () => {
    const { c } = client([{ data: [line('je-1'), line('je-1')], error: null }]);
    const fillPosted = vi.fn(async () => res(2, 1, 0));
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
      return res(1, 1, 0);
    });
    const { cb, done } = callbacks(ac.signal);
    await backfillDualAmounts('org-1', enc, dec, cb, { client: c, fillPosted });
    expect(done).toHaveLength(0);
    expect(fillPosted).toHaveBeenCalledTimes(1);
    expect(loadBackfillProgress('org-1').lastCursor).toBe('je-1');

    const next = client([{ data: [line('je-2')], error: null }]);
    await backfillDualAmounts('org-1', enc, dec, callbacks().cb, {
      client: next.c,
      fillPosted: vi.fn(async () => res(1, 1, 0)),
    });
    expect(next.gts).toEqual(['je-1']);
  });

  it('keeps progress per organization', async () => {
    const ac = new AbortController();
    const { c } = client([{ data: [line('je-1'), line('je-2')], error: null }]);
    const fillPosted = vi.fn(async () => {
      ac.abort();
      return res(1, 1, 0);
    });
    await backfillDualAmounts('org-1', enc, dec, callbacks(ac.signal).cb, {
      client: c,
      fillPosted,
    });
    expect(loadBackfillProgress('org-1').lastCursor).toBe('je-1');
    expect(loadBackfillProgress('org-2').lastCursor).toBeNull();
  });

  it('finds lines waiting on either flag', async () => {
    const { c, ors } = client([{ data: [line('je-1')], error: null }]);
    await backfillDualAmounts('org-1', enc, dec, callbacks().cb, {
      client: c,
      fillPosted: vi.fn(async () => res(1, 1, 0)),
    });
    expect(ors[0]).toBe('rate_pending.eq.true,dual_amounts_backfilled.eq.false');
  });

  it('counts the whole entry when its lines run past the end of a page', async () => {
    const full = Array.from({ length: 500 }, () => line('je-1'));
    const { c } = client([{ data: full, error: null }], { 'je-1': 502 });
    const p = await backfillDualAmounts('org-1', enc, dec, callbacks().cb, {
      client: c,
      fillPosted: vi.fn(async () => res(502, 502, 0)),
    });
    expect(p).toMatchObject({ processed: 502, resolved: 502, pending: 0, failed: 0 });
  });

  it('counts every waiting line of a draft, not only those on the page', async () => {
    const { c } = client([{ data: [line('je-1', 'DRAFT')], error: null }], { 'je-1': 3 });
    const p = await backfillDualAmounts('org-1', enc, dec, callbacks().cb, {
      client: c,
      fillPosted: vi.fn(),
    });
    expect(p).toMatchObject({ processed: 3, pending: 3 });
  });

  it('counts every waiting line of a refused entry as failed', async () => {
    const { c } = client([{ data: [line('je-1')], error: null }], { 'je-1': 4 });
    const p = await backfillDualAmounts('org-1', enc, dec, callbacks().cb, {
      client: c,
      fillPosted: vi.fn(async () => {
        throw new Error('The entry was changed while its rates were being looked up.');
      }),
    });
    expect(p).toMatchObject({ processed: 4, failed: 4 });
  });
});
