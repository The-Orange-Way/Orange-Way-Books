/**
 * Shared Edge Function HTTP helpers: CORS, body-size guards, JSON responses.
 *
 * Keep this file dependency-free (no Supabase SDK imports) so every function
 * can import it without pulling an extra chunk.
 */

/** Max JSON body we accept from clients. 256 KB is plenty for every call
 *  site in this repo (exchange-rate params, invites, GraphQL mutations).
 *  Anything larger is either a mistake or hostile. */
export const MAX_BODY_BYTES = 256 * 1024;

/** Hardcoded prod fallback used when ALLOWED_ORIGINS is not set. Better to
 *  serve the canonical Vault origin than to fall back to a wildcard, which
 *  would echo "Access-Control-Allow-Origin: *" on credential-bearing
 *  endpoints. (H7 — 2026-05-19 audit.) */
const PROD_FALLBACK_ORIGIN = 'https://books.orangeway.app';

/** Build the CORS header set. Origins come from the `ALLOWED_ORIGINS`
 *  env var (comma-separated).
 *
 *  Fail-closed behavior: when the request Origin does not appear in the
 *  allowlist, we OMIT the `Access-Control-Allow-Origin` header entirely.
 *  Browsers treat a missing header as a CORS denial — the preflight fails
 *  closed, the response is unusable. The 2026-05-16 audit's A7 finding
 *  noted that returning the canonical origin to an off-list caller is
 *  still surprising (the caller "sees" a successful CORS surface), even
 *  though it carries no credentials. Dropping the header removes that
 *  surprise. (2026-05-27 audit M7.)
 *
 *  When ALLOWED_ORIGINS is unset, fall back to PROD_FALLBACK_ORIGIN — that
 *  branch is for local-dev / Supabase-default ergonomics, not prod. */
export function buildCorsHeaders(req: Request): Record<string, string> {
  const allowedEnv = (Deno.env.get('ALLOWED_ORIGINS') ?? '').trim();
  const origin = req.headers.get('Origin') ?? '';

  const headers: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };

  if (allowedEnv) {
    const list = allowedEnv.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
    }
    // No fallback when env IS set — origin must match exactly or no header.
  } else {
    // Fallback for local dev / preview deploys where ALLOWED_ORIGINS is unset.
    // Echoing the prod origin to every caller is harmless (browsers still
    // gate cross-origin reads when the echoed value does not match the actual
    // caller) but it is a surprise to read. Production deploys MUST set
    // ALLOWED_ORIGINS explicitly so this branch never fires. Surfaced in the
    // 2026-06-11 full review (finding M3).
    headers['Access-Control-Allow-Origin'] = PROD_FALLBACK_ORIGIN;
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
 * body exceeds MAX_BODY_BYTES — the caller should respond with 413.
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
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* ignore */ }
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
