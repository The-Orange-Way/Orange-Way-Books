-- Withdrawal consent: one record per wording, enforced by the database.
--
-- The insert path reads before it writes, which is not a lock. Two requests
-- landing together can both read empty and both insert. The table is append
-- only, so a duplicate legal record cannot be updated or deleted afterwards.
--
-- subscription_id is nullable and Postgres treats NULL as distinct from NULL,
-- so a single unique index over (user_id, subscription_id, terms_version)
-- would not cover the no-subscription case at all. Two partial indexes cover
-- both shapes explicitly.

-- Case 1: consent recorded against a subscription.
create unique index if not exists withdrawal_consents_one_per_wording_idx
  on public.withdrawal_consents (user_id, subscription_id, terms_version)
  where subscription_id is not null;

-- Case 2: consent recorded with no subscription yet.
create unique index if not exists withdrawal_consents_one_per_wording_no_sub_idx
  on public.withdrawal_consents (user_id, terms_version)
  where subscription_id is null;

-- Rollback:
--   drop index if exists public.withdrawal_consents_one_per_wording_idx;
--   drop index if exists public.withdrawal_consents_one_per_wording_no_sub_idx;
