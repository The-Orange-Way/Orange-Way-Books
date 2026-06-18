-- Idempotent schema backfill for hosted DBs that skipped or partially applied migrations.
-- Safe to run in Supabase SQL Editor multiple times.
-- Only touches objects whose base tables already exist (avoids errors on minimal DBs).

-- ── org_settings: vault KDF version (VaultContext) ───────────────────────────
DO $$
BEGIN
  IF to_regclass('public.org_settings') IS NOT NULL THEN
    ALTER TABLE public.org_settings ADD COLUMN IF NOT EXISTS kdf_version INTEGER DEFAULT 1;
  END IF;
END $$;

-- ── transactions: transfer link + encrypted_metadata + index ─────────────────
DO $$
BEGIN
  IF to_regclass('public.transactions') IS NOT NULL THEN
    ALTER TABLE public.transactions
      ADD COLUMN IF NOT EXISTS linked_transfer_id uuid REFERENCES public.transactions(id) ON DELETE SET NULL;
    ALTER TABLE public.transactions
      ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;
    CREATE INDEX IF NOT EXISTS idx_transactions_linked_transfer_id
      ON public.transactions(linked_transfer_id)
      WHERE linked_transfer_id IS NOT NULL;
  END IF;
END $$;

-- ── encrypted_metadata on optional tables (only if table exists) ─────────────
DO $$
BEGIN
  IF to_regclass('public.payment_requests') IS NOT NULL THEN
    ALTER TABLE public.payment_requests ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;
  END IF;
  IF to_regclass('public.connectors') IS NOT NULL THEN
    ALTER TABLE public.connectors ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;
  END IF;
  IF to_regclass('public.journal_entries') IS NOT NULL THEN
    ALTER TABLE public.journal_entries ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;
  END IF;
  IF to_regclass('public.accounts') IS NOT NULL THEN
    ALTER TABLE public.accounts ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;
  END IF;
  IF to_regclass('public.journal_entry_lines') IS NOT NULL THEN
    ALTER TABLE public.journal_entry_lines ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;
  END IF;
  IF to_regclass('public.legacy_account_map') IS NOT NULL THEN
    ALTER TABLE public.legacy_account_map ADD COLUMN IF NOT EXISTS encrypted_metadata JSONB;
  END IF;
END $$;

-- ── attachments (receipts metadata) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.attachments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('transaction', 'payment_request')),
  entity_id UUID NOT NULL,
  file_name TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  storage_path TEXT NOT NULL,
  mime_type TEXT,
  key_version INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  uploaded_by UUID REFERENCES auth.users(id)
);

CREATE INDEX IF NOT EXISTS idx_attachments_entity ON public.attachments (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_attachments_org ON public.attachments (org_id);

ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can manage attachments in their org" ON public.attachments;
CREATE POLICY "Users can manage attachments in their org"
  ON public.attachments
  FOR ALL
  USING (
    org_id IN (
      SELECT om.org_id FROM public.org_members om WHERE om.user_id = auth.uid()
    )
  );

-- ── org_keys (per-org DEK, Track D) ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.org_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  wrapped_dek TEXT NOT NULL,
  iv TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, user_id)
);

ALTER TABLE public.org_keys ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "org_keys_select_own" ON public.org_keys;
CREATE POLICY "org_keys_select_own" ON public.org_keys FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "org_keys_insert_own" ON public.org_keys;
CREATE POLICY "org_keys_insert_own" ON public.org_keys FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
  );

DROP POLICY IF EXISTS "org_keys_update_own" ON public.org_keys;
CREATE POLICY "org_keys_update_own" ON public.org_keys FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "org_keys_delete_own" ON public.org_keys;
CREATE POLICY "org_keys_delete_own" ON public.org_keys FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS org_keys_org_id_idx ON public.org_keys(org_id);
CREATE INDEX IF NOT EXISTS org_keys_user_id_idx ON public.org_keys(user_id);
