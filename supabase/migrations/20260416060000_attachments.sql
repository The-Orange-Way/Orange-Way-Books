-- Attachments table for transactions and payment requests
-- Files are stored in Supabase Storage, metadata here
-- File names are encrypted (ZKA L2), storage paths are UUIDs

CREATE TABLE IF NOT EXISTS attachments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('transaction', 'payment_request')),
  entity_id UUID NOT NULL,
  file_name TEXT NOT NULL,         -- encrypted (ZKA L2)
  file_size INTEGER NOT NULL,      -- plaintext (needed for quota checks)
  storage_path TEXT NOT NULL,      -- UUID-based path in Supabase Storage bucket
  mime_type TEXT,                   -- encrypted (ZKA L2)
  key_version INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  uploaded_by UUID REFERENCES auth.users(id)
);

-- Indexes
CREATE INDEX idx_attachments_entity ON attachments (entity_type, entity_id);
CREATE INDEX idx_attachments_org ON attachments (org_id);

-- RLS
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage attachments in their org"
  ON attachments
  FOR ALL
  USING (
    org_id IN (
      SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid()
    )
  );
