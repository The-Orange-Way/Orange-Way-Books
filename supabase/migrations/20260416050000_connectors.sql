-- Connectors table: stores external service connections per org
-- Credentials are encrypted client-side via ZKA vault before storage

create table if not exists public.connectors (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references public.organizations(id) on delete cascade,
  connector_type text not null check (connector_type in ('blink', 'exchange', 'bank')),
  label          text not null default '',
  encrypted_label text,                     -- ZKA-encrypted label
  config_encrypted text,                    -- ZKA-encrypted JSON blob (api_key, api_secret, endpoint)
  status         text not null default 'disconnected' check (status in ('connected', 'disconnected', 'error')),
  last_sync      timestamptz,
  key_version    smallint default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- Index for org lookups
create index if not exists idx_connectors_org_id on public.connectors(org_id);

-- Unique: one connector per type per org (can be relaxed later for multi-exchange)
create unique index if not exists idx_connectors_org_type on public.connectors(org_id, connector_type);

-- RLS
alter table public.connectors enable row level security;

create policy "Users can view own org connectors"
  on public.connectors for select
  using (org_id in (select org_id from public.org_members where user_id = auth.uid()));

create policy "Users can insert own org connectors"
  on public.connectors for insert
  with check (org_id in (select org_id from public.org_members where user_id = auth.uid()));

create policy "Users can update own org connectors"
  on public.connectors for update
  using (org_id in (select org_id from public.org_members where user_id = auth.uid()));

create policy "Users can delete own org connectors"
  on public.connectors for delete
  using (org_id in (select org_id from public.org_members where user_id = auth.uid()));

-- Updated-at trigger
create or replace function public.set_connectors_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_connectors_updated_at
  before update on public.connectors
  for each row execute function public.set_connectors_updated_at();
