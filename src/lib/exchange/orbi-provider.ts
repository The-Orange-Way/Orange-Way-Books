// Calls OWB's own orbi-rate edge function. No Orange Rails key in the browser.
// Accepted pairs: BTC/USD, SATS/USD, USDT/USD, USDC/USD, DAI/USD

import type { PinnedRateResult, SourceKind } from './rate-resolver';
import type { BucketGranularity } from './buckets';

// SourceKind: BTC, SATS, USDT, USDC, DAI are all crypto; quote is fiat (USD etc.)
const ORBI_SOURCE_KIND: SourceKind = 'CRYPTO_FIAT';
// BucketGranularity: ORBI data is 1-minute; FIVE_MINUTES is the finest OWB type member
const ORBI_BUCKET_GRAN: BucketGranularity = 'FIVE_MINUTES';

const SUPPORTED: Record<string, true> = {
  'BTC/USD': true, 'SATS/USD': true,
  'USDT/USD': true, 'USDC/USD': true, 'DAI/USD': true,
};

function orbiUrl(): string {
  return `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/orbi-rate`;
}

export function isORBISupported(base: string, quote: string): boolean {
  return `${base}/${quote}` in SUPPORTED;
}

function mapResult(
  data: { rate: number; bucketTs: string; composite_via: string | null },
  stale: boolean,
): PinnedRateResult {
  return {
    rate: data.rate,
    rateId: null,
    bucketTs: data.bucketTs,
    bucketGranularity: ORBI_BUCKET_GRAN,
    provider: data.composite_via ?? 'orbi',
    sourceKind: ORBI_SOURCE_KIND,
    pending: false,
    stale,
  };
}

export async function fetchFromORBI(
  base: string,
  quote: string,
  atDate: Date,
): Promise<PinnedRateResult | null> {
  if (!isORBISupported(base, quote)) return null;
  const params = new URLSearchParams({
    mode: 'point',
    base,
    quote,
    at: atDate.toISOString(),
  });
  try {
    const res = await fetch(`${orbiUrl()}?${params}`);
    if (!res.ok) return null;
    const data = await res.json() as { rate: number; bucketTs: string; composite_via: string | null };
    return mapResult(data, false);
  } catch {
    return null;
  }
}

export async function fetchLatestFromORBI(
  base: string,
  quote: string,
): Promise<PinnedRateResult | null> {
  if (!isORBISupported(base, quote)) return null;
  const params = new URLSearchParams({ mode: 'latest', base, quote });
  try {
    const res = await fetch(`${orbiUrl()}?${params}`);
    if (!res.ok) return null;
    const data = await res.json() as { rate: number; bucketTs: string; composite_via: string | null };
    return mapResult(data, true);
  } catch {
    return null;
  }
}

export async function orbiHealthCheck(): Promise<boolean> {
  const params = new URLSearchParams({ mode: 'latest', base: 'BTC', quote: 'USD' });
  try {
    const res = await fetch(`${orbiUrl()}?${params}`);
    return res.ok;
  } catch {
    return false;
  }
}
