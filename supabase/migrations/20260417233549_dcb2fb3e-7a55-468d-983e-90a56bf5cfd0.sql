DO $$
BEGIN
  IF to_regclass('public.org_settings') IS NOT NULL THEN
    ALTER TABLE public.org_settings
      ADD COLUMN IF NOT EXISTS key_version INTEGER DEFAULT 0;
  END IF;
END $$;