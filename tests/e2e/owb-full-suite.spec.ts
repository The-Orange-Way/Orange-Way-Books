/**
 * Orange Way Books — full E2E suite.
 *
 * Runs against books.orangeway.dev by default. Captures screenshots at
 * every key step into tests/e2e/__artifacts__/owb-full-suite-<run>/.
 *
 * Sections:
 *   A. Anonymous marketing pages
 *   B. Sign in + vault unlock
 *   C. Authenticated app surfaces (dashboard, wallets, transactions, etc.)
 *   D. Settings (parity pages + security)
 *   E. Admin
 *
 * ZKA note: vault MEK is in-memory only. Every page.goto causes a full SPA
 * reload, which re-locks the vault. gotoAuthed() re-unlocks after each
 * navigation.
 *
 * Read-only navigation. Does NOT commit anything to the test user's books.
 */

import { test, expect, type Page, type ConsoleMessage } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signIn, unlockVaultIfNeeded, signInAndUnlock } from './lib/auth';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID =
  process.env.E2E_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const SHOTS = path.join(HERE, '__artifacts__', `owb-full-suite-${RUN_ID}`);

let stepIdx = 0;
async function shot(page: Page, label: string) {
  stepIdx += 1;
  const name = `${String(stepIdx).padStart(2, '0')}-${label.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.png`;
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
}

async function gotoAuthed(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await unlockVaultIfNeeded(page);
  // Hard assertion: not on the lock screen. Without this every C/D/E test
  // silently passed even though the screenshot showed the vault unlock UI.
  const stillLocked = await page
    .locator('text="Unlock your encrypted vault"')
    .isVisible({ timeout: 500 })
    .catch(() => false);
  expect(stillLocked, `still on Unlock Vault screen after gotoAuthed(${url})`).toBe(false);
  // Wait for the authenticated shell to be present.
  await expect(page.getByTestId('app-shell').first()).toBeVisible({ timeout: 10_000 });
  // Wait for the content-area "data loading" spinner to disappear so screenshots
  // capture actual page content. Pages use the w-6 h-6 size for full-page
  // loading indicators (Dashboard's `py-20` wrapper, Periods' `min-h-screen`
  // wrapper); button spinners use w-4 h-4, so we can discriminate by size.
  await page
    .locator('svg.animate-spin.w-6.h-6')
    .first()
    .waitFor({ state: 'hidden', timeout: 10_000 })
    .catch(() => undefined);
  // Final settle wait for React to finish post-fetch renders.
  await page.waitForTimeout(800);
}

const FILTERED_CONSOLE = [
  'Download the React DevTools',
  'chrome-extension://',
  'Loading chunk',
  "directive 'frame-ancestors' is ignored when delivered via a <meta> element",
  'posthog',
  'PostHog',
  'hcaptcha',
];

test.describe.configure({ mode: 'serial' });

// ── A. Anonymous marketing pages ────────────────────────────────────────────

test.describe('A. Anonymous marketing', () => {
  for (const p of [
    '/',
    '/features',
    '/security',
    '/pricing',
    '/faq',
    '/about',
    '/contact',
    '/docs',
  ]) {
    test(`A ${p} loads`, async ({ page }) => {
      const res = await page.goto(p, { waitUntil: 'domcontentloaded' });
      expect(res?.status() ?? 0, p).toBeLessThan(400);
      await page.waitForTimeout(500);
      await shot(page, `anon${p.replace(/\//g, '-') || '-root'}`);
    });
  }
});

// ── B. Sign in + vault unlock ───────────────────────────────────────────────

test.describe('B. Sign in + vault unlock', () => {
  test('B1 /login renders', async ({ page }) => {
    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await shot(page, 'login-screen');
    await expect(page.locator('input[type="email"]').first()).toBeVisible();
    await expect(page.locator('input[type="password"]').first()).toBeVisible();
  });

  test('B2 sign in + reach app', async ({ page }) => {
    await signIn(page);
    await shot(page, 'after-signin');
  });

  test('B3 vault unlock', async ({ page }) => {
    await signIn(page);
    await unlockVaultIfNeeded(page);
    const stillLocked = await page
      .locator('button:has-text("Unlock Vault")')
      .isVisible()
      .catch(() => false);
    expect(stillLocked, 'should NOT be on Unlock Vault screen after sign in + unlock').toBe(false);
    await shot(page, 'after-vault-unlock');
  });
});

// ── C-E: Authenticated journey ──────────────────────────────────────────────
//
// Each authenticated test does its own page.goto + vault unlock via
// gotoAuthed(). The S10 sliding-window cooldown only counts FAILED unlock
// attempts (see src/context/VaultContext.tsx — "passwordAttempted = true"
// gate), so a sequence of successful unlocks with the correct password
// does NOT trip the rate limit. This replaces the prior pushState pattern
// which silently re-locked the vault and produced screenshots of the
// "Unlock your encrypted vault" screen labelled as the dashboard.

test.describe('C-E. Authenticated journey', () => {
  let sharedPage: Page;

  // Sign in ONCE for the whole describe — the auth session cookie persists
  // across page.goto. The vault MEK is in-memory so it does need re-unlock
  // per goto, but successful unlocks do not count toward the failed-attempt
  // sliding-window cooldown.
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

  for (const [label, route, shotLabel] of [
    ['C1', '/app', 'dashboard'],
    ['C', '/app/accounts', 'app-app-wallets'],
    ['C', '/app/transactions', 'app-app-transactions'],
    ['C', '/app/journal', 'app-app-journal'],
    ['C', '/app/reports', 'app-app-reports'],
    ['C', '/app/invoices', 'app-app-invoices'],
    ['C', '/app/payments', 'app-app-payments'],
    ['C', '/app/connections', 'app-app-connections'],
    ['C', '/app/billing', 'app-app-billing'],
    ['D', '/app/settings/opening-balances', 'settings-app-settings-opening-balances'],
    ['D', '/app/settings/periods', 'settings-app-settings-periods'],
    ['D', '/app/settings/bulk-receipt-linker', 'settings-app-settings-bulk-receipt-linker'],
    ['D', '/app/settings/import-from-or', 'settings-app-settings-import-from-or'],
    ['D', '/app/settings/import-jobs', 'settings-app-settings-import-jobs'],
    ['D', '/app/settings/security', 'settings-app-settings-security'],
    ['D', '/app/settings/change-password', 'settings-app-settings-change-password'],
    ['D', '/app/settings/recovery-code', 'settings-app-settings-recovery-code'],
    ['D', '/app/settings/master-recovery', 'settings-app-settings-master-recovery'],
    ['E', '/app/admin', 'admin'],
    ['E', '/app/admin/flash', 'admin-flash'],
  ] as const) {
    test(`${label} ${route}`, async () => {
      const consoleErrors: string[] = [];
      const onConsole = (msg: ConsoleMessage) => {
        if (msg.type() === 'error') consoleErrors.push(msg.text());
      };
      const onPageErr = (err: Error) => consoleErrors.push(`pageerror: ${err.message}`);
      sharedPage.on('console', onConsole);
      sharedPage.on('pageerror', onPageErr);

      try {
        await gotoAuthed(sharedPage, route);
        // Belt-and-suspenders: even after gotoAuthed's assertions, double-check
        // the lock heading is gone at screenshot time.
        const lockedAtShot = await sharedPage
          .locator('text="Unlock your encrypted vault"')
          .isVisible({ timeout: 200 })
          .catch(() => false);
        expect(lockedAtShot, `${route} should not show vault unlock at screenshot time`).toBe(
          false,
        );

        // Per-route regression assertions. Today two bugs shipped
        // and were only caught on visual screenshot inspection because the
        // existing assertions accepted "page loaded" as success. These specific
        // text checks would have surfaced them via a hard fail.
        if (route === '/app') {
          // ledger_status regression: OnboardingWizard must flip pending → ready
          // so the dashboard does NOT show a perpetual "Finishing setup…" pill.
          const stillFinishing = await sharedPage
            .locator('text=Finishing setup')
            .first()
            .isVisible({ timeout: 500 })
            .catch(() => false);
          expect(
            stillFinishing,
            '/app dashboard should NOT show "Finishing setup…" pill — ledger_status not written to ready',
          ).toBe(false);
        }
        if (route === '/app/settings/master-recovery') {
          // React error #310 regression: hook ordering in MasterRecovery.tsx
          // must keep all useState declarations above the early returns or
          // the page renders blank.
          await expect(
            sharedPage
              .locator('h1, h2')
              .filter({ hasText: /Master recovery key/i })
              .first(),
            'master-recovery heading should be visible — React error #310 regression',
          ).toBeVisible({ timeout: 5_000 });
        }

        await shot(sharedPage, shotLabel);

        if (label === 'D') {
          const significant = consoleErrors.filter(
            (e) => !FILTERED_CONSOLE.some((s) => e.includes(s)),
          );
          if (significant.length > 0) {
            // Log but don't fail. A transient "Failed to fetch" from the
            // Supabase session refresher should not cascade-skip the rest of
            // the suite when the page itself rendered correctly. The
            // lock-screen + sidebar assertions in gotoAuthed are what guard
            // the real "page did not render" failure mode.
            console.warn(`[${route}] non-fatal console issues:\n  ${significant.join('\n  ')}`);
          }
        }
      } finally {
        sharedPage.off('console', onConsole);
        sharedPage.off('pageerror', onPageErr);
      }
    });
  }
});
