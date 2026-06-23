# Flash Wave 1, manual integration test plan

The project does not yet have a local-supabase test harness wired into Vitest, so
the scenarios below are documented as a checklist a human (or a
Playwright job in a follow-up) can run against a local
`supabase start` + the mock-flash server.

## Prereqs

1. `supabase start` from the repo root.
2. In another shell, start the mock:
   ```bash
   FLASH_WEBHOOK_SECRET=devsecret \
   WEBHOOK_TARGET_URL=http://localhost:54321/functions/v1/flash-webhook \
   deno run --allow-net --allow-env scripts/mock-flash/server.ts
   ```
3. Edge function env (`supabase/.env.local` or per-function secrets):
   ```
   MOCK_FLASH=false
   FLASH_BASE_URL=http://localhost:8787
   MOCK_FLASH_PUBLIC_URL=http://localhost:8787
   FLASH_OAUTH_TOKEN_URL=http://localhost:8787/oauth/token
   FLASH_CLIENT_ID=mock-client
   FLASH_CLIENT_SECRET=mock-secret
   FLASH_WEBHOOK_SECRET=devsecret
   CRON_SECRET=devcron
   ```
4. Run migrations: `supabase db push` (or restart `supabase start`).
5. Seed the platform-token row (mock OAuth callback is the easiest path):
   - sign in to the SPA as an OWNER, visit `/app/admin/flash`, click
     Connect; the FlashCallback page will hand `(code, state)` to
     `flash-oauth-callback` which calls `/oauth/token` on the mock and
     upserts `flash_platform_tokens`.

## Scenarios

### 1. Org creation auto-provisions billing

- Sign up a new user; complete the onboarding wizard to create one
  organization.
- Expected: `organizations.billing_account_id` is non-null, a
  `billing_accounts` row exists owned by the new user, and a
  `subscriptions` row exists with `status='trialing'` and `trial_ends_at`
  about 45 days out.

### 2. Trial expiry → past_due

- Manually backdate the trialing subscription:
  ```sql
  update subscriptions set trial_ends_at = now() - interval '1 day';
  ```
- Trigger the cron:
  ```bash
  curl -X POST -H "X-Cron-Secret: devcron" \
    http://localhost:54321/functions/v1/subscription-lifecycle
  ```
- Expected: `status='past_due'`, `past_due_since` set, a
  `subscription_lifecycle_events` row appended.

### 3. Pay → mock checkout → webhook → active

- On `/app/billing`, click the Pay button. Browser navigates to the
  mock checkout page.
- Click "Mark as paid". The mock POSTs an HMAC-signed
  `payment.completed` event to `flash-webhook`.
- Expected: `flash_payments.status='completed'` with fee fields set,
  subscription `status='active'`, `current_period_end ≈ now() + 30d`,
  `past_due_since` cleared.

### 4. Duplicate webhook is idempotent

- Re-post the same event body + signature to `flash-webhook` with
  `curl`. Re-applying must not change the subscription further; the
  flash_payments row stays `completed`; an extra row lands in
  `flash_payment_events` (audit), no extra row in
  `subscription_lifecycle_events`.

### 5. Tampered webhook signature → 401

- POST the same body with a wrong `X-Flash-Signature`. Expected: 401,
  no DB changes, no `flash_payment_events` row.

### 6. Failed payment inside active period

- With subscription `status='active'` and `current_period_end > now()`,
  POST an HMAC-signed `payment.failed` event for a fresh
  `external_reference`. Expected: the matching `flash_payments` row
  flips to `failed`, the subscription stays `active`.

## Idempotency-Key check (create-flash-payment)

- Call `create-flash-payment` twice with the same
  `Idempotency-Key: <uuid>` within 10 minutes.
- Expected: second response has `idempotent: true` and the same
  `flashPaymentId` + `url`.
