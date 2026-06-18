-- Payment Requests table
-- Encrypted fields: payee, description, rejection_reason
-- Plaintext: amount, currency, status, dates (needed for filtering/sorting)

create table if not exists payment_requests (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  ref_number text,
  encrypted_payee text,
  encrypted_description text,
  encrypted_rejection_reason text,
  amount numeric not null default 0,
  encrypted_amount text,
  currency text not null default 'USD',
  status text not null default 'PENDING',
  request_type text not null default 'Invoice',
  vendor_ref text,
  due_date date,
  document_date date,
  payment_address text,
  requested_by uuid references auth.users(id),
  approved_by uuid references auth.users(id),
  paid_at timestamptz,
  key_version integer default 2,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table payment_requests enable row level security;

create policy "Users can manage payment requests for their org"
  on payment_requests for all
  using (org_id in (select org_id from org_members where user_id = auth.uid()));

create index idx_payment_requests_org on payment_requests(org_id);
create index idx_payment_requests_status on payment_requests(org_id, status);
