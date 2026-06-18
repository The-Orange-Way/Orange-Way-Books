-- Enable Realtime broadcasts for key_rotation_jobs (INSERT + UPDATE)
ALTER TABLE public.key_rotation_jobs REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'key_rotation_jobs'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.key_rotation_jobs;
  END IF;
END $$;