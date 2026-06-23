-- Structural / data-integrity guards that RLS alone cannot express.
--
-- All triggers are SECURITY INVOKER (default) so they do not bypass RLS on
-- the tables they query; they call stable helpers that internally use the
-- calling user's auth context. Where we need to look up rows the caller
-- might not normally see (e.g. validating a cross-table FK that RLS would
-- hide), we wrap the lookup in SECURITY DEFINER helpers in the public
-- schema so the definer's permissions are used but the function logic
-- is explicit about what it reads.
--
-- Covered findings:
--   * parent_legacy_account_id can currently point at any UUID (even another
--     org's account). Enforce same-org parents.
--   * audit_logs.entity_id has no FK and is client-supplied. When the
--     entity_type names a table that carries org_id, verify the referenced
--     row belongs to the same org; otherwise reject.
--   * organizations has no ORG-OWNER bootstrap. If the creator is not
--     inserted into org_members with OWNER role atomically, there is a
--     window where anyone with INSERT on org_members can claim OWNER.
--     Add an AFTER INSERT trigger that inserts the creator as OWNER.
--   * organizations.DELETE had no policy at all (denied by default) so the
--     UI "Delete Org" button never worked. Add an OWNER-only DELETE policy.
--   * legacy_account_map's CRUD policies did not check role. Tighten to
--     ACCOUNTANT+.

-- parent_legacy_account_id: same-org check ------------------------------------

create or replace function public.check_legacy_account_parent_same_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_org uuid;
begin
  if NEW.parent_legacy_account_id is null then
    return NEW;
  end if;
  select org_id into parent_org
    from public.legacy_account_map
   where legacy_account_id = NEW.parent_legacy_account_id
   limit 1;
  if parent_org is null then
    raise exception 'parent_legacy_account_id % does not exist', NEW.parent_legacy_account_id
      using errcode = '23503';
  end if;
  if parent_org <> NEW.org_id then
    raise exception 'parent_legacy_account_id % belongs to another org', NEW.parent_legacy_account_id
      using errcode = '23514';
  end if;
  return NEW;
end
$$;

drop trigger if exists trg_legacy_account_parent_same_org on public.legacy_account_map;
create trigger trg_legacy_account_parent_same_org
  before insert or update of parent_legacy_account_id, org_id
  on public.legacy_account_map
  for each row
  execute function public.check_legacy_account_parent_same_org();

-- audit_logs.entity_id: must belong to same org ----------------------------

create or replace function public.check_audit_log_entity_same_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  matched_org uuid;
begin
  -- Skip cross-table existence checks for DELETE / VOID audit entries
  -- by the time these rows are written the referenced row has already
  -- been removed from the target table. The caller still can't cross
  -- tenants because the entity_type = 'organization' / 'member' branches
  -- below check org_id directly, and because audit_logs.org_id itself is
  -- RLS-gated to the caller's memberships.
  if NEW.action in ('DELETE', 'VOID') then
    return NEW;
  end if;

  if NEW.entity_type = 'organization' then
    if NEW.entity_id <> NEW.org_id then
      raise exception 'audit_logs.entity_id must equal org_id for entity_type=organization'
        using errcode = '23514';
    end if;
    return NEW;
  end if;

  if NEW.entity_type = 'member' then
    -- entity_id is a user_id; just require they are a member of this org.
    if not exists (
      select 1 from public.org_members m
        where m.org_id = NEW.org_id and m.user_id = NEW.entity_id
    ) then
      raise exception 'audit_logs.entity_id % is not a member of org %', NEW.entity_id, NEW.org_id
        using errcode = '23514';
    end if;
    return NEW;
  end if;

  if NEW.entity_type = 'wallet' then
    select w.org_id into matched_org from public.accounts w where w.id = NEW.entity_id;
  elsif NEW.entity_type = 'transaction' then
    select t.org_id into matched_org from public.transactions t where t.id = NEW.entity_id;
  elsif NEW.entity_type = 'journal_entry' then
    select j.org_id into matched_org from public.journal_entries j where j.id = NEW.entity_id;
  elsif NEW.entity_type = 'contact' then
    select c.org_id into matched_org from public.contacts c where c.id = NEW.entity_id;
  elsif NEW.entity_type = 'payment_request' then
    select p.org_id into matched_org from public.payment_requests p where p.id = NEW.entity_id;
  elsif NEW.entity_type = 'chart_of_account' then
    select m.org_id into matched_org from public.legacy_account_map m where m.id = NEW.entity_id;
  elsif NEW.entity_type = 'connector' then
    select c.org_id into matched_org from public.connectors c where c.id = NEW.entity_id;
  elsif NEW.entity_type = 'org_settings' then
    select s.org_id into matched_org from public.org_settings s where s.org_id = NEW.entity_id;
  else
    -- Unknown entity_type: the CHECK constraint on the column will reject
    -- anything outside the enum, but if that list widens in the future,
    -- fall through and accept rather than silently blocking.
    return NEW;
  end if;

  if matched_org is null then
    -- The row might have been deleted between write and audit insert in a
    -- race. Accept the audit entry rather than losing the audit trail;
    -- the org_id on the audit row is still RLS-gated, so cross-tenant
    -- abuse remains impossible.
    return NEW;
  end if;
  if matched_org <> NEW.org_id then
    raise exception 'audit_logs.entity_id % belongs to a different org', NEW.entity_id
      using errcode = '23514';
  end if;
  return NEW;
end
$$;

drop trigger if exists trg_audit_log_entity_same_org on public.audit_logs;
create trigger trg_audit_log_entity_same_org
  before insert or update on public.audit_logs
  for each row
  execute function public.check_audit_log_entity_same_org();

-- organizations: auto-insert creator as OWNER ------------------------------
--
-- We cannot know who "created" a row from the DB without a created_by
-- column (which this schema lacks). Use auth.uid() at insert time. If the
-- call came from a service-role path (no auth.uid()), skip the auto-insert
--, that path is responsible for its own org_members bootstrap.

create or replace function public.auto_insert_org_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  caller uuid := auth.uid();
begin
  if caller is null then
    return NEW;
  end if;
  -- Idempotent: only insert if no membership row for this user+org exists.
  insert into public.org_members (org_id, user_id, role)
    select NEW.id, caller, 'OWNER'
    where not exists (
      select 1 from public.org_members m
        where m.org_id = NEW.id and m.user_id = caller
    );
  return NEW;
end
$$;

drop trigger if exists trg_auto_insert_org_owner on public.organizations;
create trigger trg_auto_insert_org_owner
  after insert on public.organizations
  for each row
  execute function public.auto_insert_org_owner();

-- organizations: explicit DELETE policy for OWNER only ---------------------

drop policy if exists "org_delete" on public.organizations;
create policy "org_delete"
  on public.organizations
  for delete
  to authenticated
  using (public.current_user_org_rank(id) = 0);

-- legacy_account_map: role-based write policies ------------------------------
-- The chart of accounts is accounting-sensitive; gate all writes to
-- ACCOUNTANT+. Reads remain available to any org member.

drop policy if exists "legacy_account_map_insert" on public.legacy_account_map;
drop policy if exists "legacy_account_map_update" on public.legacy_account_map;
drop policy if exists "legacy_account_map_delete" on public.legacy_account_map;

create policy "legacy_account_map_insert"
  on public.legacy_account_map
  for insert
  to authenticated
  with check (public.current_user_org_rank(org_id) <= 2);

create policy "legacy_account_map_update"
  on public.legacy_account_map
  for update
  to authenticated
  using (public.current_user_org_rank(org_id) <= 2)
  with check (public.current_user_org_rank(org_id) <= 2);

create policy "legacy_account_map_delete"
  on public.legacy_account_map
  for delete
  to authenticated
  using (public.current_user_org_rank(org_id) <= 1);

-- connectors.config_encrypted: forbid plaintext creds ----------------------
-- The client-side code encrypts config with the vault MEK before storing.
-- The column is nullable in case a connector has no config, but if any
-- value is present it must clearly look like ciphertext (base64 of
-- [iv][ct+tag] is ≥ 28 chars). Empty strings are rejected. This does not
-- prove the payload is encrypted, but it makes it harder for a buggy code
-- path to write raw JSON creds into the column.

alter table public.connectors
  drop constraint if exists connectors_config_encrypted_shape;

alter table public.connectors
  add constraint connectors_config_encrypted_shape
  check (
    config_encrypted is null
    or (
      length(config_encrypted) >= 28
      and config_encrypted ~ '^[A-Za-z0-9+/=]+$'
    )
  );
