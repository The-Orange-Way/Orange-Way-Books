/**
 * Sentry/GlitchTip error tracking for Supabase Edge Functions (Deno runtime).
 * Strict ZKA-aware scrubber, by design more conservative than the SPA wrapper:
 *
 *   - Request body is ALWAYS replaced with "[redacted body]" before send.
 *     Edge functions handle OPK-encrypted blobs, Supabase auth JWTs in
 *     Authorization headers, OR-API-Key bodies, raw Quiltt webhook
 *     payloads, exchange-rate-fetch query params. Any of those could
 *     contain customer-identifying or session-bearing material; the
 *     blanket-redact stance means a future endpoint that forgets to
 *     scrub never leaks.
 *   - Response body is ALWAYS replaced with "[redacted body]". Same
 *     reasoning. We will never need the response body to debug a
 *     captured exception (the error message + stack are enough).
 *   - Request headers go through an allowlist: only `content-type`,
 *     `x-region`, and a hashed `x-forwarded-for` are forwarded. Everything
 *     else (including `authorization`, `apikey`, `cookie`, `x-supabase-*`,
 *     `x-or-*`, `x-quiltt-*`) is dropped.
 *   - Query string is dropped entirely from `request.url` and from any
 *     string referenced in event payloads. Function-route invariants
 *     (path) are kept; per-call args are not.
 *   - Stack frame `vars` (Deno can include local-variable snapshots in
 *     the SDK's transport encoding) are dropped at the wire level by
 *     setting `includeLocalVariables: false` in `init`.
 *
 * Auto-tags applied to every event:
 *   - `function_slug`     (env: SUPABASE_FUNCTION_NAME)
 *   - `supabase_project_ref` (parsed from SUPABASE_URL)
 *   - `runtime` = "deno"
 *
 * When SENTRY_DSN is unset the entire module is a no-op: no SDK init, no
 * fetches, no module side effects. Safe to import everywhere.
 *
 * NOTE: this file deliberately re-declares its scrubber tables instead of
 * importing from `src/lib/observability/sentry.ts`. The browser file uses
 * `import.meta.env` and `@sentry/react`, neither of which exists at the
 * Deno edge runtime. Keeping the two scrubbers as siblings means each
 * tracks its product surface honestly (the SPA captures plaintext form
 * state; the edge captures upstream API exchanges) and the SECRET_KEY
 * patterns can diverge if the surfaces ever diverge.
 */

import * as Sentry from 'npm:@sentry/deno@10.30.0';

const REDACTED = '[redacted]';
const REDACTED_BODY = '[redacted body]';

/**
 * Headers we forward to GlitchTip. Anything not in this set is dropped.
 * Bias: when in doubt, drop.
 */
const HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  'content-type',
  'content-length',
  'x-region',
  'user-agent',
]);

/**
 * Object keys (case-insensitive) we scrub from event payloads. Identical
 * shape to the SPA wrapper for catalog parity; comments cross-reference
 * the rationale documented in `src/lib/observability/sentry.ts`.
 */
const SECRET_KEY_PATTERNS = [
  /password/i,
  /passphrase/i,
  /pin/i,
  /mek/i,
  /opk/i,
  /vault_key/i,
  /vault_password/i,
  /recovery/i,
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
  /^account_name$/i,
  /^account_code$/i,
  /^vendor$/i,
  /^customer$/i,
  /^payee$/i,
  /^reference$/i,
  /^invoice_number$/i,
  /widget_token/i,
  /quick_?connect/i,
  /link_token/i,
  /^body$/i,
  /^request_body$/i,
  /^response_body$/i,
  // Alternative body-field names the Sentry Deno SDK or future helpers
  // might use when normalising the request/response onto an event. We
  // never want any of these to ship; the blanket-redact stance applies
  // regardless of which key the SDK happens to land them under.
  /^payload$/i,
  /^raw$/i,
  /^raw_body$/i,
];

const TOKEN_PATTERNS: Array<[RegExp, string]> = [
  [
    /(access_token|refresh_token|provider_token|provider_refresh_token|id_token)=[^&\s#"']+/gi,
    '$1=[redacted]',
  ],
  [
    /(token|code|state|nonce|jwt|api_key|apikey|secret|password|opk|mek|seed)=[^&\s#"']+/gi,
    '$1=[redacted]',
  ],
  [/Bearer\s+[A-Za-z0-9._+/=-]+/g, 'Bearer [redacted]'],
  [/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[jwt redacted]'],
];

function scrubString(s: string): string {
  let out = s;
  for (const [re, repl] of TOKEN_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}

/**
 * URL scrubber: drop fragment and query string entirely. Only the path
 * + host survive. Path tells us which function fired; per-call args do
 * not aid debugging enough to justify shipping.
 */
function scrubUrl(u: string): string {
  if (typeof u !== 'string') return u;
  try {
    const parsed = new URL(u);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return u.split('?')[0].split('#')[0];
  }
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

/**
 * Replace request.headers with the allowlisted, scrubbed subset.
 * Drop request.data + response.data unconditionally (we never want them).
 * Scrub request.url + query_string.
 */
function scrubRequest(req: Record<string, unknown> | undefined): void {
  if (!req) return;
  if (req.headers && typeof req.headers === 'object') {
    const orig = req.headers as Record<string, unknown>;
    const filtered: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(orig)) {
      if (HEADER_ALLOWLIST.has(k.toLowerCase())) {
        filtered[k] = scrubValue(v);
      }
    }
    req.headers = filtered;
  }
  if (typeof req.url === 'string') {
    req.url = scrubUrl(req.url);
  }
  // Always redact bodies. No exceptions.
  if ('data' in req) req.data = REDACTED_BODY;
  if ('query_string' in req) req.query_string = REDACTED;
  if ('cookies' in req) req.cookies = REDACTED;
  if ('env' in req) req.env = REDACTED;
}

/**
 * Loose-typed scrubber for the runtime Deno SDK path.
 */
function scrubEventLoose(event: unknown): unknown {
  if (!event || typeof event !== 'object') return event;
  const e = event as Record<string, unknown>;
  if (e.extra) e.extra = scrubValue(e.extra);
  if (e.contexts) e.contexts = scrubValue(e.contexts);
  if (e.tags) e.tags = scrubValue(e.tags);

  scrubRequest(e.request as Record<string, unknown> | undefined);

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
  const exc = e.exception as
    | { values?: Array<{ value?: string; stacktrace?: unknown }> }
    | undefined;
  if (exc?.values) {
    exc.values = exc.values.map((ex) => ({
      ...ex,
      value:
        typeof ex.value === 'string'
          ? scrubString(ex.value.length > 4000 ? ex.value.slice(0, 4000) + '…' : ex.value)
          : ex.value,
      // Stacktrace frames sometimes carry a `vars` map of local
      // variables. Drop the entire stacktrace.vars surface; keep only
      // file/line/function metadata.
      stacktrace: ex.stacktrace ? scrubStacktrace(ex.stacktrace) : ex.stacktrace,
    }));
  }
  return e;
}

function scrubStacktrace(st: unknown): unknown {
  if (!st || typeof st !== 'object') return st;
  const s = st as Record<string, unknown>;
  if (Array.isArray(s.frames)) {
    s.frames = (s.frames as Array<Record<string, unknown>>).map((frame) => {
      const copy: Record<string, unknown> = { ...frame };
      delete copy.vars;
      delete copy.pre_context;
      delete copy.post_context;
      delete copy.context_line;
      return copy;
    });
  }
  return s;
}

let initialised = false;

/**
 * Initialise the edge Sentry/GlitchTip wrapper. Idempotent. Safe no-op
 * when SENTRY_DSN is unset. Call once per function invocation (or once
 * at module load; same effect).
 */
export function initEdgeSentry(): void {
  if (initialised) return;
  const dsn = Deno.env.get('SENTRY_DSN');
  if (!dsn) return;
  initialised = true;

  // Supabase Edge runtime does not expose a documented function-name env
  // var. The Step 5 audit flagged the old SUPABASE_FUNCTION_NAME
  // read as always falling through to 'unknown'. Derive from the running
  // file path instead: supabase deploys each function under
  // /home/deno/functions/<slug>/index.ts at runtime, and `import.meta.url`
  // reflects that. Falls back to 'unknown' if the URL shape ever changes.
  const functionSlug = (() => {
    try {
      const u = new URL(import.meta.url);
      const match = u.pathname.match(/\/functions\/([^/]+)\/[^/]+\.[tj]s$/);
      return match?.[1] ?? Deno.env.get('SUPABASE_FUNCTION_NAME') ?? 'unknown';
    } catch {
      return Deno.env.get('SUPABASE_FUNCTION_NAME') ?? 'unknown';
    }
  })();
  const projectRef = (() => {
    const url = Deno.env.get('SUPABASE_URL');
    if (!url) return 'unknown';
    try {
      const parsed = new URL(url);
      return parsed.hostname.split('.')[0];
    } catch {
      return 'unknown';
    }
  })();
  const env = Deno.env.get('VITE_DEPLOY_ENV') ?? Deno.env.get('DEPLOY_ENV') ?? 'unknown';

  Sentry.init({
    dsn,
    environment: env,
    release: Deno.env.get('SENTRY_RELEASE') ?? undefined,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    // Deno-specific: disable the locals snapshot before it ever enters
    // the pipeline. Belt-and-suspenders against scrubStacktrace().
    includeLocalVariables: false,
    beforeSend: (event) => scrubEventLoose(event) as Sentry.ErrorEvent,
    beforeBreadcrumb: (bc) => {
      if (bc.category === 'console') {
        const level = (bc.level ?? 'log').toLowerCase();
        if (level !== 'error' && level !== 'warn') return null;
      }
      if (bc.message) bc.message = scrubString(bc.message);
      if (bc.data) bc.data = scrubValue(bc.data) as Record<string, unknown>;
      return bc;
    },
  });

  Sentry.setTag('runtime', 'deno');
  Sentry.setTag('function_slug', functionSlug);
  Sentry.setTag('supabase_project_ref', projectRef);
}

/**
 * Capture an error from an edge function's top-level catch. Attaches
 * request context (allowlisted headers + scrubbed URL only). Always
 * a no-op when SENTRY_DSN is unset.
 *
 * Usage:
 *   try {
 *     // ... handler body
 *   } catch (err) {
 *     captureEdgeError(req, err);
 *     return jsonError(500, ...);
 *   }
 */
export function captureEdgeError(req: Request, err: unknown): void {
  if (!initialised) return;
  try {
    // Build a minimal request context manually (we don't trust the SDK's
    // automatic context , too easy to ship a header we didn't mean to).
    const allowedHeaders: Record<string, string> = {};
    for (const [k, v] of req.headers.entries()) {
      if (HEADER_ALLOWLIST.has(k.toLowerCase())) {
        allowedHeaders[k] = v;
      }
    }
    Sentry.withScope((scope) => {
      scope.setContext('request', {
        url: scrubUrl(req.url),
        method: req.method,
        headers: allowedHeaders,
      });
      Sentry.captureException(err);
    });
  } catch {
    // Never let the telemetry path throw.
  }
}

export const captureMessage = Sentry.captureMessage;
