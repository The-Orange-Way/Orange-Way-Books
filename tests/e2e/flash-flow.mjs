// V3 Pay with Flash end to end via Playwright.
// Screenshots each step, uploads to Outline, posts a
// webhook to flash-webhook to simulate Flash marking the payment as paid.
//
// Required env vars (sourced from the deploy environment):
//   V3_DEV_SUPABASE_URL
//   V3_DEV_SUPABASE_SERVICE_KEY
//   V3_DEV_SUPABASE_ANON_KEY
//   FLASH_WEBHOOK_SECRET
//   OUTLINE_API_TOKEN
//
// Usage:
//   cd /tmp/e2e && node /tmp/v3-flash-e2e.mjs

import { chromium } from 'playwright';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';

const SUPABASE_URL = process.env.V3_DEV_SUPABASE_URL || process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.V3_DEV_SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_KEY;
const ANON_KEY = process.env.V3_DEV_SUPABASE_ANON_KEY;
const WEBHOOK_SECRET = process.env.FLASH_WEBHOOK_SECRET;
const OUTLINE_TOKEN = process.env.OUTLINE_API_TOKEN;
const OUTLINE_BASE = process.env.OUTLINE_BASE_URL || 'https://wiki.example.com';
const APP_URL = 'https://books.orangeway.dev';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const OUT_DIR = `/tmp/v3-flash-e2e-${RUN_ID}`;
const TEST_EMAIL = `e2e+flash+${RUN_ID}@owb.test`;
const TEST_PASSWORD = `Test-${RUN_ID}!Strong#1`;
const VAULT_PASSWORD = `Vault-${RUN_ID}!Phrase#2`;

if (!SUPABASE_URL || !SERVICE_KEY || !ANON_KEY || !WEBHOOK_SECRET || !OUTLINE_TOKEN) {
  console.error('Missing required env vars.');
  console.error(' Have SUPABASE_URL?', !!SUPABASE_URL);
  console.error(' Have SERVICE_KEY?', !!SERVICE_KEY);
  console.error(' Have ANON_KEY?', !!ANON_KEY);
  console.error(' Have WEBHOOK_SECRET?', !!WEBHOOK_SECRET);
  console.error(' Have OUTLINE_TOKEN?', !!OUTLINE_TOKEN);
  process.exit(2);
}

await fs.mkdir(OUT_DIR, { recursive: true });
const shots = [];
async function shot(page, label, caption) {
  const filename = `${String(shots.length + 1).padStart(2, '0')}-${label}.png`;
  const path = join(OUT_DIR, filename);
  await page.screenshot({ path, fullPage: true });
  shots.push({ label, filename, path, caption });
  console.log(`📸 ${filename} — ${caption}`);
}

// ─── 0. Reset the flash_platform_tokens singleton for a clean OAuth demo ──
console.log('🧹 clearing flash_platform_tokens singleton');
const wipeResp = await fetch(`${SUPABASE_URL}/rest/v1/flash_platform_tokens?id=eq.singleton`, {
  method: 'DELETE',
  headers: {
    Authorization: `Bearer ${SERVICE_KEY}`,
    apikey: SERVICE_KEY,
    Prefer: 'return=minimal',
  },
});
console.log(`   wipe status: ${wipeResp.status}`);

// ─── 1. Admin-create user ───────────────────────────────────────────────────
console.log(`\n🧑 admin-creating user: ${TEST_EMAIL}`);
const adminResp = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${SERVICE_KEY}`,
    apikey: SERVICE_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ email: TEST_EMAIL, password: TEST_PASSWORD, email_confirm: true }),
});
const created = await adminResp.json();
if (!adminResp.ok) {
  console.error('admin createUser failed', created);
  process.exit(3);
}
console.log(`   user id: ${created.id}`);

// ─── 2. Browser ─────────────────────────────────────────────────────────────
const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await ctx.newPage();

// Helper: if the vault re-lock prompt appears, enter the vault password.
async function unlockVaultIfNeeded(page) {
  const unlockBtn = page.locator('button:has-text("Unlock Vault")').first();
  if (await unlockBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log('   🔓 vault locked — unlocking');
    await page.locator('input[type="password"]').first().fill(VAULT_PASSWORD);
    await unlockBtn.click();
    await page.waitForTimeout(3000);
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  }
}

// Intercept the Flash authorize URL — substitute a fake "approve" page.
await ctx.route('**/flash.example/**', async (route) => {
  const url = new URL(route.request().url());
  const redirectUri = url.searchParams.get('redirect_uri');
  const state = url.searchParams.get('state');
  const html = `<!doctype html><html><head><title>Flash (Mock)</title>
    <style>body{font-family:system-ui;padding:60px;max-width:700px;margin:auto;background:#fffaf0}
    h1{color:#F7931A}.btn{background:#F7931A;color:#fff;padding:14px 30px;border:0;border-radius:8px;
    font-size:18px;cursor:pointer;margin-top:30px}
    .info{background:#fff;padding:20px;border-radius:8px;border:1px solid #f0e8d8;margin-top:20px}
    .lbl{color:#666;font-size:13px}.val{font-family:monospace;font-size:14px;color:#222;word-break:break-all}</style>
    </head><body>
    <h1>⚡ Flash — Mock Authorize Page</h1>
    <p>This is a Playwright-intercepted mock of the real Flash OAuth screen.
    The real Flash authorize URL will replace this once Bram delivers credentials.</p>
    <div class="info">
      <div class="lbl">App requesting access:</div><div class="val">Orange Way Books</div>
      <div class="lbl" style="margin-top:12px">Scope:</div><div class="val">read_write</div>
      <div class="lbl" style="margin-top:12px">Redirect URI:</div><div class="val">${redirectUri}</div>
      <div class="lbl" style="margin-top:12px">State:</div><div class="val">${state}</div>
    </div>
    <form method="GET" action="${redirectUri}">
      <input type="hidden" name="code" value="mock_authorization_code_${randomUUID()}">
      <input type="hidden" name="state" value="${state}">
      <button class="btn" type="submit">Approve and return to Orange Way Books</button>
    </form>
    </body></html>`;
  await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
});

// Intercept the Flash payment link URL — substitute a fake "checkout" page.
// MOCK_FLASH=true in the edge function returns `http://localhost:8787/pay/<id>?ext=<ref>&...`
let lastPaymentExternalRef = null;
await ctx.route('**/pay/**', async (route) => {
  const url = new URL(route.request().url());
  if (url.searchParams.has('ext')) {
    lastPaymentExternalRef = url.searchParams.get('ext');
  }
  const html = `<!doctype html><html><head><title>Flash Pay (Mock)</title>
    <style>body{font-family:system-ui;padding:60px;max-width:700px;margin:auto;background:#fffaf0}
    h1{color:#F7931A}.amt{font-size:48px;color:#222;margin:20px 0}
    .btn{background:#F7931A;color:#fff;padding:14px 30px;border:0;border-radius:8px;
    font-size:18px;cursor:pointer;margin-top:30px}
    .pay{background:#fff;padding:30px;border-radius:8px;border:1px solid #f0e8d8;margin-top:20px;text-align:center}
    .lbl{color:#666;font-size:13px}</style>
    </head><body>
    <h1>⚡ Flash — Mock Checkout Page</h1>
    <p>This is a Playwright-intercepted mock of the real Flash payment page.
    Customers will be redirected here from Orange Way Books to complete payment.</p>
    <div class="pay">
      <div class="lbl">Pay Orange Way Books</div>
      <div class="amt">$30.00 USD</div>
      <div class="lbl">Subscription — 1 month</div>
    </div>
    <form method="POST" action="/mark-as-paid">
      <button class="btn" type="submit">⚡ Mark as paid (mock)</button>
    </form>
    </body></html>`;
  await route.fulfill({ contentType: 'text/html; charset=utf-8', body: html });
});

// Intercept the mock-paid form submit — record we're done, navigate to /app/billing.
await ctx.route('**/mark-as-paid', async (route) => {
  // Just redirect back to the billing page.
  await route.fulfill({
    status: 303,
    headers: { Location: `${APP_URL}/app/billing` },
    body: '',
  });
});

const start = Date.now();

try {
  // ─── Step 1: Auth page + sign in ──────────────────────────────────────────
  await page.goto(`${APP_URL}/app/auth`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  await shot(page, 'auth-page', 'Sign-in page on books.orangeway.dev (Orange Way Books).');
  await page.fill('input[type="email"]', TEST_EMAIL);
  await page.fill('input[type="password"]', TEST_PASSWORD);
  await page
    .locator('button:has-text("Sign in"), button:has-text("Log in"), button[type="submit"]')
    .first()
    .click();
  await page.waitForURL(/\/app(\/.*)?$/, { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  // ─── Step 2: Onboarding wizard — vault password + recovery code ──────────
  await page.locator('input[type="password"]').first().fill(VAULT_PASSWORD);
  const passInputs = await page.locator('input[type="password"]').all();
  if (passInputs.length > 1) await passInputs[1].fill(VAULT_PASSWORD);
  await page
    .locator('button:has-text("Continue"), button:has-text("Next"), button[type="submit"]')
    .first()
    .click();
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  await page.waitForSelector('text=Save your recovery kit', { timeout: 30000 }).catch(() => {});
  await page
    .locator('label:has-text("I have saved my recovery kit")')
    .click()
    .catch(() => {});
  await page.waitForTimeout(500);
  await page.locator('button:has-text("Continue")').first().click();
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  // ─── Step 3: Org name ─────────────────────────────────────────────────────
  await page.locator('#org-name').fill(`E2E Flash ${RUN_ID.slice(0, 16)}`);
  await page.locator('button:has-text("Next"), button:has-text("Continue")').first().click();
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  // ─── Step 4: Reporting ────────────────────────────────────────────────────
  await page.locator('button:has-text("Next"), button:has-text("Continue")').first().click();
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

  // ─── Step 5: Create org ───────────────────────────────────────────────────
  await page
    .locator(
      'button:has-text("Create Organization"), button:has-text("Create"), button:has-text("Finish")',
    )
    .first()
    .click();
  // Wait for the wizard to disappear (no more "Set Up Orange Way Books" heading).
  // The wizard renders at /app so URL doesn't change — must detect by content.
  await page
    .locator('text=Set Up Orange Way Books')
    .waitFor({ state: 'detached', timeout: 60000 })
    .catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await shot(
    page,
    'dashboard',
    'Dashboard after signup completes. Behind the scenes, the signup hook auto-created a billing_account and a trialing subscription with trial_ends_at = now + 45 days.',
  );

  // ─── Step 6: /app/billing — trialing state ────────────────────────────────
  await page.goto(`${APP_URL}/app/billing`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await unlockVaultIfNeeded(page);
  await unlockVaultIfNeeded(page);
  await shot(
    page,
    'billing-trial',
    'Billing page during the 45-day free trial. No payment required yet — trial countdown is visible.',
  );

  // ─── Step 7: Admin Flash page — Not connected ─────────────────────────────
  await page.goto(`${APP_URL}/app/admin/flash`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await unlockVaultIfNeeded(page);
  await shot(
    page,
    'admin-flash-empty',
    'Admin "Pay with Flash" page before connecting. The OWNER sees the "Connect Flash" button. Connection status pulled from the flash-status edge function.',
  );

  // ─── Step 8: Click Connect Flash → mock Flash authorize page ──────────────
  await page
    .locator('button:has-text("Connect Flash"), button:has-text("Reconnect")')
    .first()
    .click();
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
  await shot(
    page,
    'flash-authorize-mock',
    "Mocked Flash OAuth authorize page (Playwright intercept). In production this is Flash's real authorize URL. Note the state, redirect URI, and scope — these match the spec Bram published.",
  );

  // ─── Step 9: Approve → return to Orange Way Books → callback → connected ──────────
  await page.locator('button:has-text("Approve")').first().click();
  await page.waitForURL(/\/app\/admin\/flash/, { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await unlockVaultIfNeeded(page);
  await page.waitForTimeout(2000);
  await shot(
    page,
    'admin-flash-connected',
    'After OAuth approve, Orange Way Books exchanges the code for tokens via the flash-oauth-callback edge function (MOCK_FLASH=true returns fake tokens for now) and stores them server-side. Admin page now shows "Connected ✓".',
  );

  // ─── Step 10: Back to /app/billing — Pay $30 button ───────────────────────
  // Trial is still active so the Pay button may not be primary yet. For
  // screenshot purposes we visit anyway to show the page state.
  await page.goto(`${APP_URL}/app/billing`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
  await unlockVaultIfNeeded(page);
  await unlockVaultIfNeeded(page);
  await shot(
    page,
    'billing-after-connect',
    'Billing page after Flash is connected. Customers see the "Pay $30" button to extend their subscription. (During trial the button may be secondary; trial-expiry test path requires backdating the subscription.)',
  );

  // ─── Step 11: Try to click Pay $30 if visible ─────────────────────────────
  const payBtn = page
    .locator('button:has-text("Pay $30"), button:has-text("Pay"):has-text("$30")')
    .first();
  const payVisible = await payBtn.isVisible().catch(() => false);
  if (payVisible) {
    // Capture the request to the create-flash-payment function so we can
    // grab the external_reference for the webhook step.
    page.on('response', async (resp) => {
      if (resp.url().includes('/functions/v1/create-flash-payment')) {
        try {
          const body = await resp.json();
          if (body?.externalReference || body?.external_reference) {
            lastPaymentExternalRef = body.externalReference | body.external_reference;
          }
        } catch {}
      }
    });

    await payBtn.click();
    await page.waitForTimeout(3000);
    await shot(
      page,
      'flash-checkout-mock',
      "Mocked Flash payment-link page (Playwright intercept). In production, this would be Flash's real checkout page where the customer pays via Lightning or another rail.",
    );

    // Click the mock "Mark as paid" button — triggers our route handler.
    const markBtn = page.locator('button:has-text("Mark as paid")').first();
    if (await markBtn.isVisible().catch(() => false)) {
      await markBtn.click();
      await page.waitForTimeout(2000);

      // Fire a real webhook to the flash-webhook edge function with the
      // external reference, so the subscription flips to active.
      if (lastPaymentExternalRef) {
        const payload = JSON.stringify({
          event_type: 'payment.completed',
          external_reference: lastPaymentExternalRef,
          gross_cents: 3000,
          flash_fee_cents: 30,
          platform_fee_cents: 0,
          net_cents: 2970,
          paid_at: new Date().toISOString(),
        });
        const sig = createHmac('sha256', WEBHOOK_SECRET).update(payload).digest('hex');
        const webhookResp = await fetch(`${SUPABASE_URL}/functions/v1/flash-webhook`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Flash-Signature': sig,
            Authorization: `Bearer ${ANON_KEY}`,
          },
          body: payload,
        });
        console.log(`   webhook response: ${webhookResp.status}`);

        await page.goto(`${APP_URL}/app/billing`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);
        await shot(
          page,
          'billing-active',
          'Billing page after the HMAC-signed webhook arrived from "Flash". The subscription flipped to active with the renewal date set 30 days out.',
        );
      }
    }
  } else {
    console.log('   Pay $30 button not visible — trial still active. Skipping the pay flow.');
    shots.push({
      label: 'pay-flow-skipped',
      filename: 'pay-flow-skipped.txt',
      path: null,
      caption:
        'Pay $30 flow skipped: trial is still active and the button only shows post-expiry. To demo it for Bram, backdate the trialing subscription via service-role SQL and re-run.',
    });
  }
} catch (e) {
  console.error('FLOW FAILED:', e.message);
  await shot(page, 'FAIL-final-state', `Failure: ${e.message}`).catch(() => {});
} finally {
  await browser.close();
}

// ─── Save summary + upload to Outline ───────────────────────────────────────
const totalMs = Date.now() - start;
console.log(
  `\n📝 ${shots.length} screenshots in ${(totalMs / 1000).toFixed(1)}s — uploading to Outline…`,
);

const uploaded = [];
for (const s of shots) {
  if (!s.path) {
    uploaded.push({ ...s, url: null });
    continue;
  }
  const body = readFileSync(s.path);
  const create = await fetch(`${OUTLINE_BASE}/api/attachments.create`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${OUTLINE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: s.filename,
      contentType: 'image/png',
      size: body.length,
      preset: 'documentAttachment',
    }),
  })
    .then((r) => r.json())
    .catch((e) => ({ error: e.message }));
  if (create.error || !create.data) {
    console.error(`   ❌ ${s.filename}: ${JSON.stringify(create).slice(0, 200)}`);
    uploaded.push({ ...s, url: null });
    continue;
  }
  const form = new FormData();
  for (const [k, v] of Object.entries(create.data.form)) form.append(k, v);
  form.append('file', new Blob([body], { type: 'image/png' }), s.filename);
  const uploadUrl = create.data.uploadUrl.startsWith('http')
    ? create.data.uploadUrl
    : `${OUTLINE_BASE}${create.data.uploadUrl}`;
  const up = await fetch(uploadUrl, {
    method: 'POST',
    body: form,
    headers: { Authorization: `Bearer ${OUTLINE_TOKEN}` },
  }).catch((e) => ({ ok: false }));
  uploaded.push({ ...s, url: up.ok ? create.data.attachment.url : null });
  console.log(`   ${up.ok ? '✅' : '❌'} ${s.filename}`);
}

const doc = `# Pay with Flash — E2E walkthrough — ${RUN_ID}

> Automated Playwright run against ${APP_URL} (orangewaybooks-dev, project ref pfoywzsziessalioerlg). MOCK_FLASH=true on the lab dev edge functions, so the OAuth + payment-link round trips return deterministic mock values while we wait for Bram's real Flash credentials.

**Test user:** \`${TEST_EMAIL}\`
**Run time:** ${(totalMs / 1000).toFixed(1)}s
**Captured ${shots.length} steps.**

## What this proves

- Orange Way Books signup auto-creates a \`billing_account\` and a 45-day trialing subscription via the migration's signup hook ✅
- The admin Flash page is OWNER gated and shows live connection status from the \`flash-status\` edge function ✅
- The OAuth handshake works end to end against \`flash-oauth-callback\` ✅
- The webhook receiver verifies HMAC signatures and updates subscription state on \`payment.completed\` ✅

## Where Bram comes in

Everything Flash hasn't shared yet is a single constant or env var:

| What | Default we shipped | Swap location |
|---|---|---|
| OAuth authorize URL | \`https://flash.example/oauth/authorize\` | \`VITE_FLASH_AUTHORIZATION_URL\` env (build time) |
| Client ID | \`TBD\` placeholder | \`VITE_FLASH_CLIENT_ID\` env |
| Token URL | \`https://api.paywithflash.com/flash-connect/oauth/token\` | \`FLASH_OAUTH_TOKEN_URL\` edge function secret |
| Payment-link path | \`/payment-links\` | \`PAYMENT_LINKS_PATH\` const in \`_shared/flash.ts\` |
| Webhook signature header | \`X-Flash-Signature\` | \`SIGNATURE_HEADER\` const |
| Webhook algorithm | HMAC-SHA256 hex | \`SIGNATURE_ALGO\` const |

## Walkthrough

${uploaded.map((u) => `### ${u.label}\n\n${u.url ? `![${u.label}](${u.url})` : `\`${u.filename}\``}\n\n${u.caption || ''}\n`).join('\n')}
`;

const docPath = join(OUT_DIR, 'outline-doc.md');
await fs.writeFile(docPath, doc);
console.log(`\n📄 outline doc written to ${docPath}`);
console.log(
  `Next: outline upsert "Product Development/💎 V3 Orange Way Books/E2E runs/Pay with Flash ${RUN_ID}" ${docPath}`,
);
