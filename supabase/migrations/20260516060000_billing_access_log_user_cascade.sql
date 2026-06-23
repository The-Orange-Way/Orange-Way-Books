-- A2, Add ON DELETE CASCADE to billing_access_log.user_id
--
-- The original S16 migration (20260516040000) defined billing_access_log
-- with `user_id UUID NOT NULL REFERENCES auth.users(id)`, no cascade
-- behavior. Every other auth.users foreign key in the schema
-- (user_master_recovery, org_master_wraps, vault_security_events,
-- org_members, etc.) uses ON DELETE CASCADE.
--
-- Without the cascade, deleting a user from auth.users is blocked by
-- their accumulated billing_access_log rows (a fresh user can pick up
-- many rows just by visiting the Billing page a few times). Surfaces
-- as `update or delete on table "users" violates foreign key constraint
-- "billing_access_log_user_id_fkey" on table "billing_access_log"`.
--
-- This is a referential-integrity foot gun, not a security hole. Fix
-- is mechanical: drop + recreate the FK with the right ON DELETE.
--
-- Surfaced by 2026-05-16 post-hardening audit (finding A2 / C2).

ALTER TABLE public.billing_access_log
  DROP CONSTRAINT IF EXISTS billing_access_log_user_id_fkey;

ALTER TABLE public.billing_access_log
  ADD CONSTRAINT billing_access_log_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
