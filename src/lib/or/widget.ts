/**
 * The OR hosted connect widget, as Books opens it.
 *
 * Books is a consumer of OrangeRails in the same shape a bookkeeping app
 * consumes any aggregator. Rather than rebuilding the provider picker, the
 * credential form and the wallet picker in Books, this opens OR's hosted
 * /connect route in a popup and resolves when the customer finishes.
 *
 * THE KEY HANDOFF, AND WHY IT IS A FRAGMENT AND NOT A QUERY STRING.
 * OR's /connect route takes `cred_key` and `txn_key`, base64 raw 32 byte AES
 * keys, in the URL FRAGMENT. A fragment is not sent to the server by the
 * browser, so it does not appear in OR's access logs, its proxy logs, or a
 * referrer header. Putting the same values in the query string would write
 * the customer's keys into a log on a machine we do not control. The widget
 * seals the credential under those keys and posts back only the resulting
 * subaccount_id and connection_id, so Books never holds the plaintext
 * credential and neither does any server on our side.
 *
 * WHERE THE KEYS COME FROM, and what this module deliberately does not do.
 * This module does not derive anything. The caller passes the two subkeys in
 * already derived, which keeps every piece of key handling in one place (the
 * Orange Rails key material module) instead of two. If you are reading this
 * looking for the derivation, it is not here on purpose.
 *
 * BOOKS IS MULTI ORG AND THE PERSONAL APP IS NOT. In the personal app the
 * vault is per user, so its equivalent of `orgId` is just the signed in user.
 * In Books an account can hold several orgs, so `orgId` is the real active
 * org id and the caller must pass the one the customer is looking at. Getting
 * this wrong does not fail loudly: it links the wallet to the wrong set of
 * books.
 */

import { supabase, SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from '@/lib/supabase';

/**
 * The origin that serves the widget.
 *
 * It must be a host that serves /connect DIRECTLY. An apex domain that
 * redirects to the connect subdomain does not work, and it does not fail in a
 * way anyone would recognise: the widget then posts its completion message
 * from an origin that never equals `expectedOrigin` below, the strict compare
 * drops the message, and the promise below simply never settles until the
 * hang guard fires. Set it per environment in .github/workflows/deploy.yml.
 *
 * `||` and not `??` on purpose. A workflow that sets the variable to an empty
 * string produces '' here, which is not nullish, so `??` would keep it and
 * `new URL('')` would throw. Treat empty as unset.
 */
export const OR_CONNECT_URL_RAW = import.meta.env.VITE_OR_CONNECT_URL as string | undefined;
export const OR_CONNECT_BASE = OR_CONNECT_URL_RAW || 'https://connect.orangerails.com/connect';

/** Thrown when the platform slug is not configured. See resolveOrPlatformSlug. */
export class OrPlatformSlugMissingError extends Error {
  constructor() {
    super(
      'VITE_OR_PLATFORM_SLUG is not set. It names the OR platform this build ' +
        'connects as and it differs per environment, so there is no safe default. ' +
        'Set it in .github/workflows/deploy.yml for this environment.',
    );
    this.name = 'OrPlatformSlugMissingError';
  }
}

/**
 * The platform slug OR resolves this app by.
 *
 * It MUST name the same platform row that this environment's OR platform API
 * key authenticates as. They can drift because two different parties send
 * them: mintWidgetToken below goes through owb-or-proxy, which sends the API
 * key, so OR records the pending session under the platform the KEY maps to.
 * The browser then claims that session by sending this slug and no key, and
 * OR filters the lookup by the platform the SLUG maps to. Name two different
 * platforms and the claim never matches its own session row. It surfaces as a
 * 401 "Invalid widget token", which reads like an expired or replayed token
 * and is neither, so the slug is the last thing anyone checks.
 *
 * THERE IS DELIBERATELY NO DEFAULT. The personal app falls back to its own
 * dev slug when the variable is unset, which means a production build with a
 * missing variable names the dev platform and fails with the misleading 401
 * above. Books throws instead. An exception naming the variable costs one
 * minute; the 401 has cost hours. The dev value lives in .env.example and the
 * deployed values come from the environment scoped vars in deploy.yml.
 */
export function resolveOrPlatformSlug(): string {
  const configured = (import.meta.env.VITE_OR_PLATFORM_SLUG as string | undefined) || '';
  if (!configured) throw new OrPlatformSlugMissingError();
  return configured;
}

/**
 * Client side hang guard for a link session, in milliseconds.
 *
 * OR's proxy runs its own 120s timeout and posts a terminal message back to
 * this window when it fires. This guard sits STRICTLY above that, so in the
 * ordinary timeout case the proxy's own message always wins and the customer
 * sees the real reason. This one only fires when even that never arrived: the
 * popup wedged, a cross origin redirect severed window.opener, or the message
 * was dropped. Without it a wedged session leaves the returned promise
 * pending forever and the button spins until the tab is closed.
 *
 * There is deliberately no shorter fallback. A 15s guard would race slow but
 * live sessions that are still linking and kill them.
 */
export const STEALTH_SESSION_TIMEOUT_MS = 150000;

/** A source wallet the customer picked inside the widget. */
export interface OrLinkSourceWallet {
  id: string;
  external_wallet_id: string;
  currency: string;
  label: string;
}

/** The success payload OR /connect posts back on completion. */
export interface OrLinkSuccess {
  type: 'or-link-success';
  connection_id: string;
  subaccount_id: string;
  source_wallets: OrLinkSourceWallet[];
}

/**
 * Build the widget URL. Exported for tests, because the placement of the two
 * keys is the security property of this module and a test that cannot see the
 * URL cannot prove it: the keys belong after the '#' and nowhere else.
 */
export function buildConnectUrl(args: {
  platform: string;
  appUserId: string;
  provider?: string;
  returnTo: string;
  widgetToken: string;
  credKeyB64: string;
  txnKeyB64: string;
}): string {
  const qs = new URLSearchParams({
    platform: args.platform,
    app_user_id: args.appUserId,
    return_to: args.returnTo,
  });
  if (args.provider) qs.set('provider', args.provider);
  const frag = new URLSearchParams({
    widget_token: args.widgetToken,
    cred_key: args.credKeyB64,
    txn_key: args.txnKeyB64,
  });
  return `${OR_CONNECT_BASE}?${qs.toString()}#${frag.toString()}`;
}

/**
 * Open the OR hosted connect widget.
 *
 * Resolves with the link result on success. Rejects when the customer
 * cancels, when the popup is closed before completion, when the popup is
 * blocked, and when nothing terminal arrives at all. Every one of those is a
 * rejection rather than a quiet no-op, because the caller has to be able to
 * tell "the customer changed their mind" from "we never heard back", and a
 * promise that never settles tells it neither.
 *
 * Omit `provider` to let the widget show its own provider picker step.
 */
export async function openOrConnect(args: {
  orgId: string;
  provider?: string;
  credKeyB64: string;
  txnKeyB64: string;
}): Promise<OrLinkSuccess> {
  const platform = resolveOrPlatformSlug();
  const widgetToken = await mintWidgetToken(args.orgId);
  const url = buildConnectUrl({
    platform,
    appUserId: args.orgId,
    provider: args.provider,
    returnTo: window.location.origin,
    widgetToken,
    credKeyB64: args.credKeyB64,
    txnKeyB64: args.txnKeyB64,
  });

  const popup = window.open(url, 'or-connect', 'width=720,height=900,popup=yes');
  if (!popup) {
    throw new Error('Popup blocked. Allow popups for this site to connect a wallet.');
  }
  const popupRef = popup;

  return new Promise<OrLinkSuccess>((resolve, reject) => {
    const expectedOrigin = new URL(OR_CONNECT_BASE).origin;
    let settled = false;

    const hangGuard = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Link session timed out with no response from the widget'));
    }, STEALTH_SESSION_TIMEOUT_MS);

    function handle(event: MessageEvent) {
      // Strict origin compare. Any window can postMessage into this one, and
      // the payload below is trusted enough to create a connection, so a
      // message from anywhere other than the widget's own origin is ignored
      // rather than inspected.
      if (event.origin !== expectedOrigin) return;
      const data = event.data as { type?: string };
      if (data?.type === 'or-link-success') {
        settled = true;
        cleanup();
        resolve(event.data as OrLinkSuccess);
      } else if (data?.type === 'or-link-cancel') {
        settled = true;
        cleanup();
        reject(new Error('User cancelled'));
      }
    }

    // The popup can be closed with the window chrome, which posts nothing at
    // all, so closure has to be polled. Without this the customer closes the
    // window and the button spins until the hang guard fires two minutes
    // later.
    const poll = window.setInterval(() => {
      if (popupRef.closed && !settled) {
        settled = true;
        cleanup();
        reject(new Error('Widget closed before completion'));
      }
    }, 500);

    function cleanup() {
      window.removeEventListener('message', handle);
      window.clearInterval(poll);
      window.clearTimeout(hangGuard);
      try {
        popupRef.close();
      } catch {
        /* already closed */
      }
    }

    window.addEventListener('message', handle);
  });
}

/**
 * Mint the short lived token the widget authenticates to OR with.
 *
 * Exported because the stealth sync flow mints its own: it opens the widget
 * directly rather than through openOrConnect, and this token is the widget's
 * only means of authenticating to OR's edge functions.
 *
 * The 401 retry mirrors what Books already does everywhere else it calls this
 * proxy. The Supabase edge gateway sometimes rejects a freshly minted session
 * token on the first call because Auth and the gateway have not converged
 * yet. Refreshing once and retrying turns a spurious "not signed in" into a
 * normal call. It retries exactly once: a second 401 is a real one.
 */
export async function mintWidgetToken(orgId: string): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) throw new Error('Not signed in');

  let res = await postMint(session.access_token, orgId);
  if (res.status === 401) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    if (refreshed?.session?.access_token) {
      res = await postMint(refreshed.session.access_token, orgId);
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`or-link-mint-token failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { widget_token?: string; error?: string };
  if (!json.widget_token) throw new Error(json.error ?? 'Mint returned no widget_token');
  return json.widget_token;
}

/**
 * The proxy call itself, hit with fetch rather than supabase.functions.invoke
 * so a test can mock global fetch and assert what was sent.
 */
async function postMint(accessToken: string, orgId: string): Promise<Response> {
  return fetch(`${SUPABASE_URL}/functions/v1/owb-or-proxy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      apikey: SUPABASE_PUBLISHABLE_KEY,
    },
    body: JSON.stringify({
      endpoint: 'or-link-mint-token',
      org_id: orgId,
      payload: {},
    }),
  });
}
