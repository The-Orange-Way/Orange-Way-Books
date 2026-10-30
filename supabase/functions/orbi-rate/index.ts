import { createClient } from 'jsr:@supabase/supabase-js@2'

const ALLOWED_BASES = ['BTC', 'USDT', 'USDC', 'DAI']
const SATS_MULTIPLIER = 1e-8

const CORS_ORIGINS = [
  'https://books.orangeway.dev',
  'https://books.orangeway.app',
]

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin !== null && CORS_ORIGINS.includes(origin)
  return {
    'Access-Control-Allow-Origin': allowed ? origin : CORS_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  }
}

function minuteBucket(ts: Date): Date {
  const b = new Date(ts)
  b.setSeconds(0, 0)
  b.setMinutes(b.getMinutes() - 1)
  return b
}

function isIsoTimestamp(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)
}

function shapeRate(
  row: { rate: number; bucket_ts: string; composite_via: string | null },
  rawBase: string,
  quote: string,
  stale: boolean
) {
  return {
    base: rawBase,
    quote,
    rate: rawBase === 'SATS' ? row.rate * SATS_MULTIPLIER : row.rate,
    bucketTs: row.bucket_ts,
    stale,
    composite_via: row.composite_via ?? null,
  }
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin')
  const cors = corsHeaders(origin)

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors })
  }
  if (req.method !== 'GET') {
    return new Response('Method Not Allowed', { status: 405, headers: cors })
  }

  const dbUrl = Deno.env.get('ORBI_DB_URL')
  const dbKey = Deno.env.get('ORBI_DB_ANON_KEY')
  if (!dbUrl || !dbKey) {
    return new Response('Service unavailable', { status: 503, headers: cors })
  }

  const url = new URL(req.url)
  const mode = url.searchParams.get('mode') ?? 'latest'
  const rawBase = (url.searchParams.get('base') ?? 'BTC').toUpperCase()
  const quote = (url.searchParams.get('quote') ?? 'USD').toUpperCase()

  if (!['latest', 'point'].includes(mode)) {
    return new Response('Invalid mode', { status: 400, headers: cors })
  }
  if (!/^[A-Z]{2,10}$/.test(quote)) {
    return new Response('Invalid quote', { status: 400, headers: cors })
  }
  const dbBase = rawBase === 'SATS' ? 'BTC' : rawBase
  if (!ALLOWED_BASES.includes(dbBase)) {
    return new Response('Unsupported base', { status: 400, headers: cors })
  }

  const client = createClient(dbUrl, dbKey)

  try {
    if (mode === 'latest') {
      const { data, error } = await client
        .from('exchange_rates')
        .select('rate, bucket_ts, composite_via')
        .eq('base_currency', dbBase)
        .eq('quote_currency', quote)
        .eq('status', 'confirmed')
        .order('bucket_ts', { ascending: false })
        .limit(1)
        .single()
      if (error || !data) {
        return new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { ...cors, 'Content-Type': 'application/json' },
        })
      }
      return new Response(
        JSON.stringify(shapeRate(data as { rate: number; bucket_ts: string; composite_via: string | null }, rawBase, quote, true)),
        { headers: { ...cors, 'Content-Type': 'application/json' } }
      )
    }

    // mode === 'point'
    const atParam = url.searchParams.get('at')
    if (!atParam || !isIsoTimestamp(atParam)) {
      return new Response('Invalid or missing at', { status: 400, headers: cors })
    }
    const bucket = minuteBucket(new Date(atParam))
    const { data, error } = await client
      .from('exchange_rates')
      .select('rate, bucket_ts, composite_via')
      .eq('base_currency', dbBase)
      .eq('quote_currency', quote)
      .eq('status', 'confirmed')
      .lte('bucket_ts', bucket.toISOString())
      .order('bucket_ts', { ascending: false })
      .limit(1)
      .single()
    if (error || !data) {
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { ...cors, 'Content-Type': 'application/json' },
      })
    }
    return new Response(
      JSON.stringify(shapeRate(data as { rate: number; bucket_ts: string; composite_via: string | null }, rawBase, quote, false)),
      { headers: { ...cors, 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    console.error('orbi-rate upstream error:', e instanceof Error ? e.message : 'unknown')
    return new Response('Bad gateway', { status: 502, headers: cors })
  }
})
