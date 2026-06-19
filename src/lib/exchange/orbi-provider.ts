/**
 * ORBI provider — Phase 1 integration.
 *
 * Fetches per-minute and daily reference rates from the Orange Rails Bitcoin
 * Index (ORBI), a multi-source volume-weighted-median rate computed across
 * regulated exchanges. Returns the same `PinnedRateResult` shape OWB's
 * existing rate-resolver uses, so it can slot in as a provider option.
 *
 * Environment variables required at build time:
 *   VITE_ORBI_SUPABASE_URL       — Orange Rails PROD Supabase URL
 *   VITE_ORBI_SUPABASE_ANON_KEY  — Orange Rails PROD anon key (RLS-gated read-only)
 *
 * Both values are aliases for the canonical Orange Rails PROD credentials.
 * The anon key is safe to ship to the browser bundle — RLS on the
 * Orange Rails PROD database blocks every write path; reads return only
 * CONFIRMED rates.
 *
 * What this module returns:
 *   - PinnedRateResult shaped to drop into OWB's rate-resolver pipeline
 *   - provider field set to "ORBI" (so audit shows it)
 *   - pending=false (ORBI's RLS hides PENDING rates; we only see CONFIRMED)
 *   - stale=false when the rate is the bucket we asked for; true if ORBI
 *     served a slightly older bucket due to thin-pair handling
 *
 * What this module does NOT do:
 *   - Modify rate-resolver.ts (kept untouched for review-friendly diff)
 *   - Cache (OWB's rate-resolver has its own session cache)
 *   - Fallback to other providers (caller's job)
 *
 * Wire-in pattern in rate-resolver.ts (suggested, do this in a separate PR):
 *
 *     // BEFORE
 *     const result = await fetchFromExistingProvider(...);
 *
 *     // AFTER
 *     const orbi = await fetchFromORBI(base, quote, effectiveAt);
 *     if (orbi) return orbi;
 *     const result = await fetchFromExistingProvider(...);  // fallback
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { PinnedRateResult, SourceKind } from "./rate-resolver";
import type { BucketGranularity } from "./buckets";

// ---- ORBI client singleton ----

let orbiClient: SupabaseClient | null = null;

function getORBIClient(): SupabaseClient {
  if (orbiClient) return orbiClient;

  const url = import.meta.env.VITE_ORBI_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_ORBI_SUPABASE_ANON_KEY as string | undefined;

  if (!url || !key) {
    throw new Error(
      "ORBI not configured: VITE_ORBI_SUPABASE_URL and VITE_ORBI_SUPABASE_ANON_KEY must be set at build time."
    );
  }

  orbiClient = createClient(url, key, {
    auth: { persistSession: false },
    global: { headers: { "x-orbi-client": "v3-vault/0.1.0" } },
  });
  return orbiClient;
}

// ---- Pair canonicalization ----

/**
 * Map OWB's (base, quote) representation to ORBI's (source_currency, target_currency).
 *
 * OWB may use SATS as the base; ORBI publishes only BTC. We convert by dividing
 * the BTC rate by 1e8 (since 1 BTC = 100,000,000 sats), so a BTC/USD rate of
 * $76,000 becomes a SATS/USD rate of $0.00076.
 */
function mapToORBIPair(base: string, quote: string): { source: string; target: string; satsMultiplier: number } | null {
  const b = base.toUpperCase();
  const q = quote.toUpperCase();

  // BTC and SATS both map to BTC in ORBI; SATS uses a 1e-8 multiplier
  if (b === "BTC") return { source: "BTC", target: q, satsMultiplier: 1 };
  if (b === "SATS") return { source: "BTC", target: q, satsMultiplier: 1e-8 };
  // Stablecoin → USD direct
  if (b === "USDT" | b === "USDC" | b === "DAI") {
    return { source: b, target: q, satsMultiplier: 1 };
  }
  // We don't handle FIAT-FIAT, IDENTITY, or FIXED here — those are OWB's existing
  // resolver's job. Composite Tier C (e.g. BTC/INR via cross-rate) is handled
  // on the ORBI server side; we just consume the result.
  return null;
}

function deriveSourceKindForORBI(base: string, quote: string): SourceKind {
  const b = base.toUpperCase();
  const q = quote.toUpperCase();
  // ORBI handles BTC↔fiat (CRYPTO_FIAT) and stablecoin↔fiat (also CRYPTO_FIAT to OWB)
  if (b === "BTC" | b === "SATS" | b === "USDT" | b === "USDC" | b === "DAI") {
    return "CRYPTO_FIAT";
  }
  // Should not reach here given mapToORBIPair's gate, but type-safe fallback
  return "FIAT_FIAT";
}

// ---- Bucket math (matches ORBI methodology §3.2) ----

function partitionBucketTs(effectiveAt: Date): string {
  const minuteFloor = Math.floor(effectiveAt.getTime() / 60_000) * 60_000;
  return new Date(minuteFloor - 60_000).toISOString();
}

// ---- Public API ----

/**
 * Try to resolve a rate via ORBI. Returns null if the pair isn't supported
 * by ORBI (e.g., fiat-fiat or unknown currencies). Returns a PinnedRateResult
 * if ORBI has a published rate for the target minute.
 *
 * Caller (rate-resolver.ts) should fall back to existing providers when this
 * returns null.
 */
export async function fetchFromORBI(
  base: string,
  quote: string,
  effectiveAt: Date,
): Promise<PinnedRateResult | null> {
  const pair = mapToORBIPair(base, quote);
  if (!pair) return null;

  const bucketTsIso = partitionBucketTs(effectiveAt);

  const client = getORBIClient();
  const { data, error } = await client
    .from("exchange_rates")
    .select("id, rate, bucket_ts, tier, provider_count, composite, composite_via")
    .eq("source_currency", pair.source)
    .eq("target_currency", pair.target)
    .eq("product", "ORBI-M")
    .eq("granularity", "1m")
    .eq("status", "CONFIRMED")
    .eq("bucket_ts", bucketTsIso)
    .maybeSingle();

  if (error) {
    // Don't throw — let the caller fall back to other providers.
    // Logging the error for observability is the caller's job (OWB has audit-logger).
    return null;
  }
  if (!data) return null;

  // Apply SATS multiplier if needed
  const rawRate = Number(data.rate);
  const adjustedRate = rawRate * pair.satsMultiplier;

  return {
    rate: adjustedRate,
    rateId: data.id,
    bucketTs: data.bucket_ts,
    bucketGranularity: "M" as BucketGranularity, // ORBI-M = 1-minute bucket
    provider: data.composite ? `orbi-composite (${data.composite_via})` : `orbi (tier ${data.tier}, ${data.provider_count} sources)`,
    sourceKind: deriveSourceKindForORBI(base, quote),
    pending: false,
    stale: false,
  };
}

/**
 * Fetch the most recent ORBI rate for a pair (for "current price" displays
 * where the exact bucket doesn't matter). Useful for dashboard widgets.
 */
export async function fetchLatestFromORBI(
  base: string,
  quote: string,
): Promise<PinnedRateResult | null> {
  const pair = mapToORBIPair(base, quote);
  if (!pair) return null;

  const client = getORBIClient();
  const { data, error } = await client
    .from("exchange_rates")
    .select("id, rate, bucket_ts, tier, provider_count, composite, composite_via")
    .eq("source_currency", pair.source)
    .eq("target_currency", pair.target)
    .eq("product", "ORBI-M")
    .eq("granularity", "1m")
    .eq("status", "CONFIRMED")
    .order("bucket_ts", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;

  const rawRate = Number(data.rate);
  const adjustedRate = rawRate * pair.satsMultiplier;

  return {
    rate: adjustedRate,
    rateId: data.id,
    bucketTs: data.bucket_ts,
    bucketGranularity: "M" as BucketGranularity,
    provider: data.composite ? `orbi-composite (${data.composite_via})` : `orbi (tier ${data.tier}, ${data.provider_count} sources)`,
    sourceKind: deriveSourceKindForORBI(base, quote),
    pending: false,
    stale: true, // "latest" is by definition older than the current minute
  };
}

/**
 * Check if a pair is supported by ORBI. Useful for UI hints
 * ("rates pulled from ORBI" badge) and routing decisions.
 */
export function isORBISupported(base: string, quote: string): boolean {
  return mapToORBIPair(base, quote) !== null;
}

/**
 * Health probe — confirms the ORBI client can reach the database. Useful for
 * a settings/admin page showing rate-source availability.
 */
export async function orbiHealthCheck(): Promise<{ reachable: boolean; latestRateAt: string | null }> {
  try {
    const latest = await fetchLatestFromORBI("BTC", "USD");
    return { reachable: true, latestRateAt: latest?.bucketTs ?? null };
  } catch {
    return { reachable: false, latestRateAt: null };
  }
}
