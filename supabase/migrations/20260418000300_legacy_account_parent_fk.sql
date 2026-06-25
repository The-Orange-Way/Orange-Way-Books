-- Proper FK on legacy_account_map.parent_legacy_account_id (finding #22).
--
-- Migration 20260416080000 added the column as plain TEXT with same-org
-- enforcement via trigger (20260417000400). That works, but on DELETE of
-- a parent row the children stay with a dangling reference until the
-- trigger re-fires on the next UPDATE. A proper referential constraint
-- with ON DELETE SET NULL keeps the chart clean.
--
-- legacy_account_id is TEXT in legacy_account_map (it stores the UUID as a
-- stringified legacy ledger backend id, not a uuid type). We add a unique index on it
-- first so it can be the target of a FK, then add the self-FK.

-- 1) Ensure legacy_account_id is unique per row so it can be the FK target.
-- It already IS unique (one row per account), but we haven't declared it.
-- UNIQUE INDEX IF NOT EXISTS is idempotent; skip if someone already added it.
do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'legacy_account_map_legacy_account_id_unique'
       and conrelid = 'public.legacy_account_map'::regclass
  ) then
    alter table public.legacy_account_map
      add constraint legacy_account_map_legacy_account_id_unique
      unique (legacy_account_id);
  end if;
end $$;

-- 2) Drop the old FK if present and recreate with ON DELETE SET NULL.
alter table public.legacy_account_map
  drop constraint if exists legacy_account_map_parent_fk;

alter table public.legacy_account_map
  add constraint legacy_account_map_parent_fk
  foreign key (parent_legacy_account_id)
  references public.legacy_account_map (legacy_account_id)
  on delete set null
  deferrable initially deferred;

-- The existing same-org trigger still runs and catches the cross-org case
-- that a FK can't express (FK only enforces "exists", not "exists in same
-- org"). The two constraints are complementary.
