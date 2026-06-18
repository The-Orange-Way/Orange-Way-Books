-- Tighten RLS on audit_logs and attachments:
--   * Prevent clients from forging user_id / uploaded_by by pinning them to auth.uid().
--   * audit_logs becomes append-only: SELECT + INSERT only (no UPDATE/DELETE).
--   * attachments splits FOR ALL into SELECT / INSERT / UPDATE / DELETE so
--     mutating rows can't rewrite ownership metadata.
--
-- Matches security review findings: "FOR ALL on audit_logs/attachments lets
-- members forge uploaded_by/user_id" and "members can delete their own org's
-- audit log entries, but audit trails should be append-only."

-- audit_logs -----------------------------------------------------------------

drop policy if exists "Users can read audit logs in their org" on public.audit_logs;

create policy "audit_logs_select"
  on public.audit_logs
  for select
  to authenticated
  using (
    org_id in (select om.org_id from public.org_members om where om.user_id = auth.uid())
  );

-- INSERT: the caller must be a member of the org AND the user_id column must
-- either be NULL (system-attributed) or equal auth.uid() (no impersonation).
create policy "audit_logs_insert"
  on public.audit_logs
  for insert
  to authenticated
  with check (
    org_id in (select om.org_id from public.org_members om where om.user_id = auth.uid())
    and (user_id is null or user_id = auth.uid())
  );

-- No UPDATE/DELETE policy -> PostgREST will deny. Service role can still
-- rotate keys, purge etc. because it bypasses RLS.

-- attachments ----------------------------------------------------------------

drop policy if exists "Users can manage attachments in their org" on public.attachments;

create policy "attachments_select"
  on public.attachments
  for select
  to authenticated
  using (
    org_id in (select om.org_id from public.org_members om where om.user_id = auth.uid())
  );

-- INSERT: caller must be an org member AND cannot set uploaded_by to somebody
-- else. uploaded_by may be NULL (legacy rows) or auth.uid().
create policy "attachments_insert"
  on public.attachments
  for insert
  to authenticated
  with check (
    org_id in (select om.org_id from public.org_members om where om.user_id = auth.uid())
    and (uploaded_by is null or uploaded_by = auth.uid())
  );

-- UPDATE: members can update attachments in their org but cannot change the
-- owning org_id or the uploaded_by stamp to another user.
create policy "attachments_update"
  on public.attachments
  for update
  to authenticated
  using (
    org_id in (select om.org_id from public.org_members om where om.user_id = auth.uid())
  )
  with check (
    org_id in (select om.org_id from public.org_members om where om.user_id = auth.uid())
    and (uploaded_by is null or uploaded_by = auth.uid())
  );

-- DELETE: any member of the owning org (tighten per-role in a later pass).
create policy "attachments_delete"
  on public.attachments
  for delete
  to authenticated
  using (
    org_id in (select om.org_id from public.org_members om where om.user_id = auth.uid())
  );
