-- Vault v3 upgrade: add attachment blob re-encryption support.
--
-- Replaces rpc_upgrade_vault_to_v3 from 20260420120000_vault_key_version_v3.sql:
--   1. Removes the attachment guard (the RPC no longer refuses when attachments
--      exist — the client re-encrypts blobs and uploads them to versioned paths
--      before calling this RPC).
--   2. Adds an `attachments` update loop that atomically writes each attachment's
--      re-encrypted file_name, mime_type, new storage_path, and key_version.
--
-- Safety contract (remains the same as the original):
--   The client uploads new blobs FIRST, then calls this RPC. If the RPC
--   succeeds, the client deletes old blobs. If the RPC fails or is never
--   called, the client deletes the newly uploaded blobs. The org data in the
--   DB is never in a mixed state.

create or replace function public.rpc_upgrade_vault_to_v3(
  p_org_id uuid,
  p_new_verifier text,
  p_new_salt text,
  p_updates jsonb
) returns void
language plpgsql
security invoker
as $$
declare
  rec jsonb;
  rec_id uuid;
begin
  -- Membership guard
  if not exists (
    select 1 from public.org_members
    where org_id = p_org_id and user_id = auth.uid()
  ) then
    raise exception 'rpc_upgrade_vault_to_v3: caller is not a member of org %', p_org_id;
  end if;

  if p_new_verifier is null or length(p_new_verifier) = 0 then
    raise exception 'rpc_upgrade_vault_to_v3: p_new_verifier is required';
  end if;
  if p_new_salt is null or length(p_new_salt) = 0 then
    raise exception 'rpc_upgrade_vault_to_v3: p_new_salt is required';
  end if;

  -- ── organizations ─────────────────────────────────────────────────────
  for rec in select * from jsonb_array_elements(coalesce(p_updates->'organizations', '[]'::jsonb))
  loop
    rec_id := (rec->>'id')::uuid;
    if rec_id <> p_org_id then
      raise exception 'organizations update id % does not match p_org_id %', rec_id, p_org_id;
    end if;
    update public.organizations set name = rec->>'name' where id = rec_id;
  end loop;

  -- ── contacts ──────────────────────────────────────────────────────────
  for rec in select * from jsonb_array_elements(coalesce(p_updates->'contacts', '[]'::jsonb))
  loop
    rec_id := (rec->>'id')::uuid;
    update public.contacts
      set name = rec->>'name',
          street = rec->>'street',
          city = rec->>'city',
          state = rec->>'state',
          zip = rec->>'zip',
          country = rec->>'country',
          email = rec->>'email',
          phone = rec->>'phone',
          type = rec->>'type'
      where id = rec_id and org_id = p_org_id;
  end loop;

  -- ── accounts ───────────────────────────────────────────────────────────
  for rec in select * from jsonb_array_elements(coalesce(p_updates->'accounts', '[]'::jsonb))
  loop
    rec_id := (rec->>'id')::uuid;
    update public.accounts
      set encrypted_name = rec->>'encrypted_name',
          encrypted_balance = rec->>'encrypted_balance',
          asset = rec->>'asset',
          account_type = rec->>'account_type',
          connection_type = rec->>'connection_type',
          legacy_account_code = rec->>'legacy_account_code'
      where id = rec_id and org_id = p_org_id;
  end loop;

  -- ── transactions ──────────────────────────────────────────────────────
  for rec in select * from jsonb_array_elements(coalesce(p_updates->'transactions', '[]'::jsonb))
  loop
    rec_id := (rec->>'id')::uuid;
    update public.transactions
      set memo = rec->>'memo',
          encrypted_amount = rec->>'encrypted_amount',
          encrypted_usd_value = rec->>'encrypted_usd_value',
          encrypted_exchange_rate = rec->>'encrypted_exchange_rate',
          asset = rec->>'asset',
          type = rec->>'type',
          status = rec->>'status',
          cleared_status = rec->>'cleared_status'
      where id = rec_id and org_id = p_org_id;
  end loop;

  -- ── journal_entries ───────────────────────────────────────────────────
  for rec in select * from jsonb_array_elements(coalesce(p_updates->'journal_entries', '[]'::jsonb))
  loop
    rec_id := (rec->>'id')::uuid;
    update public.journal_entries
      set memo = rec->>'memo',
          ref_number = rec->>'ref_number',
          currency = rec->>'currency',
          encrypted_exchange_rate = rec->>'encrypted_exchange_rate',
          status = rec->>'status',
          source_type = rec->>'source_type',
          encrypted_period_locked = rec->>'encrypted_period_locked'
      where id = rec_id and org_id = p_org_id;
  end loop;

  -- ── journal_entry_lines ───────────────────────────────────────────────
  for rec in select * from jsonb_array_elements(coalesce(p_updates->'journal_entry_lines', '[]'::jsonb))
  loop
    rec_id := (rec->>'id')::uuid;
    update public.journal_entry_lines
      set account_name = rec->>'account_name',
          account_code = rec->>'account_code',
          description = rec->>'description',
          encrypted_debit = rec->>'encrypted_debit',
          encrypted_credit = rec->>'encrypted_credit',
          encrypted_book_value = rec->>'encrypted_book_value',
          encrypted_amount_native = rec->>'encrypted_amount_native',
          encrypted_amount_primary = rec->>'encrypted_amount_primary',
          encrypted_posted_rate = rec->>'encrypted_posted_rate',
          encrypted_wallet_currency = rec->>'encrypted_wallet_currency'
      where id = rec_id
        and journal_entry_id in (
          select id from public.journal_entries where org_id = p_org_id
        );
  end loop;

  -- ── legacy_account_map ──────────────────────────────────────────────────
  for rec in select * from jsonb_array_elements(coalesce(p_updates->'legacy_account_map', '[]'::jsonb))
  loop
    rec_id := (rec->>'id')::uuid;
    update public.legacy_account_map
      set encrypted_name = rec->>'encrypted_name',
          account_type = rec->>'account_type',
          account_group = rec->>'account_group',
          account_category = rec->>'account_category',
          encrypted_is_archived = rec->>'encrypted_is_archived'
      where id = rec_id and org_id = p_org_id;
  end loop;

  -- ── payment_requests ──────────────────────────────────────────────────
  for rec in select * from jsonb_array_elements(coalesce(p_updates->'payment_requests', '[]'::jsonb))
  loop
    rec_id := (rec->>'id')::uuid;
    update public.payment_requests
      set encrypted_payee = rec->>'encrypted_payee',
          encrypted_description = rec->>'encrypted_description',
          encrypted_rejection_reason = rec->>'encrypted_rejection_reason',
          encrypted_amount = rec->>'encrypted_amount',
          currency = rec->>'currency',
          status = rec->>'status',
          request_type = rec->>'request_type',
          vendor_ref = rec->>'vendor_ref',
          payment_address = rec->>'payment_address'
      where id = rec_id and org_id = p_org_id;
  end loop;

  -- ── audit_logs ────────────────────────────────────────────────────────
  for rec in select * from jsonb_array_elements(coalesce(p_updates->'audit_logs', '[]'::jsonb))
  loop
    rec_id := (rec->>'id')::uuid;
    update public.audit_logs
      set summary = rec->>'summary',
          before_snapshot = rec->>'before_snapshot',
          after_snapshot = rec->>'after_snapshot'
      where id = rec_id and org_id = p_org_id;
  end loop;

  -- ── attachments ───────────────────────────────────────────────────────
  -- Blobs have already been re-encrypted and uploaded to `storage_path` by
  -- the client before this RPC is called. We atomically commit the new path
  -- and metadata here. On failure the entire transaction rolls back, and the
  -- client is responsible for cleaning up the newly uploaded blobs.
  for rec in select * from jsonb_array_elements(coalesce(p_updates->'attachments', '[]'::jsonb))
  loop
    rec_id := (rec->>'id')::uuid;
    update public.attachments
      set file_name    = rec->>'file_name',
          mime_type    = rec->>'mime_type',
          storage_path = rec->>'storage_path',
          key_version  = (rec->>'key_version')::integer
      where id = rec_id and org_id = p_org_id;
  end loop;

  -- ── org_settings encrypted fields ────────────────────────────────────
  for rec in select * from jsonb_array_elements(coalesce(p_updates->'org_settings', '[]'::jsonb))
  loop
    update public.org_settings
      set primary_currency       = rec->>'primary_currency',
          secondary_currency     = rec->>'secondary_currency',
          bitcoin_display        = rec->>'bitcoin_display',
          fiscal_year_type       = rec->>'fiscal_year_type',
          encrypted_fiscal_month = rec->>'encrypted_fiscal_month',
          date_format            = rec->>'date_format',
          time_format            = rec->>'time_format',
          number_format          = rec->>'number_format',
          timezone               = rec->>'timezone'
      where org_id = p_org_id;
  end loop;

  -- ── bump version + write new verifier and salt ────────────────────────
  update public.org_settings
    set vault_verifier    = p_new_verifier,
        vault_salt        = p_new_salt,
        vault_key_version = 3
    where org_id = p_org_id;
end;
$$;

comment on function public.rpc_upgrade_vault_to_v3(uuid, text, text, jsonb) is
  'Atomic v2 → v3 vault rekey. Accepts pre-encrypted ciphertext from the '
  'client and rewrites every encrypted row — including attachment metadata '
  'and storage paths — in one transaction. Blobs must be pre-uploaded by '
  'the client before this RPC is called; the client deletes old blobs after '
  'a successful call, or deletes new blobs if the RPC fails.';

revoke all on function public.rpc_upgrade_vault_to_v3(uuid, text, text, jsonb) from public;
grant execute on function public.rpc_upgrade_vault_to_v3(uuid, text, text, jsonb) to authenticated;
