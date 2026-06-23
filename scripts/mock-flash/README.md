# Mock Flash server

Stand-in for Flash Connect during local development. Lets the Vault
stack exercise the full pay flow without real credentials or network.

## Run

```bash
FLASH_WEBHOOK_SECRET=devsecret \
WEBHOOK_TARGET_URL=http://localhost:54321/functions/v1/flash-webhook \
deno run --allow-net --allow-env scripts/mock-flash/server.ts
```

Listens on `http://localhost:8787`. Override with `PORT=...`.

## Endpoints

- `POST /oauth/token`, returns fake `access_token`, `refresh_token`,
  `expires_in: 3600`.
- `POST /payment-links`, returns `{ id, url, expiresAt }`. `url` points
  back at the mock at `/pay/:id`.
- `GET /pay/:id`, minimal "fake checkout" HTML with a "Mark as paid"
  form.
- `POST /pay/:id/complete`, flips the link to completed, HMAC-signs a
  `payment.completed` event with `FLASH_WEBHOOK_SECRET` (hex SHA-256 of
  the raw body), POSTs it to `WEBHOOK_TARGET_URL` with header
  `X-Flash-Signature`.

## Vault-side env vars

Note: set `MOCK_FLASH=false` so the Vault edge functions perform real
HTTP calls, they just point at the mock instead of api.paywithflash.com.

```
MOCK_FLASH=false
FLASH_BASE_URL=http://localhost:8787
MOCK_FLASH_PUBLIC_URL=http://localhost:8787
FLASH_OAUTH_TOKEN_URL=http://localhost:8787/oauth/token
FLASH_CLIENT_ID=mock-client
FLASH_CLIENT_SECRET=mock-secret
FLASH_WEBHOOK_SECRET=devsecret
```

## E2E test coverage (2026-06-01)

`flash-flow.spec.ts` steps 05-10 currently `test.skip()` when MOCK_FLASH_URL is unreachable. To make them honestly run requires the full local stack:

1. `supabase start`, local Postgres + edge function emulator
2. `deno run --allow-net --allow-env scripts/mock-flash/server.ts`, this server on :8787
3. `npm run dev` with `VITE_FLASH_BASE_URL=http://localhost:8787` etc., local SPA build with mock URLs baked in
4. `PLAYWRIGHT_BASE_URL=http://localhost:5173 npx playwright test tests/e2e/flash-flow.spec.ts`

Once all three are running locally, the spec runs honestly. CI orchestration of the full stack is a separate effort, tracked as future work.

## In CI today (2026-06-01)

A lighter-weight `tests/e2e/flash-webhook-smoke.spec.ts` covers the security-critical HMAC path directly: posts an unsigned event (expects 401), posts a wrong-signature event (expects 401), and (when `FLASH_WEBHOOK_SECRET` is in env) posts a correctly-signed event (expects 200/202). This catches the most important Flash regressions, webhook signature forgery, without needing the full mock-flash UI stack.
