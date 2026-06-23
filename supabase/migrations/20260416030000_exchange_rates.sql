-- Exchange rates cache table
-- Rates are public data, no encryption needed, no RLS

create table if not exists exchange_rates (
  id uuid primary key default gen_random_uuid(),
  base_currency text not null,
  quote_currency text not null,
  rate numeric not null,
  rate_date date not null,
  provider text not null,
  fetched_at timestamptz default now(),
  unique(base_currency, quote_currency, rate_date, provider)
);

create index idx_exchange_rates_lookup
  on exchange_rates(base_currency, quote_currency, rate_date);
