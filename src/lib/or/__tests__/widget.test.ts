/**
 * openOrConnect: what Books sends when a customer connects a wallet, and how
 * the promise settles.
 *
 * Read the commit message for why each case is here. The short version: every
 * property asserted below fails SILENTLY if it regresses, so none of them are
 * covered by the feature appearing to work.
 *
 * The popup is stubbed and the proxy is a fetch mock. The real cross origin
 * postMessage handshake belongs to the widget's own test suite; what belongs
 * here is what Books puts in the URL, what it puts in the fragment, and
 * whether the returned promise always reaches a terminal state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  refreshSession: vi.fn(),
}));

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: mocks.getSession, refreshSession: mocks.refreshSession },
  },
  SUPABASE_URL: 'https://books.local',
  SUPABASE_PUBLISHABLE_KEY: 'pub-key',
}));

const WIDGET_BASE = 'https://connect.orangerails.com/connect';
const WIDGET_ORIGIN = 'https://connect.orangerails.com';
const ORG_ID = 'org-uuid-1234';
const CRED_KEY = 'Y3JlZF9rZXlfYjY0X29wYXF1ZQ==';
const TXN_KEY = 'dHhuX2tleV9iNjRfb3BhcXVl';

interface MockPopup {
  closed: boolean;
  close: ReturnType<typeof vi.fn>;
}

/**
 * A Response shaped object. Built by hand rather than with `new Response`
 * because the jsdom test environment does not guarantee that constructor, and
 * a test that fails on its own scaffolding teaches nothing.
 */
function fakeResponse(status: number, body: unknown): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => (typeof body === 'string' ? JSON.parse(text) : body),
    text: async () => text,
  } as unknown as Response;
}

function postFromWidget(data: unknown, origin: string): void {
  window.dispatchEvent(new MessageEvent('message', { data, origin }));
}

/** Let the await chain inside openOrConnect run: mint, then window.open. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('openOrConnect', () => {
  const realFetch = globalThis.fetch;
  const realOpen = window.open;

  let fetchMock: ReturnType<typeof vi.fn>;
  let openedUrls: string[];
  let popup: MockPopup;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('VITE_OR_CONNECT_URL', WIDGET_BASE);
    vi.stubEnv('VITE_OR_PLATFORM_SLUG', 'orangeway-books');

    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'test-jwt' } } });
    mocks.refreshSession.mockResolvedValue({
      data: { session: { access_token: 'refreshed-jwt' } },
    });

    fetchMock = vi.fn().mockResolvedValue(fakeResponse(200, { widget_token: 'widget-tok-abc' }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    openedUrls = [];
    popup = {
      closed: false,
      close: vi.fn(() => {
        popup.closed = true;
      }),
    };
    window.open = vi.fn((url?: string | URL) => {
      openedUrls.push(String(url));
      return popup as unknown as Window;
    }) as unknown as typeof window.open;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    window.open = realOpen;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('mints through owb-or-proxy and keeps both keys in the fragment, never the query', async () => {
    const { openOrConnect } = await import('../widget');

    const pending = openOrConnect({ orgId: ORG_ID, credKeyB64: CRED_KEY, txnKeyB64: TXN_KEY });
    await flush();

    // The mint call. org_id is the ORG, not the user: owb-or-proxy provisions
    // one Orange Rails subaccount per org, so a token minted under anything
    // else belongs to a subject with no subaccount.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toBe('https://books.local/functions/v1/owb-or-proxy');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toMatchObject({
      endpoint: 'or-link-mint-token',
      org_id: ORG_ID,
    });

    expect(openedUrls).toHaveLength(1);
    const opened = new URL(openedUrls[0]);
    expect(opened.origin).toBe(WIDGET_ORIGIN);
    expect(opened.searchParams.get('platform')).toBe('orangeway-books');
    expect(opened.searchParams.get('app_user_id')).toBe(ORG_ID);
    expect(opened.searchParams.has('provider')).toBe(false); // omitted, so OR shows its picker

    // The property this whole module exists to hold. `opened.search` is the
    // part a server sees and logs; the fragment is not sent at all.
    expect(opened.search).not.toContain('cred_key');
    expect(opened.search).not.toContain('txn_key');
    expect(opened.search).not.toContain(CRED_KEY);
    expect(opened.search).not.toContain(TXN_KEY);
    const frag = new URLSearchParams(opened.hash.slice(1));
    expect(frag.get('widget_token')).toBe('widget-tok-abc');
    expect(frag.get('cred_key')).toBe(CRED_KEY);
    expect(frag.get('txn_key')).toBe(TXN_KEY);

    postFromWidget(
      {
        type: 'or-link-success',
        connection_id: 'conn-1',
        subaccount_id: 'sub-1',
        source_wallets: [
          {
            id: 'sw-1',
            external_wallet_id: 'ext-1',
            currency: 'BTC',
            label: 'Bitcoin wallet',
          },
        ],
      },
      WIDGET_ORIGIN,
    );

    const result = await pending;
    expect(result).toMatchObject({
      type: 'or-link-success',
      connection_id: 'conn-1',
      subaccount_id: 'sub-1',
    });
    // subaccount_id and the wallet list have to survive the handler: the
    // import side needs both, and an empty list is different from an absent
    // one downstream.
    expect(result.source_wallets).toHaveLength(1);
    expect(result.source_wallets[0]).toMatchObject({
      external_wallet_id: 'ext-1',
      currency: 'BTC',
    });
    expect(popup.close).toHaveBeenCalled();
  });

  it('passes provider through when the caller deep links a single provider', async () => {
    const { openOrConnect } = await import('../widget');

    const pending = openOrConnect({
      orgId: ORG_ID,
      provider: 'blink',
      credKeyB64: CRED_KEY,
      txnKeyB64: TXN_KEY,
    });
    await flush();

    expect(new URL(openedUrls[0]).searchParams.get('provider')).toBe('blink');

    postFromWidget(
      { type: 'or-link-success', connection_id: 'c', subaccount_id: 's', source_wallets: [] },
      WIDGET_ORIGIN,
    );
    await pending;
  });

  it('rejects when the customer cancels inside the widget', async () => {
    const { openOrConnect } = await import('../widget');

    const pending = openOrConnect({ orgId: ORG_ID, credKeyB64: CRED_KEY, txnKeyB64: TXN_KEY });
    await flush();
    postFromWidget({ type: 'or-link-cancel' }, WIDGET_ORIGIN);

    await expect(pending).rejects.toThrow(/cancel/i);
  });

  it('rejects when the popup is blocked instead of waiting on a window that never opened', async () => {
    window.open = vi.fn(() => null) as unknown as typeof window.open;
    const { openOrConnect } = await import('../widget');

    await expect(
      openOrConnect({ orgId: ORG_ID, credKeyB64: CRED_KEY, txnKeyB64: TXN_KEY }),
    ).rejects.toThrow(/popup blocked/i);
  });

  it('rejects with the status when the mint call fails, and opens nothing', async () => {
    fetchMock.mockResolvedValueOnce(fakeResponse(429, 'rate limited'));
    const { openOrConnect } = await import('../widget');

    await expect(
      openOrConnect({ orgId: ORG_ID, credKeyB64: CRED_KEY, txnKeyB64: TXN_KEY }),
    ).rejects.toThrow(/or-link-mint-token failed.*429/);
    expect(openedUrls).toHaveLength(0);
  });

  it('refreshes the session once and retries when the edge gateway answers 401', async () => {
    // The gateway sometimes rejects a freshly minted session token on the
    // first call because Auth and the gateway have not converged. Books
    // already works around this everywhere else it calls the proxy; without
    // the same retry here a customer who just signed in cannot connect.
    fetchMock.mockResolvedValueOnce(fakeResponse(401, { error: 'Unauthorized' }));
    const { openOrConnect } = await import('../widget');

    const pending = openOrConnect({ orgId: ORG_ID, credKeyB64: CRED_KEY, txnKeyB64: TXN_KEY });
    await flush();

    expect(mocks.refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = retryInit.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer refreshed-jwt');
    expect(openedUrls).toHaveLength(1);

    postFromWidget(
      { type: 'or-link-success', connection_id: 'c', subaccount_id: 's', source_wallets: [] },
      WIDGET_ORIGIN,
    );
    await pending;
  });

  it('ignores a success message from any other origin', async () => {
    const { openOrConnect } = await import('../widget');

    const pending = openOrConnect({ orgId: ORG_ID, credKeyB64: CRED_KEY, txnKeyB64: TXN_KEY });
    await flush();

    // Same shape, wrong sender. If this ever resolves the promise, any page
    // the customer has open can hand Books a connection id of its choosing.
    postFromWidget(
      {
        type: 'or-link-success',
        connection_id: 'not-ours',
        subaccount_id: 'not-ours',
        source_wallets: [],
      },
      'https://attacker.example',
    );

    // Still pending. Close the popup so the poll settles it and the case does
    // not depend on the 150s guard.
    popup.closed = true;
    await expect(pending).rejects.toThrow(/closed before completion/i);
  });

  it('rejects on the hang guard when nothing terminal ever arrives', async () => {
    vi.useFakeTimers();
    try {
      const { openOrConnect } = await import('../widget');
      const pending = openOrConnect({ orgId: ORG_ID, credKeyB64: CRED_KEY, txnKeyB64: TXN_KEY });

      // Observe settlement without leaving an unhandled rejection behind when
      // the guard fires.
      let state: 'pending' | 'resolved' | 'rejected' = 'pending';
      let failure: unknown;
      pending.then(
        () => {
          state = 'resolved';
        },
        (err) => {
          state = 'rejected';
          failure = err;
        },
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(openedUrls).toHaveLength(1);

      // One second short of the guard the session is still live. This is the
      // window a shorter guard would kill a slow but working link in.
      await vi.advanceTimersByTimeAsync(149000);
      expect(state).toBe('pending');

      await vi.advanceTimersByTimeAsync(2000);
      expect(state).toBe('rejected');
      expect((failure as Error).message).toMatch(/timed out/i);
      expect(popup.close).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses to open anything when the build has no platform slug', async () => {
    // No default is deliberate. A fallback slug means a misconfigured build
    // names the wrong Orange Rails platform and fails later as a 401 that
    // reads like an expired token, which is the hardest kind of wrong to
    // trace. Failing here costs one clear error message.
    vi.stubEnv('VITE_OR_PLATFORM_SLUG', '');
    vi.resetModules();
    const { openOrConnect } = await import('../widget');

    await expect(
      openOrConnect({ orgId: ORG_ID, credKeyB64: CRED_KEY, txnKeyB64: TXN_KEY }),
    ).rejects.toThrow(/VITE_OR_PLATFORM_SLUG/);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(openedUrls).toHaveLength(0);
  });
});
