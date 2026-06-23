-- Audit log table, records all CRUD operations
-- Summary and metadata are encrypted (ZKA L2)
-- Action type and timestamps are plaintext for indexing/filtering

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id),
  action TEXT NOT NULL CHECK (action IN ('CREATE', 'UPDATE', 'DELETE', 'ARCHIVE', 'UNARCHIVE', 'POST', 'VOID', 'RECONCILE')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('organization', 'wallet', 'transaction', 'journal_entry', 'contact', 'payment_request', 'chart_of_account', 'connector', 'org_settings', 'member')),
  entity_id UUID NOT NULL,
  summary TEXT,              -- encrypted (ZKA L2): human-readable description
  before_snapshot TEXT,      -- encrypted (ZKA L2): JSON of entity state before change
  after_snapshot TEXT,       -- encrypted (ZKA L2): JSON of entity state after change
  key_version INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL
);

-- Indexes for common queries
CREATE INDEX idx_audit_logs_org ON audit_logs (org_id, created_at DESC);
CREATE INDEX idx_audit_logs_entity ON audit_logs (entity_type, entity_id);

-- RLS
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read audit logs in their org"
  ON audit_logs
  FOR ALL
  USING (
    org_id IN (
      SELECT om.org_id FROM org_members om WHERE om.user_id = auth.uid()
    )
  );
