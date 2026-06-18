-- Create the `attachments` Storage bucket (private) and gate every operation
-- on it by org membership. Previously the bucket had no RLS shipped; the app
-- uploads AES-256-GCM-encrypted blobs under `${orgId}/${txId}/${uuid}`, so
-- without this policy any authenticated user could `storage.list(...)` the
-- bucket or download by UUID path. Files are still encrypted client-side, so
-- an attacker would not see plaintext — but the upload surface (overwrite,
-- delete, quota burn) was wide open.
--
-- Path layout enforced: first folder component MUST be the org_id, e.g.
--   "${orgId}/${txId}/${uuid}"
-- storage.foldername(name)[1] returns the first path segment, which is
-- matched against the caller's org_members rows.

insert into storage.buckets (id, name, public)
values ('attachments', 'attachments', false)
on conflict (id) do update set public = false;

-- Drop any pre-existing policies so this migration is idempotent.
drop policy if exists "attachments_storage_select" on storage.objects;
drop policy if exists "attachments_storage_insert" on storage.objects;
drop policy if exists "attachments_storage_update" on storage.objects;
drop policy if exists "attachments_storage_delete" on storage.objects;

create policy "attachments_storage_select"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] in (
      select org_id::text from public.org_members where user_id = auth.uid()
    )
  );

create policy "attachments_storage_insert"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] in (
      select org_id::text from public.org_members where user_id = auth.uid()
    )
  );

create policy "attachments_storage_update"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] in (
      select org_id::text from public.org_members where user_id = auth.uid()
    )
  )
  with check (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] in (
      select org_id::text from public.org_members where user_id = auth.uid()
    )
  );

create policy "attachments_storage_delete"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'attachments'
    and (storage.foldername(name))[1] in (
      select org_id::text from public.org_members where user_id = auth.uid()
    )
  );
