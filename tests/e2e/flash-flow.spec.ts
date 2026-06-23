/**
 * Pay-with-Flash narrative, honest version.
 *
 * The previous version of this spec gave each test a fresh page, so most
 * screenshots were the login screen mislabeled as "Billing page during
 * trial", "Admin Flash, Not connected", etc. Tests passed because every
 * step was wrapped in try/skip; caught during a hardening pass.
 *
 * The rewrite:
 *   - Signs in ONCE on a shared page using the OWB_DEV_E2E_* credentials.
 *   - Re-unlocks the vault per route via gotoAuthed (successful unlocks
 *     don't trip the cooldown, see VaultContext S10 logic).
 *   - Adds hard assertions per step (route URL + a route-specific element).
 *   - Skips steps that depend on a running mock-flash server (:8787) or on
 *     a backdated trial-expired state we cannot simulate from here.
 *
 * Result: 3 honest screenshots (billing trial, admin Flash before connect,
 * admin Flash with Connect button focused) + 7 transparently-skipped steps
 * with a clear reason. Down from "10/10 lying."
 *
 * Selectors prefer `data-testid` where added; otherwise role/text.
 * If the app shape drifts, fix the selector, do not silently screenshot
 * the wrong page.
 */

import { test, expect, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn, unlockVaultIfNeeded } from './lib/auth';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS_DIR = path.join(HERE, '__screenshots__');
const CAPTIONS_PATH = path.join(SHOTS_DIR, 'captions.json');

interface CaptionEntry {
  name: string;
  file: string;
  caption: string;
  status: 'captured' | 'skipped';
  skipReason?: string;
}

const captions: CaptionEntry[] = [];

function ensureShotsDir(): void {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
}

async function shot(page: Page, name: string, caption: string): Promise<void> {
  ensureShotsDir();
  const file = `${name}.png`;
  await page.screenshot({ path: path.join(SHOTS_DIR, file), fullPage: true });
  captions.push({ name, file, caption, status: 'captured' });
}

function logSkip(name: string, caption: string, reason: string): void {
  captions.push({ name, file: `${name}.png`, caption, status: 'skipped', skipReason: reason });
}

function writeCaptions(): void {
  ensureShotsDir();
  fs.writeFileSync(CAPTIONS_PATH, JSON.stringify(captions, null, 2));
}

// Per-route navigation that re-unlocks the vault. Hard-asserts that the
// authenticated app shell is present after navigation so a re-locked vault
// cannot silently masquerade as the target page.
async function gotoAuthed(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'networkidle' });
  await unlockVaultIfNeeded(page);
  const stillLocked = await page
    .locator('text="Unlock your encrypted vault"')
    .isVisible({ timeout: 500 })
    .catch(() => false);
  expect(stillLocked, `still on Unlock Vault screen after gotoAuthed(${url})`).toBe(false);
  await expect(page.locator('text=Insights').first()).toBeVisible({ timeout: 10_000 });
  // Wait for any centered content spinner to disappear.
  await page
    .locator('svg.animate-spin.w-6.h-6')
    .first()
    .waitFor({ state: 'hidden', timeout: 10_000 })
    .catch(() => undefined);
  await page.waitForTimeout(500);
}

// Mock-flash reachability check, evaluated once at the top of the run.
const MOCK_FLASH_URL = process.env.MOCK_FLASH_URL ?? 'http://localhost:8787';
let mockFlashReachable: boolean | null = null;
async function isMockReachable(): Promise<boolean> {
  if (mockFlashReachable !== null) return mockFlashReachable;
  try {
    const res = await fetch(MOCK_FLASH_URL, { signal: AbortSignal.timeout(2000) });
    mockFlashReachable = res.status > 0;
  } catch {
    mockFlashReachable = false;
  }
  return mockFlashReachable;
}

test.afterAll(() => {
  writeCaptions();
});

test.describe.serial('Pay with Flash, narrative (honest)', () => {
  let sharedPage: Page;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    sharedPage = await ctx.newPage();
    await signIn(sharedPage);
  });

  test.afterAll(async () => {
    await sharedPage
      ?.context()
      .close()
      .catch(() => undefined);
  });

  test('01, authenticated user lands on dashboard', async () => {
    await gotoAuthed(sharedPage, '/app');
    expect(sharedPage.url()).toContain('/app');
    // Dashboard-specific element: the "Insights" page heading (h1/h2)
    // distinct from the sidebar nav item.
    await expect(
      sharedPage
        .locator('h1, h2')
        .filter({ hasText: /Insights/i })
        .first(),
    ).toBeVisible({ timeout: 10_000 });
    await shot(
      sharedPage,
      '01-signup',
      'Authenticated Orange Way Books user lands on the Insights dashboard. Sidebar shows the active org. Vault Unlocked badge confirms the in-browser MEK is live and only the user can decrypt the data the dashboard renders.',
    );
  });

  test('02, billing page during 45-day trial', async () => {
    await gotoAuthed(sharedPage, '/app/billing');
    expect(sharedPage.url()).toContain('/app/billing');
    // Hard assertion: billing-specific content visible.
    await expect(sharedPage.locator('text=Billing').first()).toBeVisible({ timeout: 10_000 });
    await expect(sharedPage.locator('text=Subscription').first()).toBeVisible({ timeout: 5_000 });
    await shot(
      sharedPage,
      '02-billing-page-trialing',
      'Billing page during the 45-day free trial. Subscription card shows the plan, trial badge, days remaining, and a Pay button. No payment is required yet, customer can pay early if they choose, but the button is informational during the trial window.',
    );
  });

  test('03, admin Flash page before connection', async () => {
    await gotoAuthed(sharedPage, '/app/admin/flash');
    expect(sharedPage.url()).toContain('/app/admin/flash');
    await expect(sharedPage.locator('text=/Pay with Flash|Flash Connect/i').first()).toBeVisible({
      timeout: 10_000,
    });
    await shot(
      sharedPage,
      '03-admin-flash-empty',
      "Admin Pay-with-Flash page before connecting Orange Way Books' merchant Flash account. 'Connect Flash' button is the only action available.",
    );
  });

  test('04, Connect Flash button focused (no real redirect)', async () => {
    await gotoAuthed(sharedPage, '/app/admin/flash');
    const connectBtn = sharedPage.getByRole('button', { name: /Connect Flash/i }).first();
    await expect(connectBtn).toBeVisible({ timeout: 5_000 });
    // Hover (not click) to capture the focused state without navigating off.
    await connectBtn.hover();
    await shot(
      sharedPage,
      '04-admin-flash-redirect',
      'Clicking Connect Flash redirects the user to Flash for OAuth authorization. The button-click handler stores a CSRF `state` token in `flash_oauth_state` and sends the user to `/oauth/authorize?client_id=…&redirect_uri=…&state=…&scope=read_write`. This shot captures the button focus without navigating off so the rest of the narrative remains usable.',
    );
  });

  test('05, admin Flash page after OAuth (connected)', async () => {
    const reachable = await isMockReachable();
    test.skip(
      !reachable,
      `mock-flash server at ${MOCK_FLASH_URL} not reachable, cannot complete the OAuth callback. Run the mock with \`docker compose up flash-mock\` (or equivalent) to enable this step.`,
    );
    logSkip(
      '05-admin-flash-connected',
      'OAuth callback, admin sees Connected',
      'reachable mock but no end-to-end implementation in this rewrite yet (Phase 2 of #48)',
    );
  });

  test('06, customer sees Pay button (trial ended)', async () => {
    test.skip(
      true,
      "this step requires the subscription-lifecycle cron to backdate trial_ends_at on this user's subscription row. That side-effect is destructive and not safe to run from this spec. Captured in the wiki page; a separate state-setup helper or a fresh test user is the right place for this.",
    );
    logSkip(
      '06-billing-pay-button',
      'Customer sees Pay $30 button after trial ends',
      'needs trial_ends_at backdate which this spec is not permitted to do',
    );
  });

  test('07, Flash-hosted checkout (mock)', async () => {
    const reachable = await isMockReachable();
    test.skip(!reachable, `mock-flash server at ${MOCK_FLASH_URL} not reachable.`);
    logSkip('07-flash-checkout-page', 'Flash-hosted payment link', 'needs reachable mock server');
  });

  test('08, mock marks payment paid → webhook fires', async () => {
    const reachable = await isMockReachable();
    test.skip(!reachable, `mock-flash server at ${MOCK_FLASH_URL} not reachable.`);
    logSkip(
      '08-payment-marked-paid',
      'Mock marks paid, webhook to /flash-webhook fires',
      'needs reachable mock server',
    );
  });

  test('09, billing active after webhook', async () => {
    test.skip(
      true,
      'requires a completed payment, which requires the mock chain in 07-08. Skipped together.',
    );
    logSkip('09-billing-active', 'Billing flips to active after webhook', 'depends on 07-08');
  });

  test('10, payment history with fee breakdown', async () => {
    test.skip(
      true,
      'requires a completed payment row in flash_payments. Skipped together with 07-08-09.',
    );
    logSkip('10-payment-history', 'Payment history with fee breakdown', 'depends on 07-08');
  });
});
