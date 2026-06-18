ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS exchange_rate numeric;

COMMENT ON COLUMN public.accounts.exchange_rate IS
  'Stored asset→BTC rate at last refresh (public data; plaintext OK under ZKA).';