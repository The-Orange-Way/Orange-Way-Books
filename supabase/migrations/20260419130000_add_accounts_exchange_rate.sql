-- Add accounts.exchange_rate (stored asset→BTC rate)
--
-- This column was always referenced by src/pages/Wallets.tsx (header "Refresh"
-- action and per-wallet edit/create flows cast `{ exchange_rate: rate }` via
-- `as any` against `supabase.from('accounts').update(...)`). The column was
-- never created by a prior migration, so production returns PGRST204:
--   "Could not find the 'exchange_rate' column of 'accounts' in the schema cache"
--
-- The value is the public asset→BTC rate at last refresh. Public FX data is
-- safe to store as plaintext numeric under the ZKA model (the same way
-- public.exchange_rates is plaintext).

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS exchange_rate numeric;

COMMENT ON COLUMN public.accounts.exchange_rate IS
  'Stored asset→BTC rate at last refresh (public data; plaintext OK under ZKA).';
