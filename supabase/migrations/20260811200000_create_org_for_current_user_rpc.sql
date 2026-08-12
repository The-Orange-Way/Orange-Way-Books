-- create_org_for_current_user: server-side org bootstrap RPC (DL-0718)
--
-- Onboarding currently inserts into public.organizations directly from the
-- client. This RPC gives the post-onboarding org setup surface a single,
-- auditable entry point for creating an organization while keeping the
-- zero-knowledge boundary intact: the org name arrives already encrypted in
-- the browser and is stored verbatim. The server never sees plaintext.
--
-- Design constraints (all verified against the live schema before writing):
--   * SECURITY INVOKER. The insert runs under the caller's RLS, so the
--     existing org_insert WITH CHECK (external_journal_id IS NULL AND
--     billing_account_id IS NULL) still applies. No RLS bypass.
--   * Single write: public.organizations ONLY. Membership (org_members OWNER)
--     is seeded by the existing AFTER INSERT trigger trg_auto_insert_org_owner,
--     and org_member_roles by trg_sync_org_member_role. org_settings is left
--     entirely to the client, so this never collides with the client's
--     org_settings INSERT (org_settings_pkey is PRIMARY KEY (org_id)).
--   * No p_user_id parameter. The owner is always auth.uid(); a caller cannot
--     create an org on someone else's behalf.
--   * A null auth.uid() raises loudly rather than silently no-opping.
--   * p_name is stored verbatim (ciphertext). p_key_version stamps the active
--     client key strategy (currently 2).
--
-- Idempotent: CREATE OR REPLACE. Rollback:
--   DROP FUNCTION public.create_org_for_current_user(text, integer);

create or replace function public.create_org_for_current_user(
  p_name text,
  p_key_version integer default 2
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_caller uuid := auth.uid();
  v_org_id uuid;
begin
  if v_caller is null then
    raise exception 'create_org_for_current_user requires an authenticated user'
      using errcode = '28000';
  end if;

  if p_name is null or length(p_name) = 0 then
    raise exception 'organization name is required'
      using errcode = '23514';
  end if;

  insert into public.organizations (name, key_version)
    values (p_name, p_key_version)
    returning id into v_org_id;

  return v_org_id;
end
$$;

revoke all on function public.create_org_for_current_user(text, integer) from public;
grant execute on function public.create_org_for_current_user(text, integer) to authenticated;
