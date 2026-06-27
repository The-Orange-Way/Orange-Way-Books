/**
 * Shared Edge Function HTTP helpers: CORS, body-size guards, JSON responses,
 * and the standard error-capture path that routes uncaught exceptions to
 * GlitchTip with the ZKA-aware scrubber applied.
 *
 * Keep this file dependency-free (no Supabase SDK imports) so every function
 * can import it without pulling an extra chunk. The Sentry import below is
 * tree-shaken on builds where SENTRY_DSN is not configured (the wrapper
 * module is a no-op).
 */

import { captureEdgeError, initEdgeSentry } from './sentry.ts';

// Initialise on module load. The wrapper is a no-op when SENTRY_DSN is
// unset, so importing _shared/http carries no cost on builds without
// observability wired up.
//
// Wrapped in try/catch: a malformed SENTRY_DSN (or a future SDK change
// that throws on init) must never crash every function's cold start.
// Telemetry is non-essential; the catch swallows the error after a
// single warn line so a self-hoster sees a signal in function logs
// without taking down their workload.
try {
  initEdgeSentry();
} catch (err) {
  console.warn(
    '[sentry] initEdgeSentry threw at module load; telemetry disabled for this invocation:',
    err instanceof Error ? err.message : String(err),
  );
}

/** Max JSON body we accept from clients. 256 KB is plenty for every call
 *  site in this repo (exchange-rate params, invites, GraphQL mutations).
 *  Anything larger is either a mistake or hostile. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Build the CORS header set. Origins come from the `ALLOWED_ORIGINS`
 *  env var (comma-separated). The function is fully fail-closed:
 *
 *  - If ALLOWED_ORIGINS is unset OR empty, we OMIT
 *    `Access-Control-Allow-Origin` for every request. Browsers treat the
 *    missing header as a CORS denial, so cross-origin callers fail to read
 *    the response. We also log a warning so a self-hoster who forgot to
 *    configure the var sees a clear signal in the function logs instead of
 *    a surprising "it just works" with an undocumented fallback origin.
 *  - If ALLOWED_ORIGINS is set and the request Origin matches one of its
 *    comma-separated entries exactly, we echo that Origin back. Otherwise
 *    we omit the header.
 *
 *  Previous behavior fell back to a hardcoded prod origin when the env
 *  var was unset. That was correct in spirit (better than `*`) but
 *  surprising on read: a misconfigured self-hosted deployment got a
 *  successful-looking CORS surface for a domain it had no relationship
 *  to. Hardened 2026-06 to fail-closed.
 *
 *  Migration note: any self-hosted OWB deployment MUST set
 *  ALLOWED_ORIGINS to the comma-separated list of origins its web app
 *  serves from (e.g. "https://books.example.com" or
 *  "http://localhost:5173" for local dev). The previous fallback was
 *  not documented in `.env.example`, so any deployment relying on it
 *  was already at risk of breaking the next time the prod origin
 *  changed. */
export function buildCorsHeaders(req: Request): Record<string, string> {
  const allowedEnv = (Deno.env.get('ALLOWED_ORIGINS') ?? '').trim();
  const origin = req.headers.get('Origin') ?? '';

  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };

  if (!allowedEnv) {
    // Fail-closed: missing config means missing header. Log once per
    // cold-start so a self-hoster sees the signal.
    console.warn(
      '[cors] ALLOWED_ORIGINS is unset. Cross-origin requests will fail CORS. ' +
        'Set ALLOWED_ORIGINS in the Supabase Edge Function Secrets to a comma-' +
        'separated list of origins your web app serves from.',
    );
    return headers;
  }

  const list = allowedEnv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (list.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function jsonResponse(
  body: unknown,
  status: number,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

/**
 * Read the request body as text with a hard size cap. Returns null when the
 * body exceeds MAX_BODY_BYTES , the caller should respond with 413.
 *
 * We prefer Content-Length as a fast path but still enforce the cap while
 * streaming in case a client omits the header.
 */
export async function readBoundedText(req: Request): Promise<string | null> {
  const contentLength = Number(req.headers.get('Content-Length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return null;
  }

  if (!req.body) return '';

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        return null;
      }
      chunks.push(value);
    }
  }

  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

/**
 * Wrap a function handler so any thrown error is captured to GlitchTip
 * (scrubbed via captureEdgeError) and converted to a 500 JSON response.
 * The handler still controls all success-path responses. No-op when
 * SENTRY_DSN is unset (capture path is internally a no-op).
 *
 * Usage:
 *   Deno.serve(withErrorCapture(async (req) => {
 *     // ... your handler body
 *     return jsonResponse(req, { ok: true });
 *   }));
 */
export function withErrorCapture(
  handler: (req: Request) => Promise<Response> | Response,
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    try {
      return await handler(req);
    } catch (err) {
      captureEdgeError(req, err);
      const message = err instanceof Error ? err.message : 'Internal error';
      // Never echo unsanitized error.message verbatim if it could carry
      // upstream-leak detail. The captureEdgeError above stored the full
      // error in GlitchTip for triage; the client gets a generic 500.
      console.error('[withErrorCapture] caught:', message);
      return jsonResponse({ error: 'Internal Server Error' }, 500, buildCorsHeaders(req));
    }
  };
}
