-- ============================================================
-- Phase 3, Connection ↔ Account Map (encrypted destination routing)
-- ============================================================
-- Stores per-org mappings from an OrangeRails source wallet to an OWB
-- chart-of-accounts entry. The mapping is keyed on opaque OR identifiers
-- (or_connection_id + or_external_wallet_id) which are meaningless to OWB
-- without joining the OR-side data, but the OWB legacy_account_map.id is
-- considered sensitive (knowing "this OR wallet posts to that account"
-- leaks routing information about the user's books). We therefore encrypt
-- the OWB account id with the org vault MEK so the server stores a routing
-- pointer it cannot interpret.
--
-- ZKA reasoning:
--   * or_connection_id + or_external_wallet_id are opaque platform-managed
--     UUIDs; they are not joinable from the OWB server to anything in the
--     user's books. Server side, this table just looks like a list of
--     ciphertexts indexed by random UUIDs.
--   * encrypted_account_id is AES-256-GCM ciphertext (vault MEK), same
--     scheme used for every other encrypted_* column in OWB.
--   * Decryption + lookup happens in the client AFTER vault unlock, when
--     the TransactionList renders and joins the routing.
--
-- Membership / capability gating:
--   * SELECT, gated through org_members (matches the read-side gate on
--     existing per-org tables before Phase 4.2 capability rewrites; this
--     table has no read-only-vs-write split today).
--   * INSERT/UPDATE/DELETE, gated through user_has_capability(
--     'connectors.write', org_id) so only users with the connector-write
--     capability can change routing. This matches the existing 'connectors'
--     family of capabilities in Phase 4.2.

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

-- SELECT: any member of the org can read routing entries.
DROP POLICY IF EXISTS "cam_select_org_member" ON public.connection_account_map;
CREATE POLICY "cam_select_org_member"
  ON public.connection_account_map
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid()));

-- INSERT/UPDATE/DELETE: gated by the connectors.write capability, which
-- already covers create/edit/delete for connector-side configuration in
-- the Phase 4.2 capability matrix.
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

-- updated_at trigger, mirrors the pattern used elsewhere in OWB.
CREATE OR REPLACE FUNCTION public.set_connection_account_map_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cam_updated_at ON public.connection_account_map;
CREATE TRIGGER trg_cam_updated_at
  BEFORE UPDATE ON public.connection_account_map
  FOR EACH ROW EXECUTE FUNCTION public.set_connection_account_map_updated_at();

COMMENT ON TABLE public.connection_account_map IS
  'Phase 3, Maps an OrangeRails source wallet (opaque) to an encrypted OWB legacy_account_map.id. Server stores ciphertext only; client decrypts after vault unlock to route synced transactions.';
COMMENT ON COLUMN public.connection_account_map.encrypted_account_id IS
  'AES-256-GCM (vault MEK) over the legacy_account_map.id UUID. Server cannot interpret this value.';
