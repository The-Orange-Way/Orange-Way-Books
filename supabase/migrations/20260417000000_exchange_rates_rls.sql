-- Enable RLS on exchange_rates and lock writes down to the service role.
--
-- Rates themselves are non-sensitive (public market data) so authenticated
-- clients may continue to read them. Writes must go through the
-- exchange-rate-fetch Edge Function, which (a) validates the caller JWT,
-- (b) allow-lists currency codes, and (c) upserts with the service role.
-- Service role bypasses RLS, so the policies below intentionally do NOT
-- grant INSERT/UPDATE/DELETE to anon or authenticated.

alter table if exists public.exchange_rates enable row level security;

drop policy if exists "exchange_rates_select_authenticated" on public.exchange_rates;
create policy "exchange_rates_select_authenticated"
  on public.exchange_rates
  for select
  to authenticated
  using (true);

-- No INSERT/UPDATE/DELETE policy for anon/authenticated -> PostgREST will deny.
-- Service role continues to work because it bypasses RLS.
