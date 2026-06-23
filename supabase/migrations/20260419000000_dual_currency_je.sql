-- Part 2: Dual-Currency Journal Entry, Schema Migration
--
-- Adds three-currency (wallet / primary / secondary-derived) support to the
-- ledger, following IAS 21 / ASC 830. All new encrypted columns follow the
-- existing ZKA Level-2 pattern: ciphertext stored in TEXT, numeric originals
-- zeroed so the server never sees real values.
--
-- Idempotent throughout, safe to run twice on the same database.
-- Run order matters for FK targets; execute top-to-bottom.

-- ============================================================
-- 1. exchange_rates, add bucketing, status, source_kind
-- ============================================================

-- Bucketed timestamp (UTC): DAY granularity → midnight; 5-min → floor.
-- Replaces the raw rate_date column as the join key for pinned rates.
ALTER TABLE public.exchange_rates
  ADD COLUMN IF NOT EXISTS bucket_ts TIMESTAMPTZ;

-- DAY | FIVE_MINUTES
ALTER TABLE public.exchange_rates
  ADD COLUMN IF NOT EXISTS bucket_granularity TEXT DEFAULT 'DAY';

-- CONFIRMED | PENDING (pending = provider failed, rate null until resolved)
ALTER TABLE public.exchange_rates
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'CONFIRMED';

-- FIAT_FIAT | FIAT_CRYPTO | CRYPTO_FIAT | CRYPTO_CRYPTO | IDENTITY | FIXED
ALTER TABLE public.exchange_rates
  ADD COLUMN IF NOT EXISTS source_kind TEXT;

ALTER TABLE public.exchange_rates
  ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;

-- PENDING rows have null rate, drop the NOT NULL constraint that was on
-- the original column.  ALTER COLUMN ... DROP NOT NULL is idempotent
-- (silently succeeds if already nullable).
do $$ begin
  alter table public.exchange_rates alter column rate drop not null;
exception when others then null;
end $$;

-- Backfill existing rows so queries on bucket_ts don't miss them.
UPDATE public.exchange_rates
  SET bucket_ts        = date_trunc('day', rate_date::timestamptz AT TIME ZONE 'UTC'),
      bucket_granularity = 'DAY',
      status           = 'CONFIRMED',
      confirmed_at     = fetched_at
  WHERE bucket_ts IS NULL;

-- New unique index for bucketed lookup.  Drop legacy unique first.
ALTER TABLE public.exchange_rates
  DROP CONSTRAINT IF EXISTS exchange_rates_base_currency_quote_currency_rate_date_provider_key;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'exchange_rates_bucket_uniq'
       and conrelid = 'public.exchange_rates'::regclass
  ) then
    alter table public.exchange_rates
      add constraint exchange_rates_bucket_uniq
      unique (base_currency, quote_currency, bucket_ts, bucket_granularity, provider);
  end if;
end $$;

-- Partial index for quickly finding unresolved PENDING rows.
CREATE INDEX IF NOT EXISTS idx_exchange_rates_pending
  ON public.exchange_rates (base_currency, quote_currency)
  WHERE status = 'PENDING';

COMMENT ON COLUMN public.exchange_rates.bucket_ts IS
  'UTC-floored timestamp for this rate bucket. DAY → midnight; FIVE_MINUTES → nearest 5-min boundary. Used as the pinned-rate join key.';
COMMENT ON COLUMN public.exchange_rates.bucket_granularity IS
  'DAY (free-tier) or FIVE_MINUTES (pro). Controls how rates are stored and deduped.';
COMMENT ON COLUMN public.exchange_rates.status IS
  'CONFIRMED = rate successfully fetched and stored. PENDING = provider failed; rate is NULL until manually resolved.';
COMMENT ON COLUMN public.exchange_rates.source_kind IS
  'FIAT_FIAT | FIAT_CRYPTO | CRYPTO_FIAT | CRYPTO_CRYPTO | IDENTITY | FIXED. Determines which rate-resolution path to use.';
COMMENT ON COLUMN public.exchange_rates.confirmed_at IS
  'When the rate was confirmed (= fetched_at for auto-fetched; manually set when a PENDING row is resolved).';

-- ============================================================
-- 2. journal_entry_lines, dual-amount encrypted columns
-- ============================================================

-- 2a. Four new ZKA-encrypted columns (TEXT = base64 AES-GCM ciphertext).
--     Nullable: pre-dual rows never get these populated; read path falls back
--     to encrypted_debit / encrypted_credit for those rows.

-- Signed wallet-currency amount (positive = debit, negative = credit).
-- ZKA: encrypted; unit = wallet_currency.
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS encrypted_amount_native TEXT;

-- Wallet-currency amount translated to primary currency at posting date.
-- ZKA: encrypted; unit = primary_currency_at_posting. NULL if rate_pending.
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS encrypted_amount_primary TEXT;

-- Exchange rate used: wallet_currency → primary_currency (ratio, e.g.
-- 1,111,111 MXN/BTC).  ZKA: encrypted; unit = primary per wallet unit.
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS encrypted_posted_rate TEXT;

-- Wallet currency for this specific line (TEXT → ciphertext of 3–4 char
-- ISO/ticker code, e.g. "MXN", "BTC", "SATS").  Needed for compound
-- cross-currency JEs where different lines have different wallet currencies.
-- ZKA: encrypted.
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS encrypted_wallet_currency TEXT;

-- 2b. Plaintext metadata columns (same privacy baseline as existing date
--     columns, disclosed at ZKA L2 as necessary metadata leakage).

-- FK to the exchange_rates row whose rate was pinned.  NULL for pre-dual
-- rows and for PENDING rows.
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS pinned_rate_id UUID
  REFERENCES public.exchange_rates(id) ON DELETE SET NULL;

-- True when the rate could not be resolved at posting time.  The line is
-- included in the ledger but excluded from reports until resolved.
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS rate_pending BOOLEAN NOT NULL DEFAULT false;

-- The UTC timestamp of the rate bucket used for this line (mirrors
-- exchange_rates.bucket_ts for the pinned row).
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS rate_asof TIMESTAMPTZ;

-- Whether the dual-amount encrypted fields have been populated for this
-- row.  FALSE for rows created before this migration; the backfill page
-- (Part 8) flips this to TRUE.
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS dual_amounts_backfilled BOOLEAN NOT NULL DEFAULT false;

-- The org's primary currency that was in effect when this line was posted.
-- Stays pinned forever; used to handle post-cutoff primary-currency changes.
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS primary_currency_at_posting TEXT;

-- Free-text reason the user provided when entering a rate manually
-- (populated only when rate was manually entered; NULL otherwise).
-- Non-null implies manual_rate_source is also non-null.
-- Minimum 40 characters enforced by the application layer.
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS manual_rate_reason TEXT;

-- Where the manually entered rate came from (e.g. "OANDA.com",
-- "CPA-quoted", "Spot rate from bank", "Other").
ALTER TABLE public.journal_entry_lines
  ADD COLUMN IF NOT EXISTS manual_rate_source TEXT;

-- Partial index: quickly find lines still needing backfill.
CREATE INDEX IF NOT EXISTS idx_jel_backfill_pending
  ON public.journal_entry_lines (journal_entry_id)
  WHERE dual_amounts_backfilled = false;

-- Partial index: quickly count / resolve pending-rate lines.
CREATE INDEX IF NOT EXISTS idx_jel_rate_pending
  ON public.journal_entry_lines (journal_entry_id)
  WHERE rate_pending = true;

-- Backfill dual_amounts_backfilled = true for rows that already have
-- encrypted_debit populated (pre-dual rows that have been encrypted at
-- L2 but not yet dual-amount-aware).  These rows are NOT backfilled for
-- amounts yet, just marked so the backfill page knows they're pre-dual.
-- (The backfill page will set them back to false before processing.)
-- NOTE: intentionally left as false for all rows so the admin page can
-- process them properly; this comment documents the decision.

COMMENT ON COLUMN public.journal_entry_lines.encrypted_amount_native IS
  'ZKA L2: signed wallet-currency amount (debit positive, credit negative). Unit = encrypted_wallet_currency.';
COMMENT ON COLUMN public.journal_entry_lines.encrypted_amount_primary IS
  'ZKA L2: amount translated to primary currency at posting date. Unit = primary_currency_at_posting. NULL when rate_pending.';
COMMENT ON COLUMN public.journal_entry_lines.encrypted_posted_rate IS
  'ZKA L2: exchange rate ratio (primary per wallet unit) pinned at posting. Immutable after insert.';
COMMENT ON COLUMN public.journal_entry_lines.encrypted_wallet_currency IS
  'ZKA L2: ISO/ticker code of the wallet currency for this line. Enables compound cross-currency JEs.';
COMMENT ON COLUMN public.journal_entry_lines.pinned_rate_id IS
  'FK to exchange_rates row whose rate was used. NULL for pre-dual rows and PENDING rows.';
COMMENT ON COLUMN public.journal_entry_lines.rate_pending IS
  'True when rate could not be resolved at posting. Line excluded from formal reports until resolved.';
COMMENT ON COLUMN public.journal_entry_lines.rate_asof IS
  'UTC bucket_ts of the pinned exchange rate. Mirrors exchange_rates.bucket_ts for the pinned row.';
COMMENT ON COLUMN public.journal_entry_lines.dual_amounts_backfilled IS
  'False = row was created before the dual-currency system and has not been backfilled yet. Admin backfill page processes these.';
COMMENT ON COLUMN public.journal_entry_lines.primary_currency_at_posting IS
  'Plaintext: the org primary currency in effect when this line was posted. Immutable; survives primary-currency changes.';
COMMENT ON COLUMN public.journal_entry_lines.manual_rate_reason IS
  'Non-null only when rate was entered manually. Reason text (≥40 chars enforced by app). Appears in Rate Transparency audit log.';
COMMENT ON COLUMN public.journal_entry_lines.manual_rate_source IS
  'Non-null only when rate was entered manually. Source identifier (e.g. "OANDA.com", "CPA-quoted").';

-- ============================================================
-- 3. org_primary_currency_history, audit log for primary
--    currency changes
-- ============================================================

CREATE TABLE IF NOT EXISTS public.org_primary_currency_history (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id            UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- The primary currency that was in effect during this era.
  primary_currency  TEXT NOT NULL,
  -- Inclusive start of this era (UTC date).
  effective_from    DATE NOT NULL,
  -- Exclusive end of this era; NULL means this is the current era.
  effective_to      DATE,
  -- The org member who made the change.
  changed_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Mandatory audit reason (≥40 chars enforced by app, CHECK ensures minimum).
  reason            TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT ophch_reason_min_length CHECK (char_length(reason) >= 40)
);

CREATE INDEX IF NOT EXISTS idx_ophch_org_id
  ON public.org_primary_currency_history (org_id, effective_from);

ALTER TABLE public.org_primary_currency_history ENABLE ROW LEVEL SECURITY;

-- Org members can read their own history.
do $$ begin
  if not exists (
    select 1 from pg_policies
     where tablename = 'org_primary_currency_history'
       and policyname = 'ophch_select'
  ) then
    execute $pol$
      CREATE POLICY "ophch_select"
        ON public.org_primary_currency_history
        FOR SELECT TO authenticated
        USING (
          org_id IN (
            SELECT org_id FROM public.org_members WHERE user_id = auth.uid()
          )
        )
    $pol$;
  end if;
end $$;

-- Only owners can insert / update.
do $$ begin
  if not exists (
    select 1 from pg_policies
     where tablename = 'org_primary_currency_history'
       and policyname = 'ophch_owner_write'
  ) then
    execute $pol$
      CREATE POLICY "ophch_owner_write"
        ON public.org_primary_currency_history
        FOR ALL TO authenticated
        USING (
          org_id IN (
            SELECT org_id FROM public.org_members
             WHERE user_id = auth.uid() AND role = 'OWNER'
          )
        )
        WITH CHECK (
          org_id IN (
            SELECT org_id FROM public.org_members
             WHERE user_id = auth.uid() AND role = 'OWNER'
          )
        )
    $pol$;
  end if;
end $$;

-- Seed one history row per org using current primary_currency so the table
-- is never empty for existing orgs.
INSERT INTO public.org_primary_currency_history
  (org_id, primary_currency, effective_from, reason)
SELECT
  o.id,
  COALESCE(s.primary_currency, 'USD'),
  CURRENT_DATE,
  'Initial record created by dual-currency migration (20260419000000).'
FROM public.organizations o
LEFT JOIN public.org_settings s ON s.org_id = o.id
WHERE NOT EXISTS (
  SELECT 1 FROM public.org_primary_currency_history h WHERE h.org_id = o.id
);

COMMENT ON TABLE public.org_primary_currency_history IS
  'Audit log of every primary-currency change for an org. Rows are immutable after insert. Used to determine primary_currency_at_posting for historical JE lines.';

-- ============================================================
-- 4. org_settings, FX translation method + accounting
--    framework
-- ============================================================

-- closing-rate   : all amounts at the report-date spot rate (fast, dashboards)
-- period-average : income statement at avg rate, balance sheet at closing rate
-- historical-per-transaction : each line at its own posting-date rate (IFRS strict)
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS fx_translation_method TEXT
  NOT NULL DEFAULT 'historical-per-transaction'
  CHECK (fx_translation_method IN
    ('closing-rate', 'period-average', 'historical-per-transaction'));

-- IFRS | US_GAAP | IFRS_AND_GAAP
ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS accounting_framework TEXT
  NOT NULL DEFAULT 'IFRS'
  CHECK (accounting_framework IN ('IFRS', 'US_GAAP', 'IFRS_AND_GAAP'));

COMMENT ON COLUMN public.org_settings.fx_translation_method IS
  'Default method for translating primary-currency amounts to secondary. Overridable per-report. See OWB-MultiCurrency-Brain.md §5.';
COMMENT ON COLUMN public.org_settings.accounting_framework IS
  'IFRS | US_GAAP | IFRS_AND_GAAP. Controls revaluation rules, disclosure language, and export audit footer. See OWB-MultiCurrency-Brain.md §8.';

-- ============================================================
-- 5. fx_revaluation_runs, period-close revaluation audit log
-- ============================================================

CREATE TABLE IF NOT EXISTS public.fx_revaluation_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  -- The accounting period covered.
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  -- When this run was initiated and by whom.
  run_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Snapshot of settings at time of run (so changing settings later
  -- does not retroactively alter the revaluation record).
  framework       TEXT NOT NULL,
  method          TEXT NOT NULL,
  -- draft → posted → reversed (auto-reversal on period_end + 1 day).
  status          TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'posted', 'reversed')),
  -- Date on which the auto-reversal entry should be / was posted.
  reverse_on      DATE,
  -- FK to the revaluation JE and its reversal JE.
  je_id           UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  reverse_je_id   UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fxrr_org_period
  ON public.fx_revaluation_runs (org_id, period_end DESC);

CREATE INDEX IF NOT EXISTS idx_fxrr_pending_reversal
  ON public.fx_revaluation_runs (reverse_on)
  WHERE status = 'posted';

ALTER TABLE public.fx_revaluation_runs ENABLE ROW LEVEL SECURITY;

-- Only owners can see and write revaluation runs.
do $$ begin
  if not exists (
    select 1 from pg_policies
     where tablename = 'fx_revaluation_runs'
       and policyname = 'fxrr_owner_all'
  ) then
    execute $pol$
      CREATE POLICY "fxrr_owner_all"
        ON public.fx_revaluation_runs
        FOR ALL TO authenticated
        USING (
          org_id IN (
            SELECT org_id FROM public.org_members
             WHERE user_id = auth.uid() AND role = 'OWNER'
          )
        )
        WITH CHECK (
          org_id IN (
            SELECT org_id FROM public.org_members
             WHERE user_id = auth.uid() AND role = 'OWNER'
          )
        )
    $pol$;
  end if;
end $$;

COMMENT ON TABLE public.fx_revaluation_runs IS
  'One row per FX revaluation run at period close. Tracks the generated JE, auto-reversal JE, and settings snapshot. Immutable after posted status.';
COMMENT ON COLUMN public.fx_revaluation_runs.status IS
  'draft = preview computed, not yet posted. posted = JE committed, reversal scheduled. reversed = auto-reversal JE posted.';
COMMENT ON COLUMN public.fx_revaluation_runs.reverse_on IS
  'The date on which the auto-reversal JE should post (= period_end + 1 day). Populated when status moves to posted.';
COMMENT ON COLUMN public.fx_revaluation_runs.framework IS
  'Snapshot of org_settings.accounting_framework at run time.';
COMMENT ON COLUMN public.fx_revaluation_runs.method IS
  'Snapshot of org_settings.fx_translation_method at run time.';
