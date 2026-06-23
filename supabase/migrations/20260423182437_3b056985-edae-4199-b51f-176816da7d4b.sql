CREATE TABLE IF NOT EXISTS public.connection_account_map (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  or_connection_id                UUID NOT NULL,
  or_external_wallet_id           TEXT NOT NULL,
  encrypted_account_id            TEXT NOT NULL,
  encrypted_metadata_key_version  INTEGER NOT NULL DEFAULT 1,
  is_active                       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, or_connection_id, or_external_wallet_id, encrypted_account_id)
);

CREATE INDEX IF NOT EXISTS idx_cam_org      ON public.connection_account_map(org_id);
CREATE INDEX IF NOT EXISTS idx_cam_or_conn  ON public.connection_account_map(or_connection_id);

ALTER TABLE public.connection_account_map ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "cam_select_org_member" ON public.connection_account_map;
CREATE POLICY "cam_select_org_member"
  ON public.connection_account_map
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS "cam_insert_cap" ON public.connection_account_map;
CREATE POLICY "cam_insert_cap"
  ON public.connection_account_map
  FOR INSERT TO authenticated
  WITH CHECK (public.user_has_capability(auth.uid(), 'connectors.write', org_id));

DROP POLICY IF EXISTS "cam_update_cap" ON public.connection_account_map;
CREATE POLICY "cam_update_cap"
  ON public.connection_account_map
  FOR UPDATE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'connectors.write', org_id))
  WITH CHECK (public.user_has_capability(auth.uid(), 'connectors.write', org_id));

DROP POLICY IF EXISTS "cam_delete_cap" ON public.connection_account_map;
CREATE POLICY "cam_delete_cap"
  ON public.connection_account_map
  FOR DELETE TO authenticated
  USING (public.user_has_capability(auth.uid(), 'connectors.write', org_id));

CREATE OR REPLACE FUNCTION public.set_connection_account_map_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cam_updated_at ON public.connection_account_map;
CREATE TRIGGER trg_cam_updated_at
  BEFORE UPDATE ON public.connection_account_map
  FOR EACH ROW EXECUTE FUNCTION public.set_connection_account_map_updated_at();

COMMENT ON TABLE public.connection_account_map IS
  'Phase 3, Maps an OrangeRails source wallet (opaque) to an encrypted OWB legacy_account_map.id. Server stores ciphertext only; client decrypts after vault unlock to route synced transactions.';
COMMENT ON COLUMN public.connection_account_map.encrypted_account_id IS
  'AES-256-GCM (vault MEK) over the legacy_account_map.id UUID. Server cannot interpret this value.';