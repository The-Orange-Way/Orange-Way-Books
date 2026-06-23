-- Role-based authorization at the DB layer.
--
-- The app has a role matrix (OWNER/ADMIN/ACCOUNTANT/MEMBER/VIEWER) but every
-- existing RLS policy only asked "is this user a member of the org?". Under
-- that contract a VIEWER can delete journal entries, rotate org settings, or
-- remove other members. This migration adds:
--
--   * A SECURITY DEFINER helper `public.current_user_org_rank(org uuid)`
--     returning the caller's role rank in the given org (0 = OWNER,
--     1 = ADMIN, 2 = ACCOUNTANT, 3 = MEMBER, 4 = VIEWER). Lower == more
--     privileged. NULL when the caller is not a member.
--   * Stricter policies on org_settings, organizations, org_members,
--     journal_entries/lines, transactions, accounts, payment_requests (if
--     present), connectors, and contacts.
--
-- Read access stays open to all members; writes require a minimum rank.

create or replace function public.current_user_org_rank(org uuid)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select case upper(om.role)
    when 'OWNER'      then 0
    when 'ADMIN'      then 1
    when 'ACCOUNTANT' then 2
    when 'MEMBER'     then 3
    when 'VIEWER'     then 4
    else null
  end
  from public.org_members om
  where om.user_id = auth.uid()
    and om.org_id = org
  limit 1
$$;

comment on function public.current_user_org_rank(uuid) is
  'Rank of the calling user in the given org (0=OWNER..4=VIEWER). NULL if not a member.';

-- Convenience: the role rank required for each class of write.
--   * admin-or-owner (<=1): org_members, org_settings structural changes,
--                            connectors (holds API secrets), organizations.
--   * accountant-or-higher (<=2): journal_entries, journal_entry_lines,
--                                 transactions, payment_requests, contacts,
--                                 accounts, attachments.

-- organizations --------------------------------------------------------------

drop policy if exists "org_update" on public.organizations;
create policy "org_update"
  on public.organizations
  for update
  to authenticated
  using (public.current_user_org_rank(id) is not null)
  with check (public.current_user_org_rank(id) <= 1);

-- No delete on organizations from clients (no policy = denied).

-- org_members ---------------------------------------------------------------

-- Dangerous legacy policy: 'org_members_own' FOR ALL USING (user_id = auth.uid())
-- let any member update or delete their own role row, including an ADMIN
-- demoting themselves to OWNER by re-inserting. Replace with tight rules.
drop policy if exists "org_members_own" on public.org_members;
drop policy if exists "members_insert" on public.org_members;
drop policy if exists "members_select" on public.org_members;

-- SELECT: you can see memberships for orgs you belong to (so the Admin UI
-- can list all members, not only yourself).
create policy "org_members_select"
  on public.org_members
  for select
  to authenticated
  using (public.current_user_org_rank(org_id) is not null);

-- INSERT: either you are creating your own first membership (classic
-- onboarding flow) OR you are ADMIN/OWNER of the target org. In the OWNER
-- case the invite-org-member edge function uses the service role, which
-- bypasses RLS, this clause is the defense-in-depth for direct SQL.
create policy "org_members_insert"
  on public.org_members
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    or public.current_user_org_rank(org_id) <= 1
  );

-- UPDATE: only OWNER/ADMIN of the org can change a member's role.
create policy "org_members_update"
  on public.org_members
  for update
  to authenticated
  using (public.current_user_org_rank(org_id) <= 1)
  with check (public.current_user_org_rank(org_id) <= 1);

-- DELETE: OWNER/ADMIN, or the user removing themselves.
create policy "org_members_delete"
  on public.org_members
  for delete
  to authenticated
  using (
    user_id = auth.uid()
    or public.current_user_org_rank(org_id) <= 1
  );

-- org_settings --------------------------------------------------------------

drop policy if exists "settings_insert" on public.org_settings;
drop policy if exists "settings_update" on public.org_settings;
drop policy if exists "settings_via_membership" on public.org_settings;

create policy "org_settings_insert"
  on public.org_settings
  for insert
  to authenticated
  with check (public.current_user_org_rank(org_id) <= 1);

create policy "org_settings_update"
  on public.org_settings
  for update
  to authenticated
  using (public.current_user_org_rank(org_id) <= 1)
  with check (public.current_user_org_rank(org_id) <= 1);

-- journal_entries + lines ---------------------------------------------------

drop policy if exists "je_insert" on public.journal_entries;
drop policy if exists "je_update" on public.journal_entries;
drop policy if exists "je_delete" on public.journal_entries;

create policy "je_insert"
  on public.journal_entries
  for insert
  to authenticated
  with check (public.current_user_org_rank(org_id) <= 2);

create policy "je_update"
  on public.journal_entries
  for update
  to authenticated
  using (public.current_user_org_rank(org_id) <= 2)
  with check (public.current_user_org_rank(org_id) <= 2);

create policy "je_delete"
  on public.journal_entries
  for delete
  to authenticated
  using (public.current_user_org_rank(org_id) <= 2);

drop policy if exists "jel_insert" on public.journal_entry_lines;
drop policy if exists "jel_update" on public.journal_entry_lines;
drop policy if exists "jel_delete" on public.journal_entry_lines;

create policy "jel_insert"
  on public.journal_entry_lines
  for insert
  to authenticated
  with check (
    journal_entry_id in (
      select id from public.journal_entries
      where public.current_user_org_rank(org_id) <= 2
    )
  );

create policy "jel_update"
  on public.journal_entry_lines
  for update
  to authenticated
  using (
    journal_entry_id in (
      select id from public.journal_entries
      where public.current_user_org_rank(org_id) <= 2
    )
  )
  with check (
    journal_entry_id in (
      select id from public.journal_entries
      where public.current_user_org_rank(org_id) <= 2
    )
  );

create policy "jel_delete"
  on public.journal_entry_lines
  for delete
  to authenticated
  using (
    journal_entry_id in (
      select id from public.journal_entries
      where public.current_user_org_rank(org_id) <= 2
    )
  );

-- transactions ---------------------------------------------------------------
-- UI role matrix (ROLE_PERMISSIONS in src/pages/Admin.tsx) grants manualTx to
-- MEMBER. DELETE is kept at ACCOUNTANT+ because undoing posted activity is
-- accounting-sensitive.

drop policy if exists "tx_insert" on public.transactions;
drop policy if exists "tx_update" on public.transactions;
drop policy if exists "tx_delete" on public.transactions;

create policy "tx_insert"
  on public.transactions
  for insert
  to authenticated
  with check (public.current_user_org_rank(org_id) <= 3);

create policy "tx_update"
  on public.transactions
  for update
  to authenticated
  using (public.current_user_org_rank(org_id) <= 3)
  with check (public.current_user_org_rank(org_id) <= 3);

create policy "tx_delete"
  on public.transactions
  for delete
  to authenticated
  using (public.current_user_org_rank(org_id) <= 2);

-- accounts --------------------------------------------------------------------
-- MEMBER+ can create/update accounts (matches the UI where Members can add a
-- wallet during onboarding / day-to-day). DELETE is ACCOUNTANT+ to protect
-- historical balances.

drop policy if exists "accounts_insert" on public.accounts;
drop policy if exists "accounts_update" on public.accounts;
drop policy if exists "accounts_delete" on public.accounts;

create policy "accounts_insert"
  on public.accounts
  for insert
  to authenticated
  with check (public.current_user_org_rank(org_id) <= 3);

create policy "accounts_update"
  on public.accounts
  for update
  to authenticated
  using (public.current_user_org_rank(org_id) <= 3)
  with check (public.current_user_org_rank(org_id) <= 3);

create policy "accounts_delete"
  on public.accounts
  for delete
  to authenticated
  using (public.current_user_org_rank(org_id) <= 2);

-- contacts -------------------------------------------------------------------
-- MEMBER+ can add/update contacts (inline-contact creation from Transactions
-- page relies on this). DELETE is ACCOUNTANT+.

drop policy if exists "contacts_insert" on public.contacts;
drop policy if exists "contacts_update" on public.contacts;
drop policy if exists "contacts_delete" on public.contacts;

create policy "contacts_insert"
  on public.contacts
  for insert
  to authenticated
  with check (public.current_user_org_rank(org_id) <= 3);

create policy "contacts_update"
  on public.contacts
  for update
  to authenticated
  using (public.current_user_org_rank(org_id) <= 3)
  with check (public.current_user_org_rank(org_id) <= 3);

create policy "contacts_delete"
  on public.contacts
  for delete
  to authenticated
  using (public.current_user_org_rank(org_id) <= 2);

-- connectors (stores encrypted third-party API keys) ------------------------

drop policy if exists "Users can insert own org connectors" on public.connectors;
drop policy if exists "Users can update own org connectors" on public.connectors;
drop policy if exists "Users can delete own org connectors" on public.connectors;

create policy "connectors_insert"
  on public.connectors
  for insert
  to authenticated
  with check (public.current_user_org_rank(org_id) <= 1);

create policy "connectors_update"
  on public.connectors
  for update
  to authenticated
  using (public.current_user_org_rank(org_id) <= 1)
  with check (public.current_user_org_rank(org_id) <= 1);

create policy "connectors_delete"
  on public.connectors
  for delete
  to authenticated
  using (public.current_user_org_rank(org_id) <= 1);

-- payment_requests ----------------------------------------------------------

-- The existing migration used FOR ALL USING (org_id IN (...)). Replace with
-- a split so deletes are restricted to accountant+ while SELECT stays open.
drop policy if exists "Users can manage payment requests for their org" on public.payment_requests;

create policy "payment_requests_select"
  on public.payment_requests
  for select
  to authenticated
  using (
    org_id in (select org_id from public.org_members where user_id = auth.uid())
  );

create policy "payment_requests_insert"
  on public.payment_requests
  for insert
  to authenticated
  with check (public.current_user_org_rank(org_id) <= 3);  -- members can request

create policy "payment_requests_update"
  on public.payment_requests
  for update
  to authenticated
  using (public.current_user_org_rank(org_id) <= 2)
  with check (public.current_user_org_rank(org_id) <= 2);

create policy "payment_requests_delete"
  on public.payment_requests
  for delete
  to authenticated
  using (public.current_user_org_rank(org_id) <= 1);
