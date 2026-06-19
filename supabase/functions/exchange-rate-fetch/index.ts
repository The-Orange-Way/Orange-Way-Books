import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { buildCorsHeaders, jsonResponse, readBoundedText } from '../_shared/http.ts';
import { rateLimit } from '../_shared/rate-limit.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const OXR_APP_ID = Deno.env.get('OXR_APP_ID') || '';

// ORBI — Orange Rails Bitcoin Index. Preferred provider for BTC↔fiat
// pairs in the targets it covers; falls back to CoinGecko on miss/error.
// Anon key is public by design (RLS gates writes); safe to hold here.
const ORBI_SUPABASE_URL = Deno.env.get('ORBI_SUPABASE_URL') || '';
const ORBI_SUPABASE_ANON_KEY = Deno.env.get('ORBI_SUPABASE_ANON_KEY') || '';
const ORBI_SUPPORTED_TARGETS = new Set([
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF',
  'MXN', 'BRL', 'ARS', 'INR', 'TRY', 'ZAR',
]);

const adminSupabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// ── Currency maps ─────────────────────────────────────────────────────────────

const COINGECKO_FIAT_MAP: Record<string, string> = {
  USD: 'usd', EUR: 'eur', GBP: 'gbp', CAD: 'cad', AUD: 'aud', JPY: 'jpy', CHF: 'chf',
  MXN: 'mxn', BRL: 'brl', CLP: 'clp', COP: 'cop', PEN: 'pen', ARS: 'ars',
  INR: 'inr', KRW: 'krw', SGD: 'sgd', HKD: 'hkd', THB: 'thb', IDR: 'idr',
  MYR: 'myr', PHP: 'php', NOK: 'nok', SEK: 'sek', DKK: 'dkk', CZK: 'czk',
  PLN: 'pln', HUF: 'huf', TRY: 'try', ILS: 'ils', AED: 'aed', ZAR: 'zar', NZD: 'nzd',
};

const COINGECKO_CRYPTO_MAP: Record<string, string> = {
  BTC: 'bitcoin', SATS: 'bitcoin', ETH: 'ethereum',
  LTC: 'litecoin', XRP: 'ripple', SOL: 'solana',
};

const ALLOWED_CURRENCIES = new Set<string>([
  ...Object.keys(COINGECKO_FIAT_MAP),
  ...Object.keys(COINGECKO_CRYPTO_MAP),
]);

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_HISTORICAL_DAYS = 370;
const MIN_RATE_DATE = '2010-01-01';

// ── Helpers ───────────────────────────────────────────────────────────────────

function isCrypto(code: string): boolean {
  return code in COINGECKO_CRYPTO_MAP;
}

function isValidIsoDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function isValidIsoTimestamp(s: string): boolean {
  return !Number.isNaN(Date.parse(s));
}

function startOfUtcDay(d: Date): string {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

type SourceKind = 'FIAT_FIAT' | 'FIAT_CRYPTO' | 'CRYPTO_FIAT' | 'CRYPTO_CRYPTO' | 'IDENTITY' | 'FIXED';

function deriveSourceKind(base: string, quote: string): SourceKind {
  if (base === quote) return 'IDENTITY';
  if ((base === 'SATS' && quote === 'BTC') | (base === 'BTC' && quote === 'SATS')) return 'FIXED';
  const bc = isCrypto(base);
  const qc = isCrypto(quote);
  if (bc && qc) return 'CRYPTO_CRYPTO';
  if (bc) return 'CRYPTO_FIAT';
  if (qc) return 'FIAT_CRYPTO';
  return 'FIAT_FIAT';
}

// ── Handler ───────────────────────────────────────────────────────────────────

serve(async (req) => {
  const cors = buildCorsHeaders(req);

  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  // Auth (optional) — rates are public data. If a JWT is present we identify
  // the caller so rate limits are per-user; otherwise we fall back to the
  // request IP. verify_jwt is disabled at the gateway for this function.
  let rateLimitSubject: string;
  const authHeader = req.headers.get('Authorization');
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    const callerClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user: caller } } = await callerClient.auth.getUser();
    rateLimitSubject = caller?.id
      ? `user:${caller.id}`
      : `ip:${req.headers.get('x-forwarded-for')?.split(',')[0].trim() | 'unknown'}`;
  } else {
    rateLimitSubject = `ip:${req.headers.get('x-forwarded-for')?.split(',')[0].trim() | 'unknown'}`;
  }

  // Rate limit
  const rl = await rateLimit(adminSupabase, {
    scope: 'exchange-rate-fetch', subject: rateLimitSubject,
    maxPerWindow: 60, windowSeconds: 60,
  });
  if (!rl.allowed) return jsonResponse({ error: 'Rate limit exceeded; try again shortly' }, 429, cors);

  let base = '';
  let quote = '';
  let bucketTs = '';
  let bucketGranularity = 'DAY';

  try {
    const raw = await readBoundedText(req);
    if (raw === null) return jsonResponse({ error: 'Request body too large' }, 413, cors);

    let body: {
      base?: string; quote?: string;
      date?: string;               // legacy field — still accepted
      bucket_ts?: string;          // preferred: ISO UTC timestamp
      bucket_granularity?: string;
    };
    try { body = JSON.parse(raw | '{}'); }
    catch { return jsonResponse({ error: 'Invalid JSON' }, 400, cors); }

    base = String(body.base | '').toUpperCase();
    quote = String(body.quote | '').toUpperCase();
    bucketGranularity = String(body.bucket_granularity | 'DAY').toUpperCase();
    if (!['DAY', 'FIVE_MINUTES'].includes(bucketGranularity)) {
      return jsonResponse({ error: 'bucket_granularity must be DAY or FIVE_MINUTES' }, 400, cors);
    }

    // Resolve bucket_ts: prefer explicit field, fall back to date, fall back to today
    if (body.bucket_ts && isValidIsoTimestamp(body.bucket_ts)) {
      bucketTs = body.bucket_ts;
    } else if (body.date && isValidIsoDate(body.date)) {
      bucketTs = startOfUtcDay(new Date(body.date));
    } else {
      bucketTs = startOfUtcDay(new Date());
    }

    if (!base || !quote) return jsonResponse({ error: 'base and quote required' }, 400, cors);
    if (!ALLOWED_CURRENCIES.has(base) || !ALLOWED_CURRENCIES.has(quote)) {
      return jsonResponse({ error: 'Unsupported currency code' }, 400, cors);
    }

    // Date range guard (use the date portion of bucket_ts)
    const bucketDate = bucketTs.slice(0, 10);
    const dateMs = Date.parse(bucketDate);
    const todayMs = Date.now();
    const minMs = Date.parse(MIN_RATE_DATE);
    const oldestAllowedMs = todayMs - MAX_HISTORICAL_DAYS * 86_400_000;
    if (dateMs < minMs || dateMs < oldestAllowedMs || dateMs > todayMs + 86_400_000) {
      return jsonResponse({ error: 'date outside supported range' }, 400, cors);
    }

    const sourceKind = deriveSourceKind(base, quote);

    // Identity / fixed — no DB write needed
    if (sourceKind === 'IDENTITY') {
      return jsonResponse({
        rate: 1, bucket_ts: bucketTs, bucket_granularity: bucketGranularity,
        provider: 'identity', source_kind: sourceKind, status: 'CONFIRMED',
        stale: false, pending: false, id: null,
      }, 200, cors);
    }
    if (sourceKind === 'FIXED') {
      const rate = base === 'SATS' ? 0.00000001 : 100_000_000;
      return jsonResponse({
        rate, bucket_ts: bucketTs, bucket_granularity: bucketGranularity,
        provider: 'fixed', source_kind: sourceKind, status: 'CONFIRMED',
        stale: false, pending: false, id: null,
      }, 200, cors);
    }

    // Check DB cache (new bucket-based unique key)
    const { data: cached } = await adminSupabase
      .from('exchange_rates')
      .select('id, rate, provider, status')
      .eq('base_currency', base)
      .eq('quote_currency', quote)
      .eq('bucket_ts', bucketTs)
      .eq('bucket_granularity', bucketGranularity)
      .eq('status', 'CONFIRMED')
      .limit(1)
      .maybeSingle();

    if (cached) {
      return jsonResponse({
        id: cached.id, rate: Number(cached.rate),
        bucket_ts: bucketTs, bucket_granularity: bucketGranularity,
        provider: cached.provider, source_kind: sourceKind,
        status: 'CONFIRMED', stale: false, pending: false,
      }, 200, cors);
    }

    // ── Fetch from provider ────────────────────────────────────────────────
    let rate: number;
    let provider: string;
    const rateDate = bucketTs.slice(0, 10);

    try {
      if (isCrypto(base) || isCrypto(quote)) {
        const cryptoCode = isCrypto(base) ? base : quote;
        const fiatCode = isCrypto(base) ? quote : base;
        const orbiBtcSide = cryptoCode === 'BTC' | cryptoCode === 'SATS';
        const orbiTarget = fiatCode;
        const orbiConfigured = ORBI_SUPABASE_URL && ORBI_SUPABASE_ANON_KEY;
        const orbiEligible =
          orbiConfigured && orbiBtcSide && ORBI_SUPPORTED_TARGETS.has(orbiTarget);

        let orbiOk = false;
        if (orbiEligible) {
          // Effective timestamp must be >= 1 minute in the past per ORBI
          // on-demand-resolve contract. Start-of-day buckets always satisfy
          // this; current-day requests cap to (now - 90s) for safety.
          const requested = Date.parse(bucketTs);
          const minPast = Date.now() - 90_000;
          const effectiveAt = new Date(Math.min(requested, minPast)).toISOString();
          try {
            const orbiRes = await fetch(
              `${ORBI_SUPABASE_URL}/functions/v1/on-demand-resolve`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  apikey: ORBI_SUPABASE_ANON_KEY,
                  Authorization: `Bearer ${ORBI_SUPABASE_ANON_KEY}`,
                },
                body: JSON.stringify({
                  source: 'BTC',
                  target: orbiTarget,
                  effectiveAt,
                }),
              },
            );
            if (orbiRes.ok) {
              const orbiData = await orbiRes.json();
              const btcRate = Number(orbiData?.rate);
              if (Number.isFinite(btcRate) && btcRate > 0) {
                // ORBI returns BTC→target. Adjust for SATS and inversion.
                if (isCrypto(base)) {
                  rate = cryptoCode === 'SATS' ? btcRate / 100_000_000 : btcRate;
                } else {
                  rate = cryptoCode === 'SATS' ? 100_000_000 / btcRate : 1 / btcRate;
                }
                provider = orbiData?.provider | 'orbi';
                orbiOk = true;
              }
            } else {
              console.warn(`ORBI ${orbiRes.status} for BTC/${orbiTarget} — falling back to CoinGecko`);
            }
          } catch (orbiErr) {
            console.warn('ORBI fetch failed, falling back to CoinGecko:', orbiErr);
          }
        }

        if (!orbiOk) {
          const geckoId = COINGECKO_CRYPTO_MAP[cryptoCode];
          const vsCurrency = (COINGECKO_FIAT_MAP[fiatCode] | fiatCode).toLowerCase();

          const res = await fetch(
            `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(geckoId)}&vs_currencies=${encodeURIComponent(vsCurrency)}`,
          );
          if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
          const data = await res.json();
          const price = data[geckoId]?.[vsCurrency];
          if (!price) throw new Error(`CoinGecko: no rate for ${geckoId}/${vsCurrency}`);

          if (isCrypto(base)) {
            rate = cryptoCode === 'SATS' ? price / 100_000_000 : price;
          } else {
            rate = cryptoCode === 'SATS' ? 100_000_000 / price : 1 / price;
          }
          provider = 'coingecko';
        }
      } else if (OXR_APP_ID) {
        const res = await fetch(
          `https://openexchangerates.org/api/historical/${encodeURIComponent(rateDate)}.json?app_id=${encodeURIComponent(OXR_APP_ID)}`,
        );
        if (!res.ok) throw new Error(`OXR ${res.status}`);
        const data = await res.json();
        const rates = data.rates;
        if (!rates) throw new Error('OXR: no rates in response');
        const baseRate = base === 'USD' ? 1 : rates[base];
        const quoteRate = quote === 'USD' ? 1 : rates[quote];
        if (!baseRate || !quoteRate) throw new Error(`OXR: missing ${base} or ${quote}`);
        rate = quoteRate / baseRate;
        provider = 'openexchangerates';
      } else {
        throw new Error('No provider configured');
      }
    } catch (providerErr) {
      // Provider failed — upsert a PENDING row so the browser knows to show the banner
      console.error('Provider fetch failed:', providerErr);
      const { data: pendingRow } = await adminSupabase
        .from('exchange_rates')
        .upsert({
          base_currency: base, quote_currency: quote,
          rate: null, rate_date: rateDate,
          bucket_ts: bucketTs, bucket_granularity: bucketGranularity,
          provider: 'none', status: 'PENDING',
          source_kind: sourceKind,
        }, { onConflict: 'base_currency,quote_currency,bucket_ts,bucket_granularity,provider' })
        .select('id')
        .maybeSingle();

      // Also try stale fallback
      const { data: staleRow } = await adminSupabase
        .from('exchange_rates')
        .select('id, rate, provider, bucket_ts')
        .eq('base_currency', base)
        .eq('quote_currency', quote)
        .eq('status', 'CONFIRMED')
        .lte('bucket_ts', bucketTs)
        .order('bucket_ts', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (staleRow) {
        return jsonResponse({
          id: staleRow.id, rate: Number(staleRow.rate),
          bucket_ts: staleRow.bucket_ts, bucket_granularity: bucketGranularity,
          provider: staleRow.provider, source_kind: sourceKind,
          status: 'CONFIRMED', stale: true, pending: false,
        }, 200, cors);
      }

      return jsonResponse({
        id: pendingRow?.id ?? null,
        rate: null, bucket_ts: bucketTs, bucket_granularity: bucketGranularity,
        provider: 'none', source_kind: sourceKind,
        status: 'PENDING', stale: false, pending: true,
      }, 200, cors);
    }

    // ── Persist confirmed rate ─────────────────────────────────────────────
    const { data: inserted } = await adminSupabase
      .from('exchange_rates')
      .upsert({
        base_currency: base, quote_currency: quote,
        rate, rate_date: rateDate,
        bucket_ts: bucketTs, bucket_granularity: bucketGranularity,
        provider, status: 'CONFIRMED',
        source_kind: sourceKind, confirmed_at: new Date().toISOString(),
      }, { onConflict: 'base_currency,quote_currency,bucket_ts,bucket_granularity,provider' })
      .select('id')
      .maybeSingle();

    return jsonResponse({
      id: inserted?.id ?? null,
      rate, bucket_ts: bucketTs, bucket_granularity: bucketGranularity,
      provider, source_kind: sourceKind,
      status: 'CONFIRMED', stale: false, pending: false,
    }, 200, cors);

  } catch (err) {
    console.error('exchange-rate-fetch unhandled:', err);
    return jsonResponse({ error: 'Failed to fetch exchange rate' }, 500, cors);
  }
});
