/**
 * Sign-in + vault-unlock helpers for the OWB E2E specs.
 *
 * Reads credentials from env vars:
 *   OWB_DEV_E2E_EMAIL
 *   OWB_DEV_E2E_PASSWORD          (Supabase auth password)
 *   OWB_DEV_E2E_VAULT_PASSWORD    (Argon2id KEK input — unlocks the MEK)
 *
 * The test user is provisioned via tests/e2e/scripts/provision-e2e-user.js
 * and is expected to be fully onboarded (vault password set, org created)
 * BEFORE these helpers run. They do not walk the onboarding flow.
 */

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`E2E: env ${name} not set`);
  return v;
}

export async function signIn(page: Page): Promise<void> {
  const email = requireEnv('OWB_DEV_E2E_EMAIL');
  const supabasePw = requireEnv('OWB_DEV_E2E_PASSWORD');

  await page.goto('/login', { waitUntil: 'domcontentloaded' });

  const emailInput = page.locator('input[type="email"]').first();
  const pwInput = page.locator('input[type="password"]').first();
  await expect(emailInput, '/login email input missing').toBeVisible({ timeout: 10_000 });
  await emailInput.fill(email);
  await pwInput.fill(supabasePw);

  const submit = page
    .locator('form button[type="submit"]')
    .or(page.locator('button:has-text("Sign In")'))
    .or(page.locator('button:has-text("Log in")'))
    .first();
  await submit.click();

  try {
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 });
  } catch {
    const inlineErr = await page
      .locator('[role="alert"], .text-destructive, [data-testid*="error"]')
      .first()
      .textContent()
      .catch(() => null);
    const url = page.url();
    throw new Error(
      `signIn: URL still at ${url} after 20s. Inline error: ${inlineErr ?? '(none found)'}`,
    );
  }
}

export async function unlockVaultIfNeeded(page: Page): Promise<boolean> {
  const vaultPw = requireEnv('OWB_DEV_E2E_VAULT_PASSWORD');

  const lockHeading = page.locator('text="Unlock your encrypted vault"').first();
  const unlockBtn = page.locator('button:has-text("Unlock Vault")').first();
  const authedShell = page.getByTestId('app-shell').first();

  // After a page.goto the SPA is still hydrating: the lock screen and the
  // authenticated shell are the two possible settled states. Deciding on a
  // fixed 4s probe of the lock heading alone races hydration, a slow hydrate
  // makes the heading appear just after the probe gives up, so this helper
  // returns false (reporting already-unlocked) without ever unlocking and the
  // caller then asserts on a lock screen it was told was absent. Wait for
  // whichever state settles first, then decide.
  await expect(lockHeading.or(authedShell)).toBeVisible({ timeout: 15_000 });
  const visible = await lockHeading.isVisible().catch(() => false);
  if (!visible) return false;

  const pwInput = page.locator('input[type="password"]').first();
  await pwInput.fill(vaultPw);
  await unlockBtn.click();

  const err = page.locator('text=/incorrect|wrong|invalid|failed/i').first();
  await Promise.race([
    lockHeading.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => undefined),
    err.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined),
  ]);

  if (await err.isVisible().catch(() => false)) {
    const text = await err.textContent();
    throw new Error(`Vault unlock rejected: ${text?.trim() ?? '(no text)'}`);
  }

  await lockHeading.waitFor({ state: 'hidden', timeout: 5_000 }).catch(() => undefined);

  // Wait for the post-unlock app shell to actually render. The lock heading
  // disappearing only tells us the unlock RPC succeeded — the SPA still has to
  // hydrate the dashboard. Screenshots taken between unlock and hydration
  // capture a blank spinner page. The app shell root (data-testid="app-shell")
  // is the first stable element of the authenticated shell and renders on every
  // authenticated route, so a copy change cannot silently break it.
  await page
    .getByTestId('app-shell')
    .first()
    .waitFor({ state: 'visible', timeout: 15_000 })
    .catch(() => undefined);
  return true;
}

export async function signInAndUnlock(page: Page): Promise<void> {
  await signIn(page);
  await unlockVaultIfNeeded(page);

  const stillLocked = await page
    .locator('button:has-text("Unlock Vault")')
    .isVisible()
    .catch(() => false);
  if (stillLocked) {
    throw new Error(
      'signInAndUnlock: still on vault unlock screen — password rejected or page did not navigate',
    );
  }
}
