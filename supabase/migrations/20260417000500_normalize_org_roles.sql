-- Normalize org_members.role casing.
--
-- The app has been inserting a mix of 'Owner' / 'OWNER' / 'Member' / ...
-- depending on which code path wrote the row. Role comparisons in the
-- current_user_org_rank() helper and in the invite-org-member edge function
-- already upper() their inputs, but mixed casing makes the data harder to
-- reason about and risks string-literal mismatches in any future check.
--
-- Upcase existing rows and add a CHECK constraint so the uppercase set is
-- the only valid shape going forward.

update public.org_members
   set role = upper(role)
 where role is not null and role <> upper(role);

alter table public.org_members
  drop constraint if exists org_members_role_check;

alter table public.org_members
  add constraint org_members_role_check
  check (role in ('OWNER', 'ADMIN', 'ACCOUNTANT', 'MEMBER', 'VIEWER'));
