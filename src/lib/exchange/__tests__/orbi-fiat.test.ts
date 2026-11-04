// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { fetchOrbiFiatRate, isSettledFix } from '../../../../supabase/functions/_shared/orbi-fiat';

// ORBI as the fiat-to-fiat rate source (OWB-T0237). The fake answers like v1-rates-series.
const cfg = { baseUrl: 'https://orbi.example/', apiKey: 'k', maxStaleDays: 4 };
const fake = (points: unknown[], status = 200) => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fn = async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return new Response(JSON.stringify({ points }), { status });
  };
  return { fn, calls };
};
const pt = (day: string, rate: number, extra: Record<string, unknown> = {}) => ({
  bucket_ts: `${day}T00:00:00Z`,
  rate: String(rate),
  fill_type: 'exact',
  provenance: 'fed',
  composite: false,
  ...extra,
});

describe('fetchOrbiFiatRate', () => {
  it('asks the rates API for daily authority fixes up to the date, with the key', async () => {
    const { fn, calls } = fake([pt('2026-10-23', 1.38)]);
    await fetchOrbiFiatRate(fn, cfg, 'USD', 'CAD', '2026-10-25');
    const u = new URL(calls[0].url);
    expect(u.origin + u.pathname).toBe('https://orbi.example/functions/v1/v1-rates-series');
    expect(Object.fromEntries(u.searchParams)).toEqual({
      base: 'USD',
      quote: 'CAD',
      from: '2026-10-21',
      to: '2026-10-25',
      granularity: 'daily',
      product: 'ORBI-D-authority',
    });
    expect(calls[0].headers.Authorization).toBe('Bearer k');
  });

  it('on a Sunday uses the Friday fix, the latest one on or before the date', async () => {
    const { fn } = fake([pt('2026-10-22', 1.37), pt('2026-10-23', 1.38, { provenance: 'boc' })]);
    expect(await fetchOrbiFiatRate(fn, cfg, 'USD', 'CAD', '2026-10-25')).toEqual({
      rate: 1.38,
      bucketTs: '2026-10-23T00:00:00Z',
      provider: 'orbi:boc',
    });
  });

  it('gives no rate when the newest fix is older than the allowed window', async () => {
    const { fn } = fake([pt('2026-10-20', 1.36)]);
    expect(await fetchOrbiFiatRate(fn, cfg, 'USD', 'CAD', '2026-10-25')).toBeNull();
  });

  it('ignores gaps, bad rates and fixes after the date', async () => {
    const { fn } = fake([
      pt('2026-10-22', 1.37),
      pt('2026-10-23', 0, { fill_type: 'exact' }),
      pt('2026-10-24', 1.5, { fill_type: 'gap' }),
      pt('2026-10-26', 1.9),
    ]);
    const r = await fetchOrbiFiatRate(fn, cfg, 'USD', 'CAD', '2026-10-25');
    expect(r?.rate).toBe(1.37);
  });

  it('gives no rate when ORBI refuses or has nothing', async () => {
    expect(await fetchOrbiFiatRate(fake([], 401).fn, cfg, 'USD', 'CAD', '2026-10-25')).toBeNull();
    expect(await fetchOrbiFiatRate(fake([]).fn, cfg, 'USD', 'CAD', '2026-10-25')).toBeNull();
  });

  it('stores a carried-forward fix only once the day has settled', () => {
    const fri = { rate: 1.38, bucketTs: '2026-10-23T00:00:00Z', provider: 'orbi:fed' };
    const at = (iso: string) => Date.parse(iso);
    // Monday asked on Monday or Tuesday: Monday's own fix may still come.
    expect(isSettledFix('2026-10-26', fri, at('2026-10-26T12:00:00Z'))).toBe(false);
    expect(isSettledFix('2026-10-26', fri, at('2026-10-28T23:00:00Z'))).toBe(false);
    // Two days after Monday ends, or Sunday, which never gets a fix of its own once settled.
    expect(isSettledFix('2026-10-26', fri, at('2026-10-29T00:00:00Z'))).toBe(true);
    expect(isSettledFix('2026-10-25', fri, at('2026-10-30T00:00:00Z'))).toBe(true);
    // The day's own fix is final at once.
    expect(isSettledFix('2026-10-23', fri, at('2026-10-23T12:00:00Z'))).toBe(true);
  });
});
