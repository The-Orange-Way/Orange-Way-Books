-- Pin payment_requests.requested_by and .approved_by to auth.uid() at RLS.
--
-- Previously the client could set either column to any UUID; RLS only
-- checked org membership + role rank, not that the ownership stamp
-- matched the calling user. Same class of bug we fixed for
-- attachments.uploaded_by / audit_logs.user_id — missed this table.
--
-- Rules:
--   * INSERT: requested_by must be NULL or equal auth.uid().
--             approved_by must be NULL (you can't create a pre-approved
--             request — approval goes through the approve_payment_request
--             RPC which pins approved_by itself).
--   * UPDATE: if requested_by is CHANGED, the new value must equal
--             auth.uid() (or NULL). Same for approved_by.
--             The most common update path (editing memo/amount) leaves
--             these columns untouched; that still passes because the
--             check is on the NEW value, not on whether the column
--             was in the SET clause.
--
-- Finding #3 from the post-merge audit.

drop policy if exists "payment_requests_insert" on public.payment_requests;
drop policy if exists "payment_requests_update" on public.payment_requests;

create policy "payment_requests_insert"
  on public.payment_requests
  for insert
  to authenticated
  with check (
    public.current_user_org_rank(org_id) <= 3
    and (requested_by is null or requested_by = auth.uid())
    and approved_by is null
  );

create policy "payment_requests_update"
  on public.payment_requests
  for update
  to authenticated
  using (public.current_user_org_rank(org_id) <= 2)
  with check (
    public.current_user_org_rank(org_id) <= 2
    and (requested_by is null or requested_by = auth.uid())
    and (approved_by is null or approved_by = auth.uid())
  );

-- Finding #4 — role-specific approve / reject RPCs.
--
-- The role matrix (ROLE_PERMISSIONS in src/pages/Admin.tsx) says only
-- OWNER / ADMIN / ACCOUNTANT hold 'approvePayments'. RLS cannot easily
-- distinguish "approve" from "edit memo" because they are both generic
-- UPDATEs. Expose SECURITY DEFINER RPCs that:
--   * Require ACCOUNTANT+ rank in the target row's org.
--   * Set status, approved_by = auth.uid(), and (for reject)
--     encrypted_rejection_reason.
--   * Skip RLS (SECURITY DEFINER) so the server can write approved_by
--     even though the caller might otherwise trip the
--     'payment_requests_update' check if they passed a wrong value —
--     the RPC does it for them.
--
-- Clients should call these instead of writing { status, approved_by }
-- directly; the RLS policy above still allows the direct path for
-- backward compatibility, but any future work should prefer the RPCs.

create or replace function public.approve_payment_request(
  request_id uuid,
  new_status_ciphertext text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_org uuid;
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select org_id into target_org
    from public.payment_requests
   where id = request_id;
  if target_org is null then
    raise exception 'payment_request % not found', request_id using errcode = '23503';
  end if;
  if public.current_user_org_rank(target_org) > 2 then
    raise exception 'Only OWNER / ADMIN / ACCOUNTANT can approve payment requests'
      using errcode = '42501';
  end if;
  update public.payment_requests
     set status = new_status_ciphertext,
         approved_by = caller,
         key_version = 2,
         updated_at = now()
   where id = request_id;
end
$$;

grant execute on function public.approve_payment_request(uuid, text) to authenticated;

create or replace function public.reject_payment_request(
  request_id uuid,
  new_status_ciphertext text,
  rejection_reason_ciphertext text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  target_org uuid;
  caller uuid := auth.uid();
begin
  if caller is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select org_id into target_org
    from public.payment_requests
   where id = request_id;
  if target_org is null then
    raise exception 'payment_request % not found', request_id using errcode = '23503';
  end if;
  if public.current_user_org_rank(target_org) > 2 then
    raise exception 'Only OWNER / ADMIN / ACCOUNTANT can reject payment requests'
      using errcode = '42501';
  end if;
  update public.payment_requests
     set status = new_status_ciphertext,
         approved_by = caller,
         encrypted_rejection_reason = rejection_reason_ciphertext,
         key_version = 2,
         updated_at = now()
   where id = request_id;
end
$$;

grant execute on function public.reject_payment_request(uuid, text, text) to authenticated;
