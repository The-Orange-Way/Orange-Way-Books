# Pay-with-Flash E2E tests

A single Playwright spec (`flash-flow.spec.ts`) that walks the full
Pay-with-Flash flow end-to-end and emits 10 numbered, captioned
screenshots. The output is shipped to Flash so Bram can confirm our
integration matches their spec.

## Pre-flight: three terminals must be live

Playwright's `globalSetup` will fail fast with a useful message if any
of these are missing, so you can't accidentally run the spec against
half a stack.

**Terminal 1, Supabase local**

```bash
supabase start
```

Wait until you see `API URL: http://127.0.0.1:54321`.

**Terminal 2, Mock Flash server**

```bash
FLASH_WEBHOOK_SECRET=devsecret \
WEBHOOK_TARGET_URL=http://localhost:54321/functions/v1/flash-webhook \
deno run --allow-net --allow-env scripts/mock-flash/server.ts
```

Listens on `http://localhost:8787`. See `scripts/mock-flash/README.md`
for the matching `MOCK_FLASH=false`, `FLASH_BASE_URL=...` env vars the
Vault edge functions need.

**Terminal 3, Vault dev server**

```bash
npm run dev
```

Listens on `http://localhost:8080`.

## Run the tests

```bash
npm run test:e2e             # headless
npm run test:e2e:headed      # watch it run
npm run test:e2e:screenshots # run + rebuild SCREENSHOTS.md
```

Output:

- `tests/e2e/__screenshots__/01-signup.png` … `10-payment-history.png`
- `tests/e2e/__screenshots__/captions.json`, machine-readable
  captions, written as each step completes.
- `tests/e2e/__screenshots__/SCREENSHOTS.md`, the human-readable
  deliverable. Send this (or its rendered form on GitHub) to Bram.
- `tests/e2e/__report__/`, Playwright HTML report.
- `tests/e2e/__artifacts__/`, videos / traces for any failed step.

## What it does NOT do

- **No DB reset between runs.** Each `test:e2e` invocation uses a
  fresh timestamped email (`flash-e2e+<ts>@owb.test`) for signup.
  Re-running won't pollute state across runs, but the deterministic
  trial / past_due / active states still require manual SQL between
  runs (see `tests/integration/flash/MANUAL.md` for the backdate
  snippet). Step 06 will screenshot whatever subscription state is
  current at the time.
- **No real Flash credentials.** Everything talks to the local mock.
  When Bram ships real `FLASH_CLIENT_ID` / `FLASH_CLIENT_SECRET` and
  the production `FLASH_BASE_URL`, the same spec runs unchanged
  against the real Flash by pointing `FLASH_BASE_URL` at
  `api.paywithflash.com`.
- **No cross-browser matrix.** Chromium only. Bram doesn't need
  Firefox / WebKit proof; he needs to see the flow.

## Test credentials (CI + local sign-in flows)

Specs that sign in to books.orangeway.dev use a dedicated, stable
OWB DEV test user provisioned by `tests/e2e/scripts/provision-e2e-user.js`.

Three values must exist in repo secrets for CI:

- `OWB_DEV_E2E_EMAIL`
- `OWB_DEV_E2E_PASSWORD`
- `OWB_DEV_E2E_VAULT_PASSWORD`

The canonical copy lives encrypted at `/opt/orangeway/.env.sops` on Jarvis
(same SOPS keyring as the rest of the Orange Way vault).

**Provisioning a new test user (first time / after a wipe):**

```bash
# On a machine with OWB DEV Supabase service-role creds in
# /tmp/owb-pw/owb-dev-supabase.json:
node tests/e2e/scripts/provision-e2e-user.js
# Output: /tmp/owb-pw/e2e-creds.json with email / password / vault_password.
# The script is idempotent, re-running against an already-onboarded user
# just confirms the credentials still unlock the vault.
```

After provisioning, copy the three values into the matching repo secrets
(via `gh secret set`) and into `/opt/orangeway/.env.sops` on Jarvis.

**Rotating the password:** update the encrypted vault first (canonical),
then update the three repo secrets to match.

## Selectors

Selectors prefer `data-testid` where the product code carries one,
otherwise role-based (`getByRole('button', { name: /Connect Flash/i })`)
or text content. If you change a button label in the product, the
e2e spec breaks loudly, fix the selector rather than chasing the
screenshot.
