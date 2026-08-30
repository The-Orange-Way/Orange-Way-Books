/**
 * The Orange Rails hosted connect widget, from the Books side.
 *
 * Books is a Plaid-style consumer of Orange Rails. Rather than rebuild the
 * provider picker, the credential form and the wallet picker inside Books,
 * this helper opens the hosted /connect route in a popup and resolves when
 * the customer finishes.
 *
 * WHY THE KEYS TRAVEL IN THE URL FRAGMENT, AND WHY THAT IS THE SHAPE THAT
 * KEEPS THE SERVER OUT OF THE BOOKS. The /connect route accepts cred_key and
 * txn_key (base64 raw 32 byte AES keys) in the URL fragment. A fragment is
 * never transmitted to a server and never appears in a server log; it exists
 * only in the browser. The widget seals the customer's provider credential
 * under those keys and posts back only subaccount_id and connection_id. So
 * Books never handles the plaintext credential, and the other side never
 * handles the key.
 *
 * That is a property of WHERE the values are placed, not of any check that
 * runs. Move cred_key or txn_key into the query string, or into the body of
 * the mint call below, and every test here still passes while the server
 * becomes able to read the books. Anyone editing buildConnectUrl should read
 * that sentence twice.
 *
 * HOW BOOKS DIFFERS FROM THE PERSONAL TWIN. This is the whole list, so a
 * future reader can tell a deliberate divergence from drift:
 *
 *   1. orgId is a real organization id, not a user id. The personal app has
 *      no org concept, so it passes the signed-in user id. Books is multi
 *      org, so the caller passes the active org and owb-or-proxy verifies
 *      the caller is a member of that org before it will mint anything.
 *   2. The platform slug is resolved by a function, not fixed in a constant
 *      at import time, and a production build refuses to guess it. See
 *      resolveOrPlatformSlug below for why.
 */

import { supabase } from '@/integrations/supabase/client';

/**
 * The host that serves the widget directly.
 *
 * It must be a host that serves /connect itself. An apex domain that
 * redirects to the connect subdomain does not work: the widget then posts
 * its completion message from an origin that never matches expectedOrigin
 * below, and the strict compare drops the message with no error at all. The
 * session looks like it hung.
 *
 * `||` and not `??` on purpose. A workflow that sets this variable to an
 * empty string produces '' here, which is not nullish, so `??` would keep it
 * and `new URL('')` would throw. Treat empty as unset.
 */
export const OR_CONNECT_URL_RAW = import.meta.env.VITE_OR_CONNECT_URL as string | undefined;
export const OR_CONNECT_BASE = OR_CONNECT_URL_RAW || 'https://connect.orangerails.com/connect';

/**
 * The slug used when no build-time value is configured. Development only,
 * and named as such so nobody reads it as "the Books slug".
 */
export const OR_PLATFORM_SLUG_DEV_DEFAULT = 'orangeway-books';

/**
 * The platform slug this build claims widget sessions under.
 *
 * WHY THIS IS A FUNCTION WITH A REFUSAL IN IT, rather than the single
 * constant the personal twin uses. The slug must name the same platform row
 * that this environment's platform API key authenticates as. They can drift
 * because the two halves travel different paths: mintWidgetToken goes
 * through owb-or-proxy, which sends the API key, so the session is recorded
 * under the platform the KEY maps to. The browser then claims that session
 * by sending this slug and no key, and the lookup is filtered by the
 * platform the SLUG maps to. Name two different platforms and the claim
 * never matches its own session row. It surfaces as a 401 "invalid widget
 * token", which reads like an expired or replayed token and is neither.
 *
 * Books has a different slug per environment, so a production build with the
 * variable unset would fall back and quietly claim under the development
 * platform. That is the silent-wrong-default shape: it would look like a
 * token bug for as long as it took someone to read this file. So a
 * production build refuses instead, at the moment the widget is opened
 * rather than at import time, which keeps one broken action from taking the
 * whole bundle down at load.
 *
 * Set VITE_OR_PLATFORM_SLUG per environment in the deploy workflow, both
 * arms explicit. An empty arm is not "unset with a sensible default", it is
 * the wrong platform.
 */
export function resolveOrPlatformSlug(): string {
  const configured = (import.meta.env.VITE_OR_PLATFORM_SLUG as string | undefined) || '';
  if (configured) return configured;

  const deployEnv = (import.meta.env.VITE_DEPLOY_ENV as string | undefined) || '';
  if (deployEnv === 'prod') {
    throw new Error(
      'VITE_OR_PLATFORM_SLUG is not set in this build. Refusing to open the connect widget ' +
        'rather than claim the session under the development platform, which fails later as a ' +
        'misleading 401 on the widget token.',
    );
  }
  return OR_PLATFORM_SLUG_DEV_DEFAULT;
}

/**
 * Client-side hang guard for a link session, in milliseconds.
 *
 * The proxy on the other side runs its own 120s timeout and, when it fires,
 * posts a terminal message back to this window. This guard sits STRICTLY
 * above that 120s so the terminal message always wins in the ordinary
 * timeout case. The client guard only fires when even that never arrived:
 * the popup wedged, a cross-origin redirect severed window.opener, or the
 * message was dropped. Without it, a wedged session leaves the returned
 * promise pending forever and the customer sees a spinner with no end.
 *
 * There is deliberately no shorter fallback. A 15s guard would race live
 * sessions that are simply slow and kill them mid-link.
 */
const STEALTH_SESSION_TIMEOUT_MS = 150000;

/** Source wallets returned by the widget after the customer picks them. */
export interface OrLinkSourceWallet {
  id: string;
  external_wallet_id: string;
  currency: string;
  label: string;
}

/** Success payload posted by the hosted /connect route on completion. */
export interface OrLinkSuccess {
  type: 'or-link-success';
  connection_id: string;
  subaccount_id: string;
  source_wallets: OrLinkSourceWallet[];
}

/**
 * Open the hosted connect widget for an organization.
 *
 * Resolves with the success payload, rejects on cancel, on the popup being
 * closed, on the popup being blocked, and on the hang guard. Omit `provider`
 * to let the widget show its own provider picker step.
 *
 * Every rejection carries a reason a human can act on. That matters more
 * than it looks: the failure this replaces was a promise that never settled,
 * which the UI could only render as an indefinite spinner.
 */
export async function openOrConnect(args: {
  orgId: string;
  provider?: string;
  credKeyB64: string;
  txnKeyB64: string;
}): Promise<OrLinkSuccess> {
  // Resolved before the token is minted so a misconfigured production build
  // fails without having created a session on the other side.
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

    // See STEALTH_SESSION_TIMEOUT_MS. Rejects if no terminal message and no
    // popup close ever arrive, so a wedged session cannot leave this promise
    // pending forever.
    const hangGuard = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Link session timed out with no response from the widget'));
    }, STEALTH_SESSION_TIMEOUT_MS);

    function handle(event: MessageEvent) {
      // The origin compare is the only thing standing between this promise
      // and a message from any other page the customer has open. Never
      // loosen it to a substring or a prefix test.
      if (event.origin !== expectedOrigin) return;
      const data = event.data as { type?: string };
      if (data?.type === 'or-link-success') {
        settled = true;
        cleanup();
        resolve(event.data as OrLinkSuccess);
      } else if (data?.type === 'or-link-cancel') {
        settled = true;
        cleanup();
        reject(new Error('Wallet connection cancelled'));
      }
    }

    const poll = window.setInterval(() => {
      if (popupRef.closed && !settled) {
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
 * Mint the short-lived session token the widget authenticates with.
 *
 * Exported because a later slice opens the widget directly rather than
 * through openOrConnect, and this token is the widget's only means of
 * authenticating to the other side's edge functions.
 *
 * The call goes through owb-or-proxy, never straight to Orange Rails: the
 * platform API key lives only on the server, and the proxy is also where
 * membership of org_id is verified. A browser that could mint a token for an
 * arbitrary org id would be able to attach a wallet to books it cannot read.
 */
export async function mintWidgetToken(orgId: string): Promise<string> {
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const accessToken = session?.access_token;
  if (!accessToken) throw new Error('Not signed in');

  // Resolved the same way the Supabase client resolves them. The proxy is
  // called with fetch rather than supabase.functions.invoke so tests can
  // drive the transport directly.
  const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) ?? '';
  const SUPABASE_PUBLISHABLE_KEY =
    (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ?? '';

  const res = await fetch(`${SUPABASE_URL}/functions/v1/owb-or-proxy`, {
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
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`or-link-mint-token failed (${res.status}): ${body}`);
  }
  const json = (await res.json()) as { widget_token?: string; error?: string };
  if (!json.widget_token) throw new Error(json.error ?? 'Mint returned no widget_token');
  return json.widget_token;
}

/**
 * Build the /connect URL.
 *
 * The split between query string and fragment is the security boundary
 * described at the top of this file: identifiers in the query, key material
 * in the fragment. Do not move an item across that line to make a URL
 * tidier.
 */
function buildConnectUrl(args: {
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
