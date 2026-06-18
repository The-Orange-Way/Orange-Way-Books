import { useState, useEffect, useRef } from 'react';
import { fetchRate, resolvePinnedRate, getSecondaryDisplayRate, type RateResult, type PinnedRateResult } from './rate-resolver';

// ── useExchangeRate — extended shape (back-compat) ────────────────────────────

export interface UseExchangeRateResult {
  rate: number | null;
  loading: boolean;
  stale: boolean;
  pending: boolean;
  asOf: string | null;
  provider: string | null;
  error: string | null;
  refresh: () => void;
}

/**
 * Fetch and cache an exchange rate. Auto-refreshes when base, quote, or date change.
 * Extended return shape adds: pending, asOf, provider.
 */
export function useExchangeRate(
  base: string | null | undefined,
  quote: string | null | undefined,
  date?: string,
): UseExchangeRateResult {
  const [rate, setRate] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(false);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortRef = useRef(0);

  useEffect(() => {
    if (!base | !quote) {
      setRate(null); setLoading(false); setStale(false);
      setPending(false); setAsOf(null); setProvider(null); setError(null);
      return;
    }
    if (base.toUpperCase() === quote.toUpperCase()) {
      setRate(1); setLoading(false); setStale(false);
      setPending(false); setAsOf(date ?? null); setProvider('identity'); setError(null);
      return;
    }

    const callId = ++abortRef.current;
    setLoading(true);
    setError(null);

    resolvePinnedRate({ source: base, target: quote, at: date })
      .then((result) => {
        if (callId !== abortRef.current) return;
        setRate(result.pending ? null : result.rate);
        setStale(result.stale);
        setPending(result.pending);
        setAsOf(result.bucketTs.slice(0, 10));
        setProvider(result.provider);
        setLoading(false);
      })
      .catch((err) => {
        if (callId !== abortRef.current) return;
        setRate(null); setStale(false); setPending(true);
        setAsOf(null); setProvider(null);
        setError(err instanceof Error ? err.message : 'Failed to fetch rate');
        setLoading(false);
      });
  }, [base, quote, date, refreshKey]);

  return { rate, loading, stale, pending, asOf, provider, error, refresh: () => setRefreshKey(k => k + 1) };
}

// ── useSecondaryDisplayRate ───────────────────────────────────────────────────

export interface UseSecondaryDisplayRateResult {
  rate: number | null;
  loading: boolean;
  stale: boolean;
  pending: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Closing-rate conversion from primary → secondary currency.
 * Used by dashboards and KPI cards. Returns null when secondary is null/same.
 */
export function useSecondaryDisplayRate(
  primary: string | null | undefined,
  secondary: string | null | undefined,
  at?: string,
): UseSecondaryDisplayRateResult {
  const [rate, setRate] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const abortRef = useRef(0);

  useEffect(() => {
    if (!primary | !secondary | primary.toUpperCase() === secondary.toUpperCase()) {
      setRate(null); setLoading(false); setStale(false); setPending(false); setError(null);
      return;
    }

    const callId = ++abortRef.current;
    setLoading(true);
    setError(null);

    getSecondaryDisplayRate({ primary, secondary, at })
      .then((result) => {
        if (callId !== abortRef.current) return;
        if (!result) { setRate(null); setLoading(false); return; }
        setRate(result.pending ? null : result.rate);
        setStale(result.stale);
        setPending(result.pending);
        setLoading(false);
      })
      .catch((err) => {
        if (callId !== abortRef.current) return;
        setRate(null); setStale(false); setPending(true);
        setError(err instanceof Error ? err.message : 'Failed to fetch rate');
        setLoading(false);
      });
  }, [primary, secondary, at, refreshKey]);

  return { rate, loading, stale, pending, error, refresh: () => setRefreshKey(k => k + 1) };
}
