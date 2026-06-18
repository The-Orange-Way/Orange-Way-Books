-- Import jobs staging table (Track 6)
--
-- Backs both the QuickBooks importer and the generic CSV import wizard.
-- A row in import_jobs represents a single file the user uploaded that's
-- in some stage of being imported: parsed, reviewed, ready to commit,
-- committed, or failed.
--
-- ZKA: Per-row payloads (manifest, parse summary, staged rows, reconciliation
-- decisions) are encrypted in the browser before storage. The server stores
-- only opaque ciphertext + plaintext orchestration metadata (status, ts,
-- file_hash for dedup, source_type). file_hash is a client-computed SHA256
-- of the raw file bytes; it's not sensitive (it's a fingerprint, not the
-- content) and lets us detect "same file uploaded twice" without decryption.
--
-- Status machine:
--   parsing     — file uploaded, parser running in browser
--   ready       — parsed + reconciliation decisions made; user can commit
--   committing  — writes to journal_entries / transactions / accounts in flight
--   committed   — done; encrypted_committed_refs lists rows that landed
--   failed      — parser or commit threw; encrypted_error has details
--
-- Refs:
--   Earlier patterns: lib/imports/quickbooks/*, lib/accounts/csv-import.ts
--   Current state: src/components/imports/QuickBooksImportWizard.tsx exists
--             but had no server-side job persistence until now.

CREATE TABLE IF NOT EXISTS public.import_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  created_by UUID NULL REFERENCES auth.users(id),

  -- Plaintext orchestration metadata (not sensitive)
  source_type TEXT NOT NULL
    CHECK (source_type IN (
      'quickbooks',
      'csv_contacts',
      'csv_chart_of_accounts',
      'csv_transactions',
      'csv_wallets',
      'csv_journal_entries',
      'csv_payments'
    )),
  status TEXT NOT NULL DEFAULT 'parsing'
    CHECK (status IN ('parsing', 'ready', 'committing', 'committed', 'failed')),
  file_name TEXT NULL,           -- displayed in UI; not sensitive
  file_hash TEXT NULL,           -- SHA256 hex of raw file bytes for dedup
  row_count INTEGER NULL,        -- count only; no PII
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at TIMESTAMPTZ NULL,

  -- ZKA-encrypted payloads (browser encrypts before write; server can't read)
  encrypted_manifest TEXT NULL,        -- {file size, sheet names, …}
  encrypted_parse_summary TEXT NULL,   -- {accounts: N, txs: N, contacts: N, …}
  encrypted_staged_data TEXT NULL,     -- full row payload (largest field)
  encrypted_reconciliation TEXT NULL,  -- user's classify/map decisions
  encrypted_committed_refs TEXT NULL,  -- list of inserted entity IDs (post-commit)
  encrypted_error TEXT NULL,           -- error message if status=failed
  key_version INT NOT NULL DEFAULT 2
);

CREATE INDEX IF NOT EXISTS idx_import_jobs_org_status
  ON public.import_jobs (org_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_import_jobs_file_hash
  ON public.import_jobs (org_id, file_hash)
  WHERE file_hash IS NOT NULL;

-- Auto-update updated_at on UPDATE
CREATE OR REPLACE FUNCTION public._import_jobs_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS import_jobs_touch_updated_at ON public.import_jobs;
CREATE TRIGGER import_jobs_touch_updated_at
  BEFORE UPDATE ON public.import_jobs
  FOR EACH ROW EXECUTE FUNCTION public._import_jobs_touch_updated_at();

-- ── RLS ────────────────────────────────────────────────────────────────
ALTER TABLE public.import_jobs ENABLE ROW LEVEL SECURITY;

-- Org members can read their org's jobs
CREATE POLICY "import_jobs_select" ON public.import_jobs
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.org_members om
       WHERE om.org_id = import_jobs.org_id
         AND om.user_id = auth.uid()
    )
  );

-- Org members can create jobs in their org (created_by must match caller)
CREATE POLICY "import_jobs_insert" ON public.import_jobs
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
       WHERE om.org_id = import_jobs.org_id
         AND om.user_id = auth.uid()
    )
  );

-- Org members can update jobs they created in their own org
CREATE POLICY "import_jobs_update" ON public.import_jobs
  FOR UPDATE TO authenticated
  USING (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
       WHERE om.org_id = import_jobs.org_id
         AND om.user_id = auth.uid()
    )
  )
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.org_members om
       WHERE om.org_id = import_jobs.org_id
         AND om.user_id = auth.uid()
    )
  );

-- Owner can delete jobs (e.g. abandoned drafts); commits stay forever
CREATE POLICY "import_jobs_delete" ON public.import_jobs
  FOR DELETE TO authenticated
  USING (
    created_by = auth.uid()
    AND status IN ('parsing', 'ready', 'failed')
    AND EXISTS (
      SELECT 1 FROM public.org_members om
       WHERE om.org_id = import_jobs.org_id
         AND om.user_id = auth.uid()
    )
  );

COMMENT ON TABLE public.import_jobs IS
  'Staging area for QB + CSV file imports. Encrypted payloads (browser-side); plaintext metadata only.';
COMMENT ON COLUMN public.import_jobs.file_hash IS
  'Client-computed SHA256 of raw file bytes. Used to detect re-imports and idempotency. Not sensitive (fingerprint only).';
COMMENT ON COLUMN public.import_jobs.encrypted_staged_data IS
  'Parsed rows ready for commit. Browser-encrypted under MEK. Server cannot read.';
