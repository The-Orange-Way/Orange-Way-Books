/**
 * Flash API client wrapper. Single module for all Flash Connect calls
 * made by edge functions. Never exposed to the browser.
 *
 *
 * Env vars consumed:
 *   FLASH_BASE_URL              — defaults to https://api.paywithflash.com
 *   FLASH_CLIENT_ID             — confidential client id
 *   FLASH_CLIENT_SECRET         — confidential client secret
 *   FLASH_OAUTH_TOKEN_URL       — optional override; defaults to
 *                                 `${FLASH_BASE_URL}/flash-connect/oauth/token`
 *   MOCK_FLASH                  — when 'true', return deterministic fakes
 *
 * NOTE: spec gaps Bram still needs to confirm. When his email lands,
 * the swap surface is small:
 *   - response shape of POST /payment-links → parsePaymentLinkResponse()
 *   - exact endpoint path for /payment-links → PAYMENT_LINKS_PATH
 *   - response shape of /oauth/token       → parseTokenResponse()
 */

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const DEFAULT_BASE_URL = 'https://api.paywithflash.com';
const PAYMENT_LINKS_PATH = '/payment-links';
const REFRESH_SAFETY_WINDOW_MS = 5 * 60 * 1000;

export interface FlashTokens {
  access_token: string;
  refresh_token: string;
  expires_at: string;
  scopes: string[];
}

export interface CreatePaymentLinkInput {
  amountCents: number;
  currency: string;
  description: string;
  externalReference: string;
  expiresInSeconds: number;
}

export interface PaymentLinkResult {
  id: string;
  url: string;
  expiresAt: string;
}

function baseUrl(): string {
  return (Deno.env.get('FLASH_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

function tokenUrl(): string {
  return Deno.env.get('FLASH_OAUTH_TOKEN_URL')
    ?? `${baseUrl()}/flash-connect/oauth/token`;
}

function isMock(): boolean {
  return (Deno.env.get('MOCK_FLASH') ?? '').toLowerCase() === 'true';
}

function parseTokenResponse(json: any): { access_token: string; refresh_token: string; expires_in: number; scope?: string } {
  if (!json | typeof json.access_token !== 'string' | typeof json.refresh_token !== 'string') {
    throw new Error('Flash token response missing access_token / refresh_token');
  }
  const expiresIn = Number(json.expires_in);
  if (!Number.isFinite(expiresIn) | expiresIn <= 0) {
    throw new Error('Flash token response missing valid expires_in');
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_in: expiresIn,
    scope: typeof json.scope === 'string' ? json.scope : undefined,
  };
}

function parsePaymentLinkResponse(json: any): PaymentLinkResult {
  // Spec gap: exact shape TBD. Accept a couple of likely casings.
  const id = json?.id ?? json?.paymentLinkId ?? json?.payment_link_id;
  const url = json?.url ?? json?.paymentUrl ?? json?.payment_url;
  const expiresAt = json?.expiresAt ?? json?.expires_at;
  if (typeof id !== 'string' | typeof url !== 'string') {
    throw new Error('Flash /payment-links response missing id or url');
  }
  return {
    id,
    url,
    expiresAt: typeof expiresAt === 'string' ? expiresAt : new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  };
}

async function refreshTokens(admin: SupabaseClient, current: FlashTokens): Promise<FlashTokens> {
  if (isMock()) {
    const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
    const fresh: FlashTokens = {
      access_token: 'mock-access-' + crypto.randomUUID(),
      refresh_token: current.refresh_token,
      expires_at: expiresAt,
      scopes: current.scopes,
    };
    await persistTokens(admin, fresh);
    return fresh;
  }

  const clientId = Deno.env.get('FLASH_CLIENT_ID');
  const clientSecret = Deno.env.get('FLASH_CLIENT_SECRET');
  if (!clientId | !clientSecret) {
    throw new Error('FLASH_CLIENT_ID / FLASH_CLIENT_SECRET not configured');
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refresh_token,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Flash token refresh failed: ${res.status} ${detail.slice(0, 400)}`);
  }
  const parsed = parseTokenResponse(await res.json());
  const fresh: FlashTokens = {
    access_token: parsed.access_token,
    refresh_token: parsed.refresh_token,
    expires_at: new Date(Date.now() + parsed.expires_in * 1000).toISOString(),
    scopes: parsed.scope ? parsed.scope.split(/\s+/).filter(Boolean) : current.scopes,
  };
  await persistTokens(admin, fresh);
  return fresh;
}

async function persistTokens(admin: SupabaseClient, t: FlashTokens): Promise<void> {
  const { error } = await admin
    .from('flash_platform_tokens')
    .upsert({
      id: 'singleton',
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      expires_at: t.expires_at,
      scopes: t.scopes,
      updated_at: new Date().toISOString(),
    });
  if (error) throw new Error(`flash_platform_tokens upsert failed: ${error.message}`);
}

export async function getValidAccessToken(admin: SupabaseClient): Promise<string> {
  const { data, error } = await admin
    .from('flash_platform_tokens')
    .select('access_token, refresh_token, expires_at, scopes')
    .eq('id', 'singleton')
    .maybeSingle();
  if (error) throw new Error(`flash_platform_tokens lookup failed: ${error.message}`);
  if (!data) throw new Error('Flash is not connected: no platform token row');

  const expiresAtMs = new Date(data.expires_at).getTime();
  if (expiresAtMs - Date.now() < REFRESH_SAFETY_WINDOW_MS) {
    const fresh = await refreshTokens(admin, data as FlashTokens);
    return fresh.access_token;
  }
  return data.access_token;
}

export async function flashFetch(
  admin: SupabaseClient,
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  const token = await getValidAccessToken(admin);
  const url = `${baseUrl()}${path.startsWith('/') ? '' : '/'}${path}`;
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/json',
    ...(opts.headers ?? {}),
  };
  let body: BodyInit | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  return await fetch(url, { method: opts.method ?? 'GET', headers, body });
}

export async function createPaymentLink(
  admin: SupabaseClient,
  input: CreatePaymentLinkInput,
): Promise<PaymentLinkResult> {
  if (isMock()) {
    const id = crypto.randomUUID();
    const mockHost = Deno.env.get('MOCK_FLASH_PUBLIC_URL') ?? 'http://localhost:8787';
    return {
      id,
      url: `${mockHost}/pay/${id}?ext=${encodeURIComponent(input.externalReference)}&amt=${input.amountCents}&cur=${input.currency}`,
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000).toISOString(),
    };
  }

  const res = await flashFetch(admin, PAYMENT_LINKS_PATH, {
    method: 'POST',
    body: {
      amount: input.amountCents,
      currency: input.currency,
      description: input.description,
      externalReference: input.externalReference,
      expiresInSeconds: input.expiresInSeconds,
    },
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Flash /payment-links failed: ${res.status} ${detail.slice(0, 400)}`);
  }
  return parsePaymentLinkResponse(await res.json());
}
