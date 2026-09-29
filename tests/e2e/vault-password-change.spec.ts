/**
 * Vault password change -- AEAD binding regression guard (OWB-T0092).
 *
 * Paths covered:
 *   (b) vault password change writes v1.-prefixed rows; sign-out, sign-in,
 *       unlock with the new password all work end to end
 *   (d/partial) wrong current password shows an error and does not advance
 *       to the recovery kit step
 *
 * Push events only (OWB_E2E_SUPABASE_SECRET_KEY required):
 *   Asserts user_vault_keys.encrypted_private_key starts with "v1." after
 *   the password change -- the AEAD binding re-write is verified in the DB.
 *   Table: user_vault_keys, column: encrypted_private_key.
 *
 * Uses the shared fixture user (OWB_DEV_E2E_*).  Runs serially.  Restores
 * the original vault password at the end of the change test so the fixture
 * stays intact for subsequent specs.  Skips entirely on non-push CI events
 * (when OWB_E2E_SUPABASE_SECRET_KEY is absent) so a failing mid-test run
 * cannot corrupt the shared fixture on PR builds.
 */

import { test, expect } from '@playwright/test';
import https from 'node:https';
import type { Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Gate: skip unless the service key is present (push events only).
// ---------------------------------------------------------------------------
const HAS_SERVICE_KEY = !!process.env.OWB_E2E_SUPABASE_SECRET_KEY;
test.skip(
  !HAS_SERVICE_KEY,
  'OWB_E2E_SUPABASE_SECRET_KEY not set -- vault-password-change spec only runs on push events',
);

test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
const EMAIL = (): string => process.env.OWB_DEV_E2E_EMAIL ?? '';
const SUPABASE_PW = (): string => process.env.OWB_DEV_E2E_PASSWORD ?? '';
const VAULT_PW = (): string => process.env.OWB_DEV_E2E_VAULT_PASSWORD ?? '';
// Rotated password: original + a suffix that keeps it at >= 14 chars and
// distinct from the original.  The suffix is mixed-case with symbols so
// zxcvbn still scores >= 4 on the combined string.
const VAULT_PW_ROTATED = (): string =>
  (process.env.OWB_DEV_E2E_VAULT_PASSWORD ?? '') + '-R0t8tE!E2E';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Navigate to /login, sign in with the fixture credentials, then unlock the
 * vault if the lock screen appears.  Pass an explicit vaultPassword to
 * override OWB_DEV_E2E_VAULT_PASSWORD (used when testing with the rotated PW).
 */
async function signInAndUnlock(page: Page, vaultPassword?: string): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });

  const emailInput = page.locator('input[type="email"]').first();
  await expect(emailInput, 'login email input').toBeVisible({ timeout: 10_000 });
  await emailInput.fill(EMAIL());
  await page.locator('input[type="password"]').first().fill(SUPABASE_PW());

  await page
    .locator('form button[type="submit"]')
    .or(page.locator('button:has-text("Sign In")'))
    .or(page.locator('button:has-text("Log in")'))
    .first()
    .click();

  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });

  const lockHeading = page.locator('text="Unlock your encrypted vault"').first();
  const appShell = page.getByTestId('app-shell').first();
  await expect(lockHeading.or(appShell)).toBeVisible({ timeout: 15_000 });

  if (await lockHeading.isVisible().catch(() => false)) {
    const pw = vaultPassword ?? VAULT_PW();
    await page.locator('input[type="password"]').first().fill(pw);
    await page.locator('button:has-text("Unlock Vault")').first().click();
    await lockHeading.waitFor({ state: 'hidden', timeout: 30_000 });
    await expect(appShell).toBeVisible({ timeout: 15_000 });
  }
}

/**
 * Navigate to /app/settings/change-password and fill + submit the form.
 * Does NOT await the step-2 result.
 */
async function fillAndSubmitChangeForm(
  page: Page,
  currentPw: string,
  newPw: string,
): Promise<void> {
  await page.goto('/app/settings/change-password', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('h1')).toContainText('Change Vault Password', { timeout: 10_000 });

  await page.locator('#current').fill(currentPw);
  await page.locator('#new').fill(newPw);
  await page.locator('#confirm').fill(newPw);
  await page.locator('button[type="submit"]').first().click();
}

/**
 * On the step-2 recovery kit screen: check the acknowledgement checkbox and
 * click Done.  Done navigates to /app/admin.
 */
async function ackAndDone(page: Page): Promise<void> {
  await expect(
    page.locator('h1').filter({ hasText: 'Save Your New Recovery Kit' }),
  ).toBeVisible({ timeout: 20_000 });

  // Radix UI Checkbox renders as button[role="checkbox"].
  const cb = page.locator('button[role="checkbox"]').first();
  await cb.waitFor({ state: 'visible', timeout: 10_000 });
  await cb.click();
  await expect(cb).toHaveAttribute('data-state', 'checked', { timeout: 5_000 });

  await page.locator('button:has-text("Done")').first().click();
  await page.waitForURL(
    (url) =>
      url.pathname.includes('/app/admin') || !url.pathname.includes('/change-password'),
    { timeout: 15_000 },
  );
}

/**
 * Clear the Supabase auth session from browser storage.
 * After this call, the next page.goto('/login') will show the login form.
 */
async function clearAuthSession(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.keys(window.localStorage)
      .filter((k) => k.includes('-auth-token') || k.startsWith('sb-') || k.includes('supabase'))
      .forEach((k) => window.localStorage.removeItem(k));
  });
}

/**
 * Admin REST call to the Supabase project (uses the service role key).
 * Never prints the key or a response body that could contain one.
 */
function adminFetch(
  url: string,
  secret: string,
  path: string,
  method: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url + path);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method,
        headers: {
          apikey: secret,
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
      (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => resolve({ status: r.statusCode ?? 0, body: b }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Vault password change -- AEAD binding regression (OWB-T0092)', () => {
  /**
   * Path (d) partial: a wrong current password is rejected.
   * The form must show an error element and must NOT navigate to step 2.
   */
  test('wrong current password shows error and stays on the form', async ({ page }) => {
    await signInAndUnlock(page);
    await page.goto('/app/settings/change-password', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toContainText('Change Vault Password', { timeout: 10_000 });

    await page.locator('#current').fill('definitely-wrong-vault-pw-e2e');
    await page.locator('#new').fill(VAULT_PW_ROTATED());
    await page.locator('#confirm').fill(VAULT_PW_ROTATED());
    await page.locator('button[type="submit"]').first().click();

    // AES-GCM decryption with a wrong key throws a DOMException.
    // handleSubmit catches it and calls setError(err.message).
    // The rendered element is: <p className="text-sm text-destructive">{error}</p>
    await expect(
      page.locator('.text-destructive').first(),
    ).toBeVisible({ timeout: 15_000 });

    // Must NOT have advanced to the recovery kit page.
    const onKit = await page
      .locator('h1')
      .filter({ hasText: 'Save Your New Recovery Kit' })
      .isVisible()
      .catch(() => false);
    expect(onKit, 'must NOT show recovery kit after wrong current password').toBe(false);
  });

  /**
   * Path (b): full vault password change.
   *   1. Change VAULT_PW -> VAULT_PW_ROTATED.
   *   2. On push: assert user_vault_keys.encrypted_private_key starts with "v1.".
   *   3. Sign out, sign back in, unlock with VAULT_PW_ROTATED.
   *   4. Restore: change VAULT_PW_ROTATED -> VAULT_PW so the fixture stays valid.
   *
   * A try/finally guard attempts the restore even if the test fails mid-way.
   */
  test('change vault password: v1. prefix in DB, sign-out/sign-in/unlock all work', async ({
    page,
  }) => {
    test.setTimeout(180_000);

    let passwordRotated = false;

    try {
      // -- Change password --------------------------------------------------
      await signInAndUnlock(page);
      await fillAndSubmitChangeForm(page, VAULT_PW(), VAULT_PW_ROTATED());
      await expect(
        page.locator('h1').filter({ hasText: 'Save Your New Recovery Kit' }),
      ).toBeVisible({ timeout: 20_000 });
      passwordRotated = true;

      // -- DB assertion (push only) -----------------------------------------
      const supabaseUrl = process.env.OWB_E2E_SUPABASE_URL;
      const serviceKey = process.env.OWB_E2E_SUPABASE_SECRET_KEY;
      // HAS_SERVICE_KEY gate at the top means serviceKey is always set here,
      // but guard defensively so TypeScript is happy.
      if (supabaseUrl && serviceKey) {
        // Look up the fixture user's auth id.
        const userQ = await adminFetch(
          supabaseUrl,
          serviceKey,
          `/auth/v1/admin/users?email=${encodeURIComponent(EMAIL())}`,
          'GET',
        );
        const payload: unknown = JSON.parse(userQ.body);
        const users = Array.isArray(payload)
          ? (payload as Array<{ id: string }>)
          : ((payload as { users?: Array<{ id: string }> }).users ?? []);
        const userId = users[0]?.id;
        expect(userId, 'fixture user must exist in Supabase auth').toBeTruthy();

        // Query user_vault_keys for the encrypted_private_key column.
        const vkQ = await adminFetch(
          supabaseUrl,
          serviceKey,
          `/rest/v1/user_vault_keys?user_id=eq.${userId}&select=encrypted_private_key`,
          'GET',
        );
        const rows: Array<{ encrypted_private_key: string }> = JSON.parse(vkQ.body);
        expect(rows.length, 'user_vault_keys must have at least one row').toBeGreaterThan(0);
        expect(
          rows[0].encrypted_private_key,
          'encrypted_private_key must start with "v1." (AEAD binding re-write confirmed)',
        ).toMatch(/^v1\./);
      }

      // -- Acknowledge recovery kit and navigate away -----------------------
      await ackAndDone(page);

      // -- Sign out (clear browser auth) ------------------------------------
      await clearAuthSession(page);

      // -- Sign back in with the NEW vault password -------------------------
      await signInAndUnlock(page, VAULT_PW_ROTATED());
      await expect(
        page.getByTestId('app-shell').first(),
        'app shell must be visible after unlocking with the new vault password',
      ).toBeVisible({ timeout: 20_000 });

      // -- Restore: change back to original vault password ------------------
      await fillAndSubmitChangeForm(page, VAULT_PW_ROTATED(), VAULT_PW());
      await ackAndDone(page);
      passwordRotated = false;
    } finally {
      // Best-effort restore: if the test failed after the first change but
      // before the restore, try to put the fixture back to the original PW.
      if (passwordRotated) {
        try {
          await clearAuthSession(page);
          await signInAndUnlock(page, VAULT_PW_ROTATED());
          await fillAndSubmitChangeForm(page, VAULT_PW_ROTATED(), VAULT_PW());
          await ackAndDone(page);
        } catch (restoreErr) {
          // eslint-disable-next-line no-console
          console.error(
            '[vault-password-change] Emergency restore FAILED -- fixture vault PW may still be rotated.',
            restoreErr,
          );
        }
      }
    }
  });
});
