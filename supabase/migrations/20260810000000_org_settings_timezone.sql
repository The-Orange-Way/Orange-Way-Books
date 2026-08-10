-- DL-0721: Add timezone column to public.org_settings.
--
-- The frontend has a full timezone setting (src/pages/Admin.tsx,
-- src/components/onboarding/OnboardingWizard.tsx, StepReporting.tsx,
-- src/hooks/useOrgSettings.ts) and decryptOrgSettings() reads row.timezone,
-- but the value was never persisted for two reasons:
--   1. org_settings had no timezone column (this migration adds it).
--   2. encryptOrgSettings() in src/lib/crypto-fields.ts accepted a timezone
--      field but never encrypted it or included it in its output object
--      (fixed in the same PR).
-- Result before this change: every save silently dropped the chosen
-- timezone, and on read useOrgSettings.ts and Admin.tsx coerced the null to
-- the browser zone, so a dropped value never even read as dropped.
--
-- The column is NULLABLE and holds encrypted-text ciphertext (the frontend
-- encrypts before write via crypto-fields.ts), matching date_format,
-- time_format and the other in-place encrypted columns.

ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS timezone TEXT NULL;

COMMENT ON COLUMN public.org_settings.timezone IS 'Encrypted ciphertext: org reporting timezone (IANA name). NULL until the user picks one; reads fall back to the browser zone.';

NOTIFY pgrst, 'reload schema';
