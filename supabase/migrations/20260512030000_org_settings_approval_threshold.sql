-- Track 4 PR C, approval threshold for payment requests
--
-- Adds two encrypted columns to org_settings that capture the prior model's
-- approvalThresholdAmount / approvalThresholdCurrency rule: any new payment
-- request whose amount (in the chosen currency) exceeds the threshold is
-- auto-flagged as PENDING on submit, regardless of who created it. This is
-- the "any invoice over $5,000 auto-flags for approval no matter who's the
-- requester" guardrail that bookkeeping teams expect.
--
-- Both columns are nullable. NULL means "no threshold set" → the existing
-- behavior persists (the requester picks DRAFT or PENDING manually).
--

ALTER TABLE public.org_settings
  ADD COLUMN IF NOT EXISTS encrypted_approval_threshold_amount TEXT NULL,
  ADD COLUMN IF NOT EXISTS encrypted_approval_threshold_currency TEXT NULL;

COMMENT ON COLUMN public.org_settings.encrypted_approval_threshold_amount IS
  'Approval threshold (amount). When set, any payment_request submitted with amount > threshold is auto-flagged PENDING regardless of submitter. AES-256-GCM encrypted under the org MEK. NULL = no threshold.';

COMMENT ON COLUMN public.org_settings.encrypted_approval_threshold_currency IS
  'Currency code paired with encrypted_approval_threshold_amount (e.g. USD, BTC). Encrypted. NULL when threshold itself is NULL.';
