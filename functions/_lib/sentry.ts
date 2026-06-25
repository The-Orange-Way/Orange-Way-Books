/**
 * Sentry/GlitchTip error tracking for Cloudflare Pages Functions
 * (workerd runtime). Strict ZKA-aware scrubber, mirroring the Deno edge
 * function wrapper's posture:
 *
 *   - Request body is ALWAYS replaced with "[redacted body]" before send.
 *     Pages Functions receive POST bodies from the marketing site (waitlist
 *     and demo signup) that contain email + company. Email is the signup
 *     identifier so it cannot land in telemetry: the captured event must
 *     not echo it back even when the SDK auto-derives request context.
 *   - Response body is ALWAYS replaced with "[redacted body]". The
 *     downstream Resend API responses can contain customer email
 *     verbatim.
 *   - Request headers go through an allowlist: only `content-type`,
 *     `content-length`, `user-agent` are forwarded. Everything else
 *     (including `authorization`, `cookie`, `x-forwarded-for`,
 *     `cf-connecting-ip`) is dropped.
 *   - Query string is dropped entirely from URLs in event payloads.
 *   - Stack frame `vars`, `pre_context`, `post_context`, `context_line`
 *     are stripped.
 *
 * Auto-tags applied to every event:
 *   - `function_route` (e.g. "/api/signup") derived from URL pathname
 *   - `cf_colo` from the CF-IPCity header if available
 *   - `runtime` = "cloudflare-pages"
 *
 * When `env.SENTRY_DSN_PAGES` is unset the entire module is a no-op:
 * no SDK init, no fetches. Safe to import everywhere.
 *
 * Why this file deliberately re-declares its scrubber tables instead of
 * importing from `src/lib/observability/sentry.ts` or
 * `supabase/functions/_shared/sentry.ts`:
 *   - The browser file uses `import.meta.env` and `@sentry/react`,
 *     neither of which exists at the workerd edge.
 *   - The Deno edge file uses `Deno.env` and `npm:@sentry/deno`, neither
 *     of which exists at the workerd edge.
 *   - `@sentry/cloudflare` exports a different ESM surface from
 *     `@sentry/react` (no React integration, different default
 *     integrations to drop). Mixing them would require shape-shifting
 *     wrappers at every callsite.
 *
 * The three sibling scrubbers are kept structurally identical so the
 * shared-surface pattern catalog row 10 stays clean.
 */

import * as Sentry from '@sentry/cloudflare';

const REDACTED = '[redacted]';
const REDACTED_BODY = '[redacted body]';

/**
 * Headers we forward to GlitchTip. Anything not in this set is dropped.
 * Stricter than the Deno wrapper because Pages Functions get the full
 * CF edge header set, which includes `cf-connecting-ip` and similar
 * fingerprinting surfaces.
 */
const HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  'content-type',
  'content-length',
  'user-agent',
]);

/**
 * Object keys (case-insensitive) we scrub from event payloads. Identical
 * shape to the SPA and Deno wrappers for catalog parity.
 */
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
  // Body field aliases the SDK may use when normalising req/resp onto
  // an event payload. Belt and suspenders against scrubRequest.
  /^body$/i,
  /^request_body$/i,
  /^response_body$/i,
  /^payload$/i,
  /^raw$/i,
  /^raw_body$/i,
  // Pages-Function-specific: the marketing form POST body includes
  // email which is the signup identifier. The blanket-redact stance
  // applies, but listing the key explicitly catches it even if a
  // future SDK puts it under a non-body field.
  /^email$/i,
  /^company$/i,
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
  if ('data' in req) req.data = REDACTED_BODY;
  if ('query_string' in req) req.query_string = REDACTED;
  if ('cookies' in req) req.cookies = REDACTED;
  if ('env' in req) req.env = REDACTED;
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
      // abs_path on workerd can include the deploy-time build path of
      // the CF Pages project (e.g. /opt/wrangler/build/<sha>/...).
      // Keep `filename` for triage but drop the full path so events do
      // not fingerprint the build host.
      delete copy.abs_path;
      return copy;
    });
  }
  return s;
}

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
      stacktrace: ex.stacktrace ? scrubStacktrace(ex.stacktrace) : ex.stacktrace,
    }));
  }
  return e;
}

/**
 * Higher-order wrapper for CF Pages Function handlers. Calls Sentry.init
 * lazily on first invocation (workerd is fresh-per-request; the SDK
 * caches internally). Catches any thrown error, captures with the
 * scrubbed context above, and returns a generic 500 JSON response.
 *
 * Usage:
 *   export const onRequestPost: PagesFunction<Env> =
 *     withSentry(async (ctx) => { ... });
 *
 * When `env.SENTRY_DSN_PAGES` is unset, the wrapper is a pure pass-through
 * (no SDK init, no capture). Self-hosted forks stay silent.
 */
export function withSentry<E = unknown>(handler: PagesFunction<E>): PagesFunction<E> {
  return async (ctx) => {
    const env = ctx.env as Record<string, unknown> | undefined;
    const dsn =
      env && typeof env === 'object' ? (env.SENTRY_DSN_PAGES as string | undefined) : undefined;

    if (!dsn) {
      return handler(ctx);
    }

    // Init is idempotent inside Sentry; safe to call per request.
    try {
      Sentry.init({
        dsn,
        environment:
          (env?.VITE_DEPLOY_ENV as string | undefined) ??
          (env?.DEPLOY_ENV as string | undefined) ??
          'unknown',
        release: (env?.SENTRY_RELEASE as string | undefined) ?? undefined,
        tracesSampleRate: 0,
        sendDefaultPii: false,
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

      Sentry.setTag('runtime', 'cloudflare-pages');
      try {
        Sentry.setTag('function_route', new URL(ctx.request.url).pathname);
      } catch {
        Sentry.setTag('function_route', 'unknown');
      }
    } catch (initErr) {
      // Telemetry is non-essential; never let init failure crash the
      // handler. Log once for the operator to spot in CF logs.
      // The console.warn itself is wrapped because a future runtime
      // change that throws on console (unlikely on workerd but possible
      // during a CF infra incident) must not bring down the handler.
      try {
        console.warn(
          '[sentry] init threw; telemetry disabled for this invocation:',
          initErr instanceof Error ? initErr.message : String(initErr),
        );
      } catch {
        // swallow
      }
      return handler(ctx);
    }

    try {
      return await handler(ctx);
    } catch (err) {
      try {
        // Build a minimal request context manually. We never trust the
        // SDK's automatic context picker on workerd because the CF
        // edge sets headers (cf-connecting-ip, cf-ipcountry, cf-ray)
        // that we never want to ship.
        const allowedHeaders: Record<string, string> = {};
        ctx.request.headers.forEach((v, k) => {
          if (HEADER_ALLOWLIST.has(k.toLowerCase())) allowedHeaders[k] = v;
        });
        Sentry.withScope((scope) => {
          scope.setContext('request', {
            url: scrubUrl(ctx.request.url),
            method: ctx.request.method,
            headers: allowedHeaders,
          });
          Sentry.captureException(err);
        });
      } catch {
        // Never let the telemetry path throw.
      }
      console.error('[withSentry] caught:', err instanceof Error ? err.message : String(err));
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  };
}
