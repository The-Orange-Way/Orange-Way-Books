-- Enable realtime for pending_invites (INSERT + UPDATE).
-- REPLICA IDENTITY FULL ensures UPDATE payloads include the full old row
-- so clients can diff status transitions reliably.
ALTER TABLE public.pending_invites REPLICA IDENTITY FULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'pending_invites'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.pending_invites';
  END IF;
END
$$;