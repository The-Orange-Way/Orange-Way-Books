-- Postgres-backed token-bucket for Edge Function rate limiting.
--
-- Supabase's gateway has a coarse global rate limit; per-user / per-route
-- limits have to be enforced in-app. We keep the implementation minimal:
--
--   * rate_limit_events(scope text, subject text, created_at timestamptz)
--     One row per allowed call. Short-lived (see retention cleanup below).
--   * public.rate_limit_try(scope text, subject text, max_per_window int,
--                           window_seconds int) returns boolean
--     Atomically counts rows in the last window_seconds for the given
--     (scope, subject) pair. If the count < max_per_window, inserts a new
--     row and returns true (allowed). Otherwise returns false.
--
-- Scope is a short identifier (e.g. 'invite-org-member', 'exchange-rate-fetch',
-- 'legacy-proxy'). Subject is whatever the caller wants to key on —
-- typically the user id, but could be caller IP or (user_id | org_id)
-- for per-tenant limits.
--
-- Retention: rows older than the longest window we ever use are deleted
-- at the start of every try() call. A nightly cron job can DELETE-then-
-- VACUUM if desired, but the inline cleanup keeps the table small even
-- without external orchestration.

create table if not exists public.rate_limit_events (
  id          bigserial primary key,
  scope       text not null,
  subject     text not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_rate_limit_events_scope_subject_time
  on public.rate_limit_events (scope, subject, created_at desc);

-- Lock it down. Only SECURITY DEFINER functions below should touch this
-- table. No client or authenticated-user policy is created, which means
-- PostgREST will refuse direct SELECT/INSERT/UPDATE/DELETE.
alter table public.rate_limit_events enable row level security;

create or replace function public.rate_limit_try(
  scope_in text,
  subject_in text,
  max_per_window integer,
  window_seconds integer
) returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  current_count integer;
  cutoff timestamptz := now() - make_interval(secs => window_seconds);
begin
  -- Opportunistic cleanup: drop anything older than the longest window
  -- we plausibly care about (12 hours keeps the table tiny but still lets
  -- auditors see recent burst history if needed).
  delete from public.rate_limit_events
   where created_at < now() - interval '12 hours';

  select count(*) into current_count
    from public.rate_limit_events
   where scope = scope_in
     and subject = subject_in
     and created_at >= cutoff;

  if current_count >= max_per_window then
    return false;
  end if;

  insert into public.rate_limit_events (scope, subject) values (scope_in, subject_in);
  return true;
end
$$;

grant execute on function public.rate_limit_try(text, text, integer, integer) to authenticated, anon;

comment on function public.rate_limit_try(text, text, integer, integer) is
  'Edge Function rate limiting. Returns true if the call is allowed; false if the bucket is full.';
