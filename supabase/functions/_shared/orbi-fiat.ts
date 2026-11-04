// ORBI as the source for fiat-to-fiat rates (OWB-T0237).
//
// Reads the ORBI rates API (v1-rates-series, daily authority fixes), never ORBI's tables, so the
// host can move without a code change. No Deno imports: the edge function and the unit tests both
// load this file.

export interface OrbiFiatConfig {
  baseUrl: string;
  apiKey: string;
  // Oldest fix accepted, in calendar days before the requested date. Covers weekends and
  // holidays, which have no row; anything older is treated as "no rate" so a stalled feed
  // leaves the line waiting instead of pricing it at an old rate.
  maxStaleDays: number;
}

export interface OrbiFiatRate {
  rate: number; // quote units per one base unit, the same direction as the OXR path
  bucketTs: string; // the fix actually used
  provider: string;
}

type FetchFn = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

const DAY_MS = 86_400_000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The ORBI fix for `date` (YYYY-MM-DD), or the last one before it within `maxStaleDays`.
 * Returns null when ORBI has no usable fix, so the caller can fall back to another provider.
 */
export async function fetchOrbiFiatRate(
  fetchFn: FetchFn,
  cfg: OrbiFiatConfig,
  base: string,
  quote: string,
  date: string,
): Promise<OrbiFiatRate | null> {
  const dayMs = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(dayMs)) return null;
  const from = isoDay(dayMs - cfg.maxStaleDays * DAY_MS);

  const params = new URLSearchParams({
    base,
    quote,
    from,
    to: date,
    granularity: 'daily',
    product: 'ORBI-D-authority',
  });
  const res = await fetchFn(
    `${cfg.baseUrl.replace(/\/+$/, '')}/functions/v1/v1-rates-series?${params}`,
    { headers: { Authorization: `Bearer ${cfg.apiKey}` } },
  );
  if (!res.ok) return null;

  const body = await res.json();
  const points: unknown[] = Array.isArray(body?.points) ? body.points : [];
  let best: { rate: number; bucketTs: string; provenance: unknown } | null = null;
  for (const p of points as Array<Record<string, unknown>>) {
    const bucketTs = typeof p.bucket_ts === 'string' ? p.bucket_ts : '';
    const day = bucketTs.slice(0, 10);
    const rate = Number(p.rate);
    if (!day || day < from || day > date) continue;
    if (p.fill_type === 'gap' || !Number.isFinite(rate) || rate <= 0) continue;
    if (!best || bucketTs > best.bucketTs) best = { rate, bucketTs, provenance: p.provenance };
  }
  if (!best) return null;

  const via =
    typeof best.provenance === 'string' && best.provenance ? best.provenance : 'authority';
  return { rate: best.rate, bucketTs: best.bucketTs, provider: `orbi:${via}` };
}

/**
 * Whether `fix` can be stored as the rate for `date` for good. A fix from the day itself always
 * can. One carried forward from an earlier day can only once `date` is settled (ORBI settles
 * daily fixes 2 days after the day); before that, the day's own fix may still arrive, and storing
 * the older one would keep serving it from the cache.
 */
export function isSettledFix(date: string, fix: OrbiFiatRate, nowMs: number): boolean {
  if (fix.bucketTs.slice(0, 10) === date) return true;
  return Date.parse(`${date}T00:00:00Z`) + DAY_MS <= nowMs - 2 * DAY_MS;
}
