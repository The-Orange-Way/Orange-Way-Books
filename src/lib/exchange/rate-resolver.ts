import { supabase } from '@/lib/supabase';
import { isCrypto } from './currency-registry';
import { bucketFor, bucketTsToIso, granularityForPair, type BucketGranularity } from './buckets';
import { fetchFromORBI } from './orbi-provider';

// ── Types ────────────────────────────────────────────────────────────────────

export type SourceKind =
  | 'FIAT_FIAT'
  | 'FIAT_CRYPTO'
  | 'CRYPTO_FIAT'
  | 'CRYPTO_CRYPTO'
  | 'IDENTITY'
  | 'FIXED';

export interface RateResult {
  rate: number;
  date: string;
  provider: string;
  stale: boolean;
}

export interface PinnedRateResult {
  rate: number;
  rateId: string | null;
  bucketTs: string;
  bucketGranularity: BucketGranularity;
  provider: string;
  sourceKind: SourceKind;
  pending: boolean;
  stale: boolean;
}

// ── Session cache ─────────────────────────────────────────────────────────────
// Keyed on (base:quote:bucketTs:granularity) to avoid redundant edge calls
// within the same browser session (5-min TTL matches Supabase prompt cache).

const sessionCache = new Map<string, { result: PinnedRateResult; ts: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheKey(base: string, quote: string, bucketTs: string, gran: BucketGranularity): string {
  return `${base}:${quote}:${bucketTs}:${gran}`;
}

function putCache(
  base: string,
  quote: string,
  bucketTs: string,
  gran: BucketGranularity,
  result: PinnedRateResult,
): void {
  sessionCache.set(cacheKey(base, quote, bucketTs, gran), { result, ts: Date.now() });
}

function getCache(
  base: string,
  quote: string,
  bucketTs: string,
  gran: BucketGranularity,
): PinnedRateResult | null {
  const entry = sessionCache.get(cacheKey(base, quote, bucketTs, gran));
  if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.result;
  return null;
}

export function clearRateCache(): void {
  sessionCache.clear();
}

// ── Source-kind derivation ────────────────────────────────────────────────────

export function deriveSourceKind(base: string, quote: string): SourceKind {
  const b = base.toUpperCase();
  const q = quote.toUpperCase();
  if (b === q) return 'IDENTITY';
  if ((b === 'SATS' && q === 'BTC') || (b === 'BTC' && q === 'SATS')) return 'FIXED';
  const bCrypto = isCrypto(b);
  const qCrypto = isCrypto(q);
  if (bCrypto && qCrypto) return 'CRYPTO_CRYPTO';
  if (bCrypto) return 'CRYPTO_FIAT';
  if (qCrypto) return 'FIAT_CRYPTO';
  return 'FIAT_FIAT';
}

// ── DB stale-cache fallback ───────────────────────────────────────────────────

async function fetchMostRecentConfirmed(
  base: string,
  quote: string,
  beforeTs: string,
): Promise<PinnedRateResult | null> {
  // Direct pair
  const { data } = await supabase
    .from('exchange_rates')
    .select('id, rate, bucket_ts, bucket_granularity, provider, source_kind')
    .eq('base_currency', base)
    .eq('quote_currency', quote)
    .eq('status', 'CONFIRMED')
    .lte('bucket_ts', beforeTs)
    .order('bucket_ts', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (data && data.rate != null) {
    return {
      rate: Number(data.rate),
      rateId: data.id,
      bucketTs: data.bucket_ts,
      bucketGranularity: (data.bucket_granularity ?? 'DAY') as BucketGranularity,
      provider: data.provider,
      sourceKind: (data.source_kind ?? deriveSourceKind(base, quote)) as SourceKind,
      pending: false,
      stale: true,
    };
  }

  // Try reverse pair
  const { data: rev } = await supabase
    .from('exchange_rates')
    .select('id, rate, bucket_ts, bucket_granularity, provider, source_kind')
    .eq('base_currency', quote)
    .eq('quote_currency', base)
    .eq('status', 'CONFIRMED')
    .lte('bucket_ts', beforeTs)
    .order('bucket_ts', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (rev && Number(rev.rate) !== 0) {
    const inverted = 1 / Number(rev.rate);
    return {
      rate: inverted,
      rateId: rev.id,
      bucketTs: rev.bucket_ts,
      bucketGranularity: (rev.bucket_granularity ?? 'DAY') as BucketGranularity,
      provider: rev.provider,
      sourceKind: deriveSourceKind(base, quote),
      pending: false,
      stale: true,
    };
  }

  return null;
}

// ── Primary resolver, called at JE posting time ──────────────────────────────

/**
 * Resolve and pin a rate for a journal entry line.
 * Returns a PinnedRateResult. On total failure returns `pending: true` with rate=0.
 */
export async function resolvePinnedRate(params: {
  source: string;
  target: string;
  at?: string | Date;
}): Promise<PinnedRateResult> {
  const base = params.source.toUpperCase();
  const quote = params.target.toUpperCase();
  const atDate =
    params.at instanceof Date ? params.at : params.at ? new Date(params.at) : new Date();
  const sourceKind = deriveSourceKind(base, quote);

  // Identity, rate is exactly 1
  if (sourceKind === 'IDENTITY') {
    const ts = bucketTsToIso(bucketFor(atDate, 'DAY'));
    return {
      rate: 1,
      rateId: null,
      bucketTs: ts,
      bucketGranularity: 'DAY',
      provider: 'identity',
      sourceKind,
      pending: false,
      stale: false,
    };
  }

  // Fixed SATS↔BTC
  if (sourceKind === 'FIXED') {
    const rate = base === 'SATS' ? 0.00000001 : 100_000_000;
    const ts = bucketTsToIso(bucketFor(atDate, 'DAY'));
    return {
      rate,
      rateId: null,
      bucketTs: ts,
      bucketGranularity: 'DAY',
      provider: 'fixed',
      sourceKind,
      pending: false,
      stale: false,
    };
  }

  const gran = granularityForPair(base, quote);
  const bucketTs = bucketTsToIso(bucketFor(atDate, gran));

  // Session cache
  const cached = getCache(base, quote, bucketTs, gran);
  if (cached) return cached;

  // Try ORBI first for supported pairs (BTC/SATS/stablecoin ↔ fiat). Returns
  // null for unsupported pairs or when ORBI doesn't have the bucket, falls
  // through to the existing exchange-rate-fetch path.
  try {
    const orbi = await fetchFromORBI(base, quote, atDate);
    if (orbi) {
      putCache(base, quote, bucketTs, gran, orbi);
      return orbi;
    }
  } catch {
    // ORBI errors are non-fatal, let the existing provider try.
  }

  try {
    const { data, error } = await supabase.functions.invoke('exchange-rate-fetch', {
      body: { base, quote, bucket_ts: bucketTs, bucket_granularity: gran },
    });

    if (error) throw error;

    const result: PinnedRateResult = {
      rate: data.rate ?? 0,
      rateId: data.id ?? null,
      bucketTs: data.bucket_ts ?? bucketTs,
      bucketGranularity: (data.bucket_granularity ?? gran) as BucketGranularity,
      provider: data.provider ?? 'unknown',
      sourceKind: (data.source_kind ?? sourceKind) as SourceKind,
      pending: data.pending ?? false,
      stale: data.stale ?? false,
    };

    if (!result.pending) putCache(base, quote, bucketTs, gran, result);
    return result;
  } catch {
    // Edge function down, try stale DB cache before marking pending
    const stale = await fetchMostRecentConfirmed(base, quote, bucketTs);
    if (stale) {
      putCache(base, quote, bucketTs, gran, stale);
      return stale;
    }
    // Nothing available, caller must handle pending=true
    return {
      rate: 0,
      rateId: null,
      bucketTs,
      bucketGranularity: gran,
      provider: 'none',
      sourceKind,
      pending: true,
      stale: false,
    };
  }
}

// ── Secondary display rate ────────────────────────────────────────────────────

/**
 * Get the rate to convert primary-currency amounts into the secondary (presentation)
 * currency for dashboard display. Uses closing-rate (today) by default.
 * Returns null if currencies are the same or secondary is null.
 */
export async function getSecondaryDisplayRate(params: {
  primary: string;
  secondary: string | null;
  at?: string;
}): Promise<PinnedRateResult | null> {
  const { primary, secondary, at } = params;
  if (!secondary || primary.toUpperCase() === secondary.toUpperCase()) return null;
  return resolvePinnedRate({ source: primary, target: secondary, at });
}

// ── Cross-rate helper ─────────────────────────────────────────────────────────

export function crossRate(baseToUsd: number, quoteToUsd: number): number {
  if (quoteToUsd === 0) throw new Error('Cannot compute cross rate: quote/USD rate is 0');
  return baseToUsd / quoteToUsd;
}

export function convertAmount(amount: number, rate: number): number {
  return amount * rate;
}

// ── Back-compat wrapper (keeps all existing call sites working) ───────────────

export async function fetchRate(base: string, quote: string, date?: string): Promise<RateResult> {
  const result = await resolvePinnedRate({ source: base, target: quote, at: date });
  return {
    rate: result.rate,
    date: result.bucketTs.slice(0, 10),
    provider: result.provider,
    stale: result.stale,
  };
}
