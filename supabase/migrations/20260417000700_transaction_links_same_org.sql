-- transactions.linked_transfer_id: must point at a transaction in the same
-- org. Without this trigger, an ACCOUNTANT+ user who can update a
-- transaction row could link it to a transaction in an org they don't
-- belong to (the FK only checks that a row with that id exists somewhere).
-- Such a link could leak structural information across tenants via any
-- future report that joins on linked_transfer_id.

create or replace function public.check_linked_transfer_same_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  other_org uuid;
begin
  if NEW.linked_transfer_id is null then
    return NEW;
  end if;
  if NEW.linked_transfer_id = NEW.id then
    raise exception 'transaction cannot link to itself'
      using errcode = '23514';
  end if;
  select org_id into other_org
    from public.transactions
   where id = NEW.linked_transfer_id;
  if other_org is null then
    raise exception 'linked_transfer_id % does not exist', NEW.linked_transfer_id
      using errcode = '23503';
  end if;
  if other_org <> NEW.org_id then
    raise exception 'linked_transfer_id % belongs to another org', NEW.linked_transfer_id
      using errcode = '23514';
  end if;
  return NEW;
end
$$;

drop trigger if exists trg_linked_transfer_same_org on public.transactions;
create trigger trg_linked_transfer_same_org
  before insert or update of linked_transfer_id, org_id
  on public.transactions
  for each row
  execute function public.check_linked_transfer_same_org();
