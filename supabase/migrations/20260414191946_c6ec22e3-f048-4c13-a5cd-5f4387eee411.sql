
DROP POLICY IF EXISTS "Users see their orgs" ON organizations;
DROP POLICY IF EXISTS "orgs_via_membership" ON organizations;
DROP POLICY IF EXISTS "Users see their memberships" ON org_members;
DROP POLICY IF EXISTS "org_members_own" ON org_members;
DROP POLICY IF EXISTS "Users see their org settings" ON org_settings;
DROP POLICY IF EXISTS "settings_via_membership" ON org_settings;
DROP POLICY IF EXISTS "account_metadata_via_membership" ON account_metadata;
DROP POLICY IF EXISTS "accounts_via_membership" ON accounts;
DROP POLICY IF EXISTS "tx_metadata_via_membership" ON transaction_metadata;

CREATE POLICY "org_insert" ON organizations FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "org_select" ON organizations FOR SELECT TO authenticated USING (id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE POLICY "org_update" ON organizations FOR UPDATE TO authenticated USING (id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

CREATE POLICY "members_insert" ON org_members FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY "members_select" ON org_members FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "settings_insert" ON org_settings FOR INSERT TO authenticated WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE POLICY "settings_select" ON org_settings FOR SELECT TO authenticated USING (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE POLICY "settings_update" ON org_settings FOR UPDATE TO authenticated USING (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

CREATE POLICY "acct_meta_insert" ON account_metadata FOR INSERT TO authenticated WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE POLICY "acct_meta_select" ON account_metadata FOR SELECT TO authenticated USING (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

CREATE POLICY "accounts_insert" ON accounts FOR INSERT TO authenticated WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE POLICY "accounts_select" ON accounts FOR SELECT TO authenticated USING (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));

CREATE POLICY "tx_meta_insert" ON transaction_metadata FOR INSERT TO authenticated WITH CHECK (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
CREATE POLICY "tx_meta_select" ON transaction_metadata FOR SELECT TO authenticated USING (org_id IN (SELECT org_id FROM org_members WHERE user_id = auth.uid()));
