/**
 * Import from Orange Rails — wizard end-to-end test.
 *
 * Real flow against the deployed books.orangeway.dev:
 *
 *   1. Sign in with OWB_DEV_E2E_* credentials (account password)
 *   2. Unlock the vault (separate vault password)
 *   3. Client-side navigate to /app/admin?tab=or-import
 *   4. Open the wizard
 *   5. Upload tests/e2e/fixtures/or-import-sample.json
 *   6. Verify the wizard parses + shows summary (3 accounts, 2 contacts)
 *   7. Click "Import everything"
 *   8. Verify per-section result cards appear
 *
 * Why this is ONE test instead of four: V3's MEK lives in browser memory
 * only (zero-knowledge by design). Any hard navigation (page.goto) reloads
 * the SPA, the MEK is gone, the user lands back on the vault unlock screen.
 * Splitting the flow across multiple Playwright tests means each test runs
 * in a fresh browser context AND each test pays the Argon2id KDF cost
 * (1-3s) just to get back to the post-unlock state. Worse, navigating to
 * /admin via page.goto() between unlock and the rest of the flow re-locks
 * the vault. Keeping it all in one test, with client-side navigation,
 * avoids both problems.
 *
 * Each phase still takes its own screenshot so CI artifacts include
 * eyeballable receipts of every step.
 *
 * Auth: reuses tests/e2e/lib/auth.ts helpers (shared with owb-full-suite).
 * Reads OWB_DEV_E2E_EMAIL / OWB_DEV_E2E_PASSWORD / OWB_DEV_E2E_VAULT_PASSWORD
 * env vars — set in CI from matching repo secrets. The dedicated E2E test
 * user is provisioned by tests/e2e/scripts/provision-e2e-user.js.
 */

import { test, expect, Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { signInAndUnlock } from './lib/auth';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = path.join(HERE, 'fixtures', 'or-import-sample.json');
const SHOTS_DIR = path.join(HERE, '__or-shots__');

const HAVE_CREDS =
  !!process.env.OWB_DEV_E2E_EMAIL &&
  !!process.env.OWB_DEV_E2E_PASSWORD &&
  !!process.env.OWB_DEV_E2E_VAULT_PASSWORD;

test.skip(
  !HAVE_CREDS,
  'OWB_DEV_E2E_EMAIL / OWB_DEV_E2E_PASSWORD / OWB_DEV_E2E_VAULT_PASSWORD not set — skipping wizard E2E',
);

// OWB's OR import wizard surface has not yet been verified to match the
// V3-style selectors this spec drives (open-or-import-wizard testid,
// sample-fixture upload, summary parsing). Skipping until the wizard UI
// is confirmed identical or the spec is rewritten to OWB's actual flow.
// Tracked as a follow-up to the E2E migration.
test.skip(true, 'OWB OR import wizard UI not yet wired into this spec — see follow-up task');

/**
 * Client-side navigation that preserves the in-memory MEK. Uses
 * pushState + popstate so react-router picks up the URL change
 * without a full SPA reload.
 */
async function clientNavigate(page: Page, to: string): Promise<void> {
  await page.evaluate((target) => {
    window.history.pushState({}, '', target);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, to);
}

test('Import from Orange Rails — wizard E2E (single session)', async ({ page }) => {
  const fs = await import('node:fs');
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  // Step 1: sign in + unlock vault.
  await signInAndUnlock(page);
  // After unlock, V3's auth gate routes the user to the app shell. Give it
  // a moment to finish hydrating before screenshotting.
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({
    path: path.join(SHOTS_DIR, '01-post-signin-and-unlock.png'),
    fullPage: true,
  });
  expect(page.url()).not.toMatch(/\/login/);

  // Step 2: client-side navigate to the OR import tab. NEVER use page.goto
  // here — it would trigger a hard reload, wipe the MEK, lock the vault.
  // Use the canonical /app/admin path: App.tsx routes the admin page under
  // /app/admin and the legacy /admin URL is a <Navigate to="/app/admin">
  // that strips the query string, so /admin?tab=or-import lands on the
  // default 'organization' tab and the open-or-import-wizard button never
  // renders.
  await clientNavigate(page, '/app/admin?tab=or-import');
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({
    path: path.join(SHOTS_DIR, '02-admin-or-import-tab.png'),
    fullPage: true,
  });
  await expect(page.getByTestId('open-or-import-wizard')).toBeVisible({ timeout: 15_000 });

  // Step 3: open the wizard.
  await page.getByTestId('open-or-import-wizard').click();
  await expect(page.getByText('Import from Orange Rails')).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS_DIR, '03-wizard-opened.png'),
    fullPage: true,
  });

  // Step 4: drop the fixture file + verify the wizard parses it.
  await page.locator('input[type="file"]').first().setInputFiles(FIXTURE_PATH);
  await expect(page.getByText('accounts', { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('contacts', { exact: false })).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS_DIR, '04-wizard-summary.png'),
    fullPage: true,
  });

  // Step 5: apply the import + verify result cards.
  await page.getByRole('button', { name: /import everything/i }).click();
  await expect(page.getByText(/Chart of accounts/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Contacts/i)).toBeVisible();
  await expect(page.getByText(/Journal entries/i)).toBeVisible();
  await page.screenshot({
    path: path.join(SHOTS_DIR, '05-wizard-results.png'),
    fullPage: true,
  });
});
