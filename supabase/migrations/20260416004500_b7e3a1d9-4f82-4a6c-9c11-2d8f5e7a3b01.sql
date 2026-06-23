-- Migration: Add key_version columns for ZKA Level 1 encryption support
-- Phase C1: Add columns only. No data migration, no table drops, no RLS changes.

-- 1. contacts
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS key_version INT DEFAULT 0;

-- 2. organizations
ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS key_version INT DEFAULT 0;

-- 3. transactions
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS key_version INT DEFAULT 0;

-- 4. journal_entries
ALTER TABLE public.journal_entries
  ADD COLUMN IF NOT EXISTS key_version INT DEFAULT 0;

-- 5. journal_entry_lines
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS key_version INT DEFAULT 0;

-- 6. legacy_account_map, new columns for consolidated account table
ALTER TABLE public.legacy_account_map
  ADD COLUMN IF NOT EXISTS encrypted_name TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_description TEXT,
  ADD COLUMN IF NOT EXISTS key_version INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN DEFAULT false;
