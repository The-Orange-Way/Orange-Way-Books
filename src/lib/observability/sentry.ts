/**
 * Sentry error tracking , ZKA-aware setup.
 *
 * Why a wrapper instead of calling Sentry.init() directly:
 *   1. We must NEVER ship decrypted user data (transaction amounts, merchants,
 *      vault password, MEK bytes, OPK private key) to Sentry. The
 *      `scrubEvent` helper walks every breadcrumb / exception value / tag /
 *      URL / message and drops anything that looks dangerous. Sentry itself
 *      has scrubbing options, but they run on the server , we strip BEFORE
 *      the network call.
 *   2. The DSN is read from VITE_SENTRY_DSN. When absent (local dev, or
 *      before the founder picks Sentry as the backend), `initSentry()` is a
 *      no-op , no network calls, no module side effects, no SDK download.
 *   3. The SDK itself is dynamic-imported at init time so a fresh checkout
 *      without `@sentry/react` installed still typechecks and builds.
 *   4. Environment is derived from `import.meta.env.MODE` so dev and prod
 *      builds carry their real tag , `import.meta.env.DEV` is false during
 *      `vite build` of either branch, which would mistakenly tag the dev
 *      build as "prod".
 *
 * What gets scrubbed before send:
 *   - object keys matching SECRET_KEY_PATTERNS (password, mek, opk, vault_*,
 *     recovery_code, cred_key, txn_key, seed, private_key, api_key,
 *     access_token, refresh_token, authorization, jwt, service_role,
 *     decrypted_*, plus plaintext field names like merchant/description)
 *   - string fields run through TOKEN_PATTERNS (URL fragments, query strings,
 *     known token prefixes) so a Supabase recovery URL fragment leaking into
 *     an exception message or breadcrumb message does NOT reach the network.
 *   - console-category breadcrumbs at level "log" are dropped entirely , they
 *     would otherwise leak DEV-only fingerprints if anyone ever bypassed the
 *     import.meta.env.DEV gate on the key-fingerprint logs.
 *
 * Companion changes:
 *   - main.tsx calls initSentry() before React mounts.
 *   - components/error/logError.ts best-effort captures via captureException.
 */

// Static top-level import. We tried two looser variants first:
//   1. await import(/* @vite-ignore */ modName)  , Vite skipped bundling
//      entirely; browser tried to fetch /@sentry/react as a URL → 404.
//   2. await import("@sentry/react")             , package.json sideEffects:
//      false made Rollup eliminate the dynamic import because no observable
//      side effect connected the call site to the SDK. Bundle was 0 bytes
//      of @sentry.
// A static top-level import is unambiguous: Vite always bundles it,
// Rollup can't tree-shake the namespace import away because Sentry.init is
// referenced inside initSentry, and the cost is tiny (a few KB minified
// gzip, dwarfed by the React + Supabase chunks already on the page).
import * as Sentry from '@sentry/react';

/** Object keys (case-insensitive) we scrub from event payloads. */
const SECRET_KEY_PATTERNS = [
  /password/i,
  /passphrase/i,
  /pin/i,
  /mek/i,
  /opk/i,
  /vault_key/i,
  /vault_password/i,
  /recovery_code/i,
  /credentials_key/i,
  /transactions_key/i,
  /cred_key/i,
  /txn_key/i,
  /seed/i,
  /private_key/i,
  /privatekey/i,
  /api_key/i,
  /apikey/i,
  /access_token/i,
  /accesstoken/i,
  /refresh_token/i,
  /refreshtoken/i,
  /authorization/i,
  /^auth$/i,
  /jwt/i,
  /service_role/i,
  /servicerole/i,
  /^decrypted_/i,
  /^merchant$/i,
  /^counterparty$/i,
  /^description$/i,
  /_description$/i,
  /^memo$/i,
  /^balance$/i,
  /^plaintext$/i,
  // Bookkeeping-native plaintext field names that can appear in form
  // state, mutation payloads, or stack frame locals. Each is fine on
  // its own but combined with org_id + date they fingerprint a customer.
  /^account_name$/i,
  /^account_code$/i,
  /^vendor$/i,
  /^customer$/i,
  /^payee$/i,
  /^reference$/i,
  /^invoice_number$/i,
  // Short-lived third-party connector tokens (Quiltt widget, OAuth
  // popup quick-connect, magic-link tokens). Not Bitcoin-key class but
  // still grants temporary read access to an upstream account if
  // intercepted, so we keep them out of error payloads.
  /widget_token/i,
  /quick_?connect/i,
  /link_token/i,
];

/**
 * Patterns redacted out of free-form strings , exception messages, breadcrumb
 * messages, URLs. Order matters: longer-prefix matches run first so e.g.
 * `access_token=…` doesn't get swallowed by the bare `token=…` clause.
 */
const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  // Supabase recovery / magic-link fragments. Supabase's recovery flow
  // returns the access token in the URL fragment; render errors on the
  // reset-password landing before fragment clear would otherwise ship
  // those tokens in event.request.url.
  [
    /(access_token|refresh_token|provider_token|provider_refresh_token|id_token)=[^&\s#"']+/gi,
    '$1=[redacted]',
  ],
  [
    /(token|code|state|nonce|jwt|api_key|apikey|secret|password|opk|mek|seed)=[^&\s#"']+/gi,
    '$1=[redacted]',
  ],
  // Bearer Authorization headers
  [/Bearer\s+[A-Za-z0-9._+/=-]+/g, 'Bearer [redacted]'],
  // JWT-shaped strings (3 base64 segments dot-separated)
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt redacted]'],
];

const REDACTED = '[redacted]';

/**
 * Default Sentry integrations we explicitly disable. Each name is the
 * integration's `.name` property as exposed by the @sentry/react default
 * integration set. Exported so the contract test in
 * __tests__/sentry.test.ts can assert against the same source of truth.
 *
 * When bumping `@sentry/react` to a new major, re-verify against the
 * SDK's current default integration list:
 *   - new PII-leaning integration shipped? Add the name here.
 *   - one of these renamed? Update the name here AND in the test.
 * The companion test asserts the filtered list is a subset of a known-
 * safe allowlist so a future SDK shipping a new default we missed will
 * be caught by a positive failure.
 */
export const DROPPED_INTEGRATIONS: ReadonlySet<string> = new Set([
  'BrowserTracing',
  'Replay',
  'BrowserSession',
  'HttpContext',
]);

function scrubString(s: string): string {
  let out = s;
  for (const [re, repl] of TOKEN_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}

/**
 * Stronger URL scrub , drop the fragment entirely and run query-string
 * through TOKEN_PATTERNS. Fragments are the highest-risk surface (recovery
 * tokens land there) and have zero usefulness for debugging.
 */
function scrubUrl(u: string): string {
  if (typeof u !== 'string') return u;
  // Drop fragment regardless of what's in it.
  const noHash = u.split('#')[0];
  return scrubString(noHash);
}

function scrubValue(v: unknown, depth = 0): unknown {
  if (depth > 8) return REDACTED;
  if (v == null) return v;
  if (typeof v === 'string') {
    const trimmed = v.length > 2000 ? v.slice(0, 2000) + '…' : v;
    return scrubString(trimmed);
  }
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map((item) => scrubValue(item, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERNS.some((p) => p.test(k))) {
        out[k] = REDACTED;
      } else if (k === 'url' && typeof val === 'string') {
        out[k] = scrubUrl(val);
      } else {
        out[k] = scrubValue(val, depth + 1);
      }
    }
    return out;
  }
  return REDACTED;
}

let initialised = false;

/**
 * Initialise Sentry. Safe to call multiple times , only the first call wires
 * the SDK. No-ops when VITE_SENTRY_DSN is unset.
 */
export function initSentry(): void {
  if (initialised) return;
  const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
  if (!dsn) return;
  initialised = true;
  // Environment derives from VITE_DEPLOY_ENV (workflow-supplied), falling
  // back to MODE so dev builds tag as "dev" even though import.meta.env.DEV
  // is false inside `vite build`. Final fallback: "prod" for safety.
  const explicitEnv = import.meta.env.VITE_DEPLOY_ENV as string | undefined;
  const mode = import.meta.env.MODE as string | undefined;
  const environment = explicitEnv || (mode && mode !== 'production' ? mode : 'prod');

  // Release identifier , matches what sentry-cli uploaded source maps under
  // in the deploy workflow. Without this, GlitchTip can't tie a captured
  // event back to the right batch of maps and stack frames stay minified.
  const release = import.meta.env.VITE_SENTRY_RELEASE as string | undefined;

  Sentry.init({
    dsn,
    environment,
    release,
    tracesSampleRate: 0,
    // Explicit no-PII guarantee. The default in @sentry/react v10 is
    // already false, but Sentry has shifted privacy-relevant defaults
    // across major versions before; pinning this here keeps the
    // no-tracking marketing claim ("we can't see your data") honest
    // even if a future minor flips the default. When true, Sentry
    // attaches the request IP, User-Agent, and cookies to every
    // event.
    sendDefaultPii: false,
    // Drop the heavy or PII-leaning integrations explicitly. Sentry
    // would otherwise auto-enable:
    //   - BrowserTracing: performance traces with URL + route metadata
    //   - Replay: DOM mutations including form inputs (a direct ZKA
    //     breach)
    //   - BrowserSession: per-pageload session id keyed against ingest
    //     IP, a fingerprint at the Sentry edge with no value for an
    //     error-only deployment (in Sentry v10 sessions are managed
    //     via this integration, not the v8 `autoSessionTracking`
    //     option)
    //   - HttpContext: attaches request.url + request.headers +
    //     request.cookies to every event from document/navigator.
    //     Cookies include the Supabase auth JWT. The `beforeSend`
    //     scrubber catches this on the way out, but dropping the
    //     integration means cookie strings never enter the pipeline.
    //
    // SDK-version note: the filter is name-string based. When bumping
    // `@sentry/react`, re-verify against the SDK's current default
    // integrations; if any of these are renamed the filter is
    // silently vacuous. The companion test asserts each name is
    // dropped against a synthetic defaults list.
    integrations: (defaults) => defaults.filter((i) => !DROPPED_INTEGRATIONS.has(i.name)),
    beforeSend: (event) => scrubEventLoose(event) as Sentry.ErrorEvent,
    beforeBreadcrumb: (bc) => {
      // Drop noisy console.log/info/debug breadcrumbs , Sentry's default
      // BrowserClient grabs every console call by default. We only want
      // error/warn breadcrumbs reaching the buffer, partly to keep volume
      // sane, partly to guarantee the DEV-only key-fingerprint console.log
      // can never end up attached to a captured event.
      if (bc.category === 'console') {
        const level = (bc.level ?? 'log').toLowerCase();
        if (level !== 'error' && level !== 'warn') return null;
      }
      if (bc.message) bc.message = scrubString(bc.message);
      if (bc.data) bc.data = scrubValue(bc.data) as Record<string, unknown>;
      return bc;
    },
  });
}

/**
 * Loose-typed scrubber for the runtime SDK path. The Sentry types live in
 * the optional `@sentry/react` package; without them we work in `unknown`.
 *
 * Covers:
 *   - extra / contexts / tags  (key + value)
 *   - request.data            (POST body)
 *   - request.url             (high-risk: recovery URL fragments)
 *   - transaction             (route name; usually safe but cheap to scrub)
 *   - breadcrumbs[*].data, .message
 *   - exception.values[*].value (the error message itself)
 */
function scrubEventLoose(event: unknown): unknown {
  if (!event || typeof event !== 'object') return event;
  const e = event as Record<string, unknown>;
  if (e.extra) e.extra = scrubValue(e.extra);
  if (e.contexts) e.contexts = scrubValue(e.contexts);
  if (e.tags) e.tags = scrubValue(e.tags);

  const req = e.request as Record<string, unknown> | undefined;
  if (req) {
    if (req.data) req.data = scrubValue(req.data);
    if (typeof req.url === 'string') req.url = scrubUrl(req.url);
    if (req.headers) req.headers = scrubValue(req.headers);
    if (req.cookies) req.cookies = scrubValue(req.cookies);
    if (typeof req.query_string === 'string') req.query_string = scrubString(req.query_string);
  }
  if (typeof e.transaction === 'string') e.transaction = scrubString(e.transaction);

  const breadcrumbs = e.breadcrumbs as
    | Array<{
        message?: string;
        data?: unknown;
        category?: string;
        level?: string;
      }>
    | undefined;
  if (breadcrumbs) {
    e.breadcrumbs = breadcrumbs.map((bc) => ({
      ...bc,
      message: typeof bc.message === 'string' ? scrubString(bc.message) : bc.message,
      data: bc.data ? scrubValue(bc.data) : bc.data,
    }));
  }
  const exc = e.exception as { values?: Array<{ value?: string }> } | undefined;
  if (exc?.values) {
    exc.values = exc.values.map((ex) => ({
      ...ex,
      value:
        typeof ex.value === 'string'
          ? scrubString(ex.value.length > 4000 ? ex.value.slice(0, 4000) + '…' : ex.value)
          : ex.value,
    }));
  }
  return e;
}

/** Re-export the SDK's capture functions so callers never import @sentry/react
 *  directly , makes it cheap to swap providers later. captureException is a
 *  no-op until initSentry has been called with a configured DSN; the SDK
 *  handles that gracefully (drops the event on the floor).
 */
export const captureException = Sentry.captureException;
export const captureMessage = Sentry.captureMessage;

/**
 * Attach a user-id-only context tag to every subsequent captured event.
 * Pass `null` to clear (called on sign-out).
 *
 * ZKA invariant: only the Supabase auth.uid lands on GlitchTip. Never
 * the email, never the display name, never the IP. The id is opaque to
 * any GlitchTip operator who reads a captured event later.
 */
export function setSentryUser(userId: string | null): void {
  if (userId) {
    Sentry.setUser({ id: userId });
  } else {
    Sentry.setUser(null);
  }
}

/**
 * Attach an org-id tag to every subsequent captured event. Org-scoped
 * issues filter cleanly by this tag in GlitchTip. Same ZKA invariant:
 * only the opaque org id, never the encrypted org name.
 */
export function setSentryOrgTag(orgId: string | null): void {
  if (orgId) {
    Sentry.setTag('org_id', orgId);
  } else {
    Sentry.setTag('org_id', null);
  }
}

/**
 * Emit a navigation / action breadcrumb. Limits to short categories +
 * scrubbed messages so a downstream captured event has trail context
 * without ever shipping decrypted data.
 */
export function addBreadcrumb(opts: {
  category: 'navigation' | 'ui.action' | 'auth' | 'vault' | 'or.proxy' | 'edge';
  message: string;
  level?: 'info' | 'warning' | 'error';
  data?: Record<string, unknown>;
}): void {
  Sentry.addBreadcrumb({
    category: opts.category,
    message: scrubString(opts.message),
    level: opts.level ?? 'info',
    data: opts.data ? (scrubValue(opts.data) as Record<string, unknown>) : undefined,
  });
}
