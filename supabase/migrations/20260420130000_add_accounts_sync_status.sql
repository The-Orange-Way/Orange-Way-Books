-- Add sync_status and last_sync_at columns to accounts for exchange rate refresh tracking
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS sync_status text;
ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS last_sync_at timestamptz;
