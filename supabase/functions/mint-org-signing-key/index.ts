/**
 * mint-org-signing-key — Supabase Edge Function.
 *
 * Accepts a client-generated ML-DSA-65 Org Signing Key and its
 * per-writer wraps, and records both on the server:
 *
 *   - Insert one `org_signing_keys` row with (org_id, key_version,
 *     public_key_b64, algorithm, created_by = caller).
 *   - Insert one `org_member_signing_key_wraps` row per entry in `wraps[]`,
 *     keyed on (user_id, org_id, key_version).
 *   - Write a `vault_security_events` row for `org.signing_key_minted`.
 *
 * The keypair itself is generated client-side via `src/lib/signing-key.ts`
 * (see `generateAndWrapSigningKey`). This function NEVER sees the private
 * half — only the per-recipient wraps — and NEVER accepts a raw
 * secret from the caller.
 *
 * Authorization: caller must hold `users.invite` in the target org.
 * Custom roles with that capability (Advanced+ tier) are allowed to
 * mint, matching D3's general rule for wrap operations.
 *
 * Request body (JSON):
 *   {
 *     "org_id":        "<uuid>",
 *     "public_key_b64": "<base64>",   // ML-DSA-65 public key, plaintext
 *     "key_version":   1,
 *     "algorithm"?:    "ml-dsa-65",
 *     "wraps": [
 *       { "user_id": "<uuid>", "wrapped_private_key": "<base64>",
 *         "iv": "<base64>", "wrap_algo": "hybrid-kem-v1",
 *         "key_version": 1 }
 *     ]
 *   }
 *
 * Response (200):
 *   { ok: true, org_id, key_version, wrap_count }
 */

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { rateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

// Cap wraps per mint so a pathological client can't submit 10,000 rows
// in one call. 200 is well above any realistic org headcount.
const MAX_WRAPS_PER_MINT = 200;

interface OskWrapInput {
  user_id: string;
  wrapped_private_key: string;
  iv: string;
  wrap_algo: string;
  key_version: number;
}

function isValidWrap(v: unknown): v is OskWrapInput {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.user_id === 'string' &&
    UUID_RE.test(o.user_id) &&
    typeof o.wrapped_private_key === 'string' &&
    o.wrapped_private_key.length > 0 &&
    o.wrapped_private_key.length < 16384 &&
    BASE64_RE.test(o.wrapped_private_key) &&
    typeof o.iv === 'string' &&
    o.iv.length > 0 &&
    o.iv.length < 64 &&
    BASE64_RE.test(o.iv) &&
    typeof o.wrap_algo === 'string' &&
    o.wrap_algo.length < 64 &&
    typeof o.key_version === 'number' &&
    Number.isInteger(o.key_version) &&
    o.key_version > 0
  );
}

serve(async (req) => {
  const cors = buildCorsHeaders(req);
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors });
  }
  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405, cors);
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return jsonResponse({ error: 'Missing Authorization header' }, 401, cors);
    }
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller }, error: authErr } = await callerClient.auth.getUser();
    if (authErr || !caller) {
      return jsonResponse({ error: 'Unauthorized' }, 401, cors);
    }

    const rl = await rateLimit(adminClient, {
      scope: 'mint-org-signing-key',
      subject: caller.id,
      maxPerWindow: 5,
      windowSeconds: 60,
    });
    if (!rl.allowed) {
      return jsonResponse({ error: 'Rate limit exceeded; try again shortly' }, 429, cors);
    }

    const raw = await readBoundedText(req);
    if (raw === null) {
      return jsonResponse({ error: 'Request body too large' }, 413, cors);
    }
    let body: {
      org_id?: unknown;
      public_key_b64?: unknown;
      key_version?: unknown;
      algorithm?: unknown;
      wraps?: unknown;
    };
    try {
      body = JSON.parse(raw | '{}');
    } catch {
      return jsonResponse({ error: 'Invalid JSON' }, 400, cors);
    }

    const orgId = typeof body.org_id === 'string' ? body.org_id.trim() : '';
    if (!orgId || !UUID_RE.test(orgId)) {
      return jsonResponse({ error: 'org_id is required' }, 400, cors);
    }

    const publicKeyB64 = typeof body.public_key_b64 === 'string' ? body.public_key_b64 : '';
    if (!publicKeyB64 || !BASE64_RE.test(publicKeyB64) || publicKeyB64.length < 100) {
      return jsonResponse({ error: 'public_key_b64 must be a base64 ML-DSA-65 public key' }, 400, cors);
    }

    const keyVersion = typeof body.key_version === 'number' ? body.key_version : 1;
    if (!Number.isInteger(keyVersion) || keyVersion < 1) {
      return jsonResponse({ error: 'key_version must be a positive integer' }, 400, cors);
    }

    const algorithm = typeof body.algorithm === 'string' && body.algorithm.length > 0
      ? body.algorithm
      : 'ml-dsa-65';

    if (!Array.isArray(body.wraps)) {
      return jsonResponse({ error: 'wraps must be an array' }, 400, cors);
    }
    if (body.wraps.length === 0) {
      return jsonResponse({ error: 'wraps must contain at least one entry' }, 400, cors);
    }
    if (body.wraps.length > MAX_WRAPS_PER_MINT) {
      return jsonResponse({ error: `Too many wraps (max ${MAX_WRAPS_PER_MINT})` }, 400, cors);
    }
    const wraps: OskWrapInput[] = [];
    for (let i = 0; i < body.wraps.length; i++) {
      if (!isValidWrap(body.wraps[i])) {
        return jsonResponse({ error: `wraps[${i}] failed validation` }, 400, cors);
      }
      const w = body.wraps[i] as OskWrapInput;
      if (w.key_version !== keyVersion) {
        return jsonResponse(
          { error: `wraps[${i}].key_version must match the top-level key_version (${keyVersion})` },
          400, cors,
        );
      }
      wraps.push(w);
    }

    // Caller must hold users.invite in this org.
    const { data: hasCap, error: capErr } = await adminClient.rpc(
      'user_has_capability',
      { p_user_id: caller.id, p_capability: 'users.invite', p_org_id: orgId },
    );
    if (capErr) {
      console.error('mint-org-signing-key capability check failed:', capErr);
      return jsonResponse({ error: 'Failed to authorize caller' }, 500, cors);
    }
    if (!hasCap) {
      return jsonResponse(
        { error: "You don't have permission to mint the Org Signing Key." },
        403, cors,
      );
    }

    // Insert the org_signing_keys row. If a row already exists at this
    // key_version we reject — bumps must use a distinct version.
    const { data: existingKey } = await adminClient
      .from('org_signing_keys')
      .select('key_version')
      .eq('org_id', orgId)
      .eq('key_version', keyVersion)
      .maybeSingle();
    if (existingKey) {
      return jsonResponse(
        { error: `An Org Signing Key already exists at key_version ${keyVersion}. Use a new version to rotate.` },
        409, cors,
      );
    }

    const { error: keyInsertErr } = await adminClient.from('org_signing_keys').insert({
      org_id:         orgId,
      key_version:    keyVersion,
      public_key_b64: publicKeyB64,
      algorithm,
      created_by:     caller.id,
    });
    if (keyInsertErr) {
      console.error('mint-org-signing-key insert public key failed:', keyInsertErr);
      return jsonResponse({ error: 'Failed to record signing key' }, 500, cors);
    }

    // Insert per-recipient wraps. Idempotent (upsert) so a partial
    // previous mint can be resumed without manual cleanup.
    const wrapRows = wraps.map((w) => ({
      user_id:             w.user_id,
      org_id:              orgId,
      key_version:         w.key_version,
      wrapped_private_key: w.wrapped_private_key,
      wrap_algo:           w.wrap_algo,
      iv:                  w.iv,
    }));

    const { error: wrapInsertErr } = await adminClient
      .from('org_member_signing_key_wraps')
      .upsert(wrapRows, { onConflict: 'user_id,org_id,key_version' });
    if (wrapInsertErr) {
      console.error('mint-org-signing-key insert wraps failed:', wrapInsertErr);
      // Roll back the public key row so a retry can start clean.
      await adminClient.from('org_signing_keys')
        .delete()
        .eq('org_id', orgId)
        .eq('key_version', keyVersion);
      return jsonResponse({ error: 'Failed to record wrapped signing keys' }, 500, cors);
    }

    // Audit event.
    try {
      await adminClient.from('vault_security_events').insert({
        user_id: caller.id,
        event: 'org.signing_key_minted',
        metadata: {
          org_id:      orgId,
          key_version: keyVersion,
          algorithm,
          wrap_count:  wraps.length,
        },
      });
    } catch (err) {
      console.warn('mint-org-signing-key audit insert threw:', err);
    }

    return jsonResponse({
      ok: true,
      org_id: orgId,
      key_version: keyVersion,
      wrap_count: wraps.length,
    }, 200, cors);
  } catch (err) {
    console.error('mint-org-signing-key error:', err);
    return jsonResponse({ error: 'Internal error' }, 500, cors);
  }
});
