-- Per-org Data Encryption Keys (DEKs), each wrapped with the user's MEK.
-- A user in multiple orgs has one row per org.
-- On password change, only these wrapped_dek values are re-wrapped; row-level
-- ciphertext in all other tables stays untouched.

CREATE TABLE public.org_keys (
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

-- Users can only see/write their own wrapped keys for orgs they're a member of.
CREATE POLICY "org_keys_select_own" ON public.org_keys FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    AND org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
  );

CREATE POLICY "org_keys_insert_own" ON public.org_keys FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND org_id IN (SELECT org_id FROM public.org_members WHERE user_id = auth.uid())
  );

CREATE POLICY "org_keys_update_own" ON public.org_keys FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "org_keys_delete_own" ON public.org_keys FOR DELETE TO authenticated
  USING (user_id = auth.uid());

CREATE INDEX org_keys_org_id_idx ON public.org_keys(org_id);
CREATE INDEX org_keys_user_id_idx ON public.org_keys(user_id);
