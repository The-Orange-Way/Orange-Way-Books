/**
 * Onboarding walk — end-to-end with hard assertions per step.
 *
 * Today's most fragile flow has no spec coverage: a brand-new user goes
 * through signup → vault password setup → recovery code reveal → confirm
 * 12 words → org creation → seeded chart-of-accounts. If any step breaks
 * silently (like ledger_status not flipping to ready) the only signal is a
 * customer ticket. This spec walks the full flow against dev and asserts
 * per-step so a regression fails CI instead of waiting for a human.
 *
 * **Runs on its own dedicated fixture user, never the shared one.** The spec
 * has side effects: it deletes its user's organizations in beforeAll so the
 * user re-onboards through the live code path. owb-full-suite, rls-isolation
 * and or-import-wizard all sign in with the SHARED fixture (OWB_DEV_E2E_*),
 * so this spec reads OWB_E2E_WALK_* instead and beforeAll refuses to run when
 * the two resolve to the same address.
 *
 * That refusal is the point. Sharing one user is what kept dev E2E red from
 * 2026-08-13: the walk wiped the org, its own walk then failed, so the org was
 * never recreated, and every spec sorting after it found a user with no org
 * and no vault. Provisioning only runs on pushes, so no PR run could recover.
 *
 * Gated by `E2E_ONBOARDING_WALK=1`. It provisions its own user through the
 * Supabase admin API, so it needs no separate provisioning step in CI.
 *
 * What it asserts (each one a hard expect):
 *   01 — /login renders, sign in with the walk's own fixture user
 *   02-06c — the v2 7-step wizard (DL-0429): name, email (session-skip),
 *            education, vault password, recovery kit display + type-back
 *            verify, success
 *   06d-06f — OrgSetupSurface (DL-0718): org name, currency, fiscal year +
 *            timezone, which runs handleFinish (create_org_for_current_user)
 *   07 — Ledger bootstrap completes (≤45s) — sidebar appears
 *   08 — Dashboard renders with NO "Finishing setup…" pill
 *   09 — chart_of_accounts page lists 43 default accounts
 *   10 — master-recovery page renders the heading (React #310 regression)
 *   11 (DL-0720/0721): admin settings reads back April fiscal start and Eastern timezone
 *
 * Walks the v2 onboarding wizard (VITE_ONBOARDING_V2), not v1's
 * OnboardingWizard: this build sets the flag 'true' for the E2E bundle
 * (OW-T0112), matching what deploy.yml already ships on dev, so the walk
 * exercises the same code path a real dev user hits.
 *
 * Read-only environment: only OWB DEV (project ref allowlisted in the
 * provision script). Refuses to run on PROD.
 */

import { test, expect, type Page } from '@playwright/test';
import https from 'node:https';
import fs from 'node:fs';

const OPT_IN = process.env.E2E_ONBOARDING_WALK === '1';

// The walk's OWN identity. Deliberately a different variable family from the
// OWB_DEV_E2E_* one every other spec reads, so the two cannot be pointed at
// one user by accident. The defaults are the same dev-only fixture values this
// file already carried; only the address changes, so no new credential
// material enters the tree.
const EMAIL = process.env.OWB_E2E_WALK_EMAIL ?? 'e2e-walk@orangewaybooks.test';
const PASSWORD = process.env.OWB_E2E_WALK_PASSWORD ?? 'OwbE2E-Stable-2026!Pw';
const VAULT_PW = process.env.OWB_E2E_WALK_VAULT_PW ?? 'OwbE2EVault-Stable-2026!';
// New vault password for the password-change test (second test in this serial
// describe). Deliberately a separate variable so the change target is never the
// same value as VAULT_PW, and so the beforeAll reset (which deletes
// user_vault_keys) leaves VAULT_PW as the correct unlock password at the start
// of every run.
const VAULT_PW_NEW = process.env.OWB_E2E_WALK_VAULT_PW_NEW ?? 'OwbE2EWalk-NewVault-2026!';
const ORG_NAME = process.env.OWB_E2E_WALK_ORG_NAME ?? 'OWB E2E Walk Org';

// The shared fixture every other spec signs in with. Read only so the guard
// below can compare against it; this spec never signs in as it.
const SHARED_FIXTURE_EMAIL = process.env.OWB_DEV_E2E_EMAIL ?? '';

// Pin to OWB DEV ref. Refuses to run if env points elsewhere.
const ALLOWED_PROJECT_REFS = new Set(
  (process.env.OWB_E2E_ALLOWED_PROJECT_REFS ?? '').split(',').filter(Boolean),
);

interface SupaCreds {
  url: string;
  secret: string;
}

function readSupaCreds(): SupaCreds | null {
  // In CI the URL and service key arrive as env vars (see the e2e job in
  // ci.yml), the same source the provision script reads. Env wins. Locally
  // the file below is the fallback for a dev laptop. If neither is present,
  // return null and let the caller decide (skip vs throw).
  const url = process.env.OWB_E2E_SUPABASE_URL;
  const secret = process.env.OWB_E2E_SUPABASE_SECRET_KEY;
  if (url && secret) return { url, secret };
  try {
    return JSON.parse(fs.readFileSync('/tmp/owb-pw/owb-dev-supabase.json', 'utf8'));
  } catch {
    return null;
  }
}

function adminFetch(
  url: string,
  secret: string,
  path: string,
  method: string,
  body?: unknown,
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
        },
      },
      (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => resolve({ status: r.statusCode || 0, body: b }));
      },
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// The admin list endpoint ignores ?email= (GoTrue only reads sort, filter,
// page, per_page and cursor). Page through the full list and match exactly.
// Copied from rls-cross-user.spec.ts; do not import to keep both specs
// self-contained.
const ADMIN_LIST_PAGE_SIZE = 200;
const ADMIN_LIST_MAX_PAGES = 50;

async function findUserIdByEmail(supa: SupaCreds, email: string): Promise<string> {
  const wanted = email.toLowerCase();
  for (let page = 1; page <= ADMIN_LIST_MAX_PAGES; page += 1) {
    const res = await adminFetch(
      supa.url,
      supa.secret,
      `/auth/v1/admin/users?page=${page}&per_page=${ADMIN_LIST_PAGE_SIZE}`,
      'GET',
    );
    if (res.status >= 400) {
      throw new Error(`admin list users page ${page}: HTTP ${res.status} ${res.body}`);
    }
    const users: Array<{ id?: string; email?: string }> = JSON.parse(res.body).users ?? [];
    const hit = users.find((u) => (u.email ?? '').toLowerCase() === wanted);
    if (hit?.id) return hit.id;
    if (users.length < ADMIN_LIST_PAGE_SIZE) break;
  }
  throw new Error(
    `findUserIdByEmail: no account with address ${email} found in the admin user list; refusing to guess`,
  );
}

// Click a wizard button that sits immediately after a Radix Select interaction.
//
// Radix puts `pointer-events: none` on <body> while a Select popup is open and
// only clears it once the close animation finishes. A click({ force: true }) in
// that window skips every actionability check, lands on a document that is not
// accepting pointer events, and is swallowed with no error, so the wizard
// silently does not advance and the NEXT step's element never renders. That is
// how this spec failed: 06b set the timezone and passed, its Continue click was
// eaten, and 06c timed out on getByTestId('onboarding-fiscal-month') reporting
// "element(s) not found" rather than anything about the click.
//
// So wait for the body to accept pointer events again, then click WITHOUT force
// and let Playwright's own actionability retry cover the rest.
async function clickWizardButton(page: Page, label: RegExp) {
  await expect(page.locator('body'), 'body accepting pointer events again').not.toHaveCSS(
    'pointer-events',
    'none',
    { timeout: 10_000 },
  );
  const btn = page.locator('button:visible:not([disabled])').filter({ hasText: label }).first();
  await expect(btn, `wizard button matching ${label}`).toBeVisible({ timeout: 10_000 });
  await btn.click();
}

test.skip(
  !OPT_IN,
  'E2E_ONBOARDING_WALK=1 not set — onboarding walk has DB side effects and only runs explicitly',
);

test.describe.serial('Onboarding walk — fresh org for the e2e user', () => {
  let supa: SupaCreds | null = null;

  test.beforeAll(async () => {
    // Belt-and-suspenders: the file-level test.skip(!OPT_IN) should prevent
    // this hook from running when the opt-in env var is absent, but some
    // Playwright versions execute beforeAll even for skipped tests. Guard
    // explicitly so the org DELETE never fires without an explicit opt-in.
    if (!OPT_IN) return;

    // Refuse before touching anything, whatever the environment says. This
    // hook DELETES organizations, so if the walk's address ever resolves to
    // the shared fixture it destroys the org owb-full-suite and rls-isolation
    // depend on. A loud refusal costs one red spec; the converged case costs
    // three other specs and every PR run after it, with no automatic recovery.
    if (SHARED_FIXTURE_EMAIL && EMAIL.toLowerCase() === SHARED_FIXTURE_EMAIL.toLowerCase()) {
      throw new Error(
        'onboarding walk refuses to run: its fixture user resolves to the SHARED e2e user ' +
          '(OWB_DEV_E2E_EMAIL). Point OWB_E2E_WALK_EMAIL at a dedicated user.',
      );
    }

    supa = readSupaCreds();
    if (!supa)
      throw new Error(
        'cannot read /tmp/owb-pw/owb-dev-supabase.json — run provision-e2e-user.js once first to seed it',
      );
    const ref = new URL(supa.url).hostname.split('.')[0];
    if (!ALLOWED_PROJECT_REFS.has(ref)) {
      throw new Error(
        `onboarding walk refuses to run against project ref "${ref}" — DEV allowlist only`,
      );
    }

    // Ensure the user exists (idempotent: 422 means already there).
    const cr = await adminFetch(supa.url, supa.secret, '/auth/v1/admin/users', 'POST', {
      email: EMAIL,
      password: PASSWORD,
      email_confirm: true,
    });
    if (cr.status >= 400 && cr.status !== 422) {
      throw new Error(`admin user-create failed: HTTP ${cr.status} ${cr.body}`);
    }

    // Delete the user's existing org so we walk a fresh onboarding. This
    // is the same SQL the manual remediation used. We use the service-role
    // REST endpoint with admin filter.
    //
    // Strategy: find user_id → list their org_members → DELETE organizations
    // (cascade via FK does the rest).
    // findUserIdByEmail pages through the admin list to match the address
    // exactly. GoTrue ignores ?email= on the list endpoint; taking users[0]
    // from that response picks the newest account and would delete its orgs.
    const userId = await findUserIdByEmail(supa, EMAIL);

    // admin user-create answers 422 when the user is already there and leaves
    // the password alone. A fixture created once with a different password
    // would then fail at the login screen on every future run with no way to
    // self-heal, which reads as a broken app rather than a stale fixture. Set
    // it explicitly so this spec's user always matches what step 01 types.
    const pwReset = await adminFetch(
      supa.url,
      supa.secret,
      `/auth/v1/admin/users/${userId}`,
      'PUT',
      {
        password: PASSWORD,
        email_confirm: true,
      },
    );
    if (pwReset.status >= 400) {
      throw new Error(`admin password reset failed: HTTP ${pwReset.status} ${pwReset.body}`);
    }

    // Cancel-safety: delete the user_vault_keys row so onboarding step 05
    // always creates fresh vault keys under VAULT_PW, regardless of whether
    // a vault-password-change test in this file already rotated the password.
    // user_vault_keys cascades from auth.users (not from organizations), so
    // it is not cleared by the org DELETE below.
    const delVaultKeys = await adminFetch(
      supa.url,
      supa.secret,
      `/rest/v1/user_vault_keys?user_id=eq.${userId}`,
      'DELETE',
    );
    if (delVaultKeys.status >= 400) {
      throw new Error(
        `user_vault_keys delete failed: HTTP ${delVaultKeys.status} ${delVaultKeys.body}`,
      );
    }

    // org_members lookup
    const memQ = await adminFetch(
      supa.url,
      supa.secret,
      `/rest/v1/org_members?user_id=eq.${userId}&select=org_id`,
      'GET',
    );
    const mems: Array<{ org_id: string }> = JSON.parse(memQ.body);
    for (const m of mems) {
      const del = await adminFetch(
        supa.url,
        supa.secret,
        `/rest/v1/organizations?id=eq.${m.org_id}`,
        'DELETE',
      );
      if (del.status >= 400) {
        console.warn(`org delete returned HTTP ${del.status}: ${del.body}`);
      }
    }
  });

  test('walks full onboarding with per-step asserts', async ({ page }) => {
    test.setTimeout(180_000);
    const baseURL = '';

    // 01 — /login renders + sign in (user already created by admin-create
    // in beforeAll with email_confirm=true; going to /signup fails because
    // the email is taken)
    await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });
    const email = page.locator('input[type="email"]').first();
    const pw = page.locator('input[type="password"]').first();
    await expect(email, 'login email field').toBeVisible({ timeout: 10_000 });
    await expect(pw, 'login password field').toBeVisible();
    await email.fill(EMAIL);
    await pw.fill(PASSWORD);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 20_000 });

    // 02 — StepName (v2 step 1 of 7, DL-0429): first-name field is optional,
    // fill it and Continue.
    await page.waitForTimeout(2_000);
    const nameInput = page.getByPlaceholder('First name');
    await expect(nameInput, 'onboarding name field').toBeVisible({ timeout: 15_000 });
    await nameInput.fill('E2E Walk');
    await clickWizardButton(page, /Continue/i);

    // 03 — StepEmail (v2 step 2 of 7). The wizard mounts post-auth, so this
    // step detects the live session, skips the OTP round trip, and shows
    // "Signed in as <email>" with a plain Continue instead.
    await expect(
      page.getByText(/Signed in as/i),
      'onboarding email step recognizes the live session',
    ).toBeVisible({ timeout: 15_000 });
    await clickWizardButton(page, /Continue/i);

    // 04 — StepEducation (v2 step 3 of 7): one non-skippable screen, "Got it".
    await expect(
      page.getByText('Your money stays yours.'),
      'onboarding education screen',
    ).toBeVisible({ timeout: 15_000 });
    await clickWizardButton(page, /Got it/i);

    // 05 — StepVaultPassword (v2 step 4 of 7). Same MIN_VAULT_PASSWORD_LENGTH
    // and zxcvbn >= 4 gate v1 uses, different DOM: aria-label fields, not a
    // "Minimum 14" placeholder.
    const vaultPw = page.getByLabel('Vault password', { exact: true });
    await expect(vaultPw, 'vault password field').toBeVisible({ timeout: 15_000 });
    await vaultPw.fill(VAULT_PW);
    await page.getByLabel('Confirm vault password', { exact: true }).fill(VAULT_PW);
    const vaultAckCb = page.locator('button[role="checkbox"], input[type="checkbox"]').first();
    await vaultAckCb.click({ force: true });
    await clickWizardButton(page, /Set my password/i);

    // 06 — StepRecovery, display stage (v2 step 5 of 7, "staged" mode): 12
    // words under data-testid="recovery-words", captured by position.
    await page.waitForSelector('[data-testid="recovery-words"]', { timeout: 30_000 });
    const wordsByPos: Record<number, string> = await page.evaluate(() => {
      const map: Record<number, string> = {};
      const items = document.querySelectorAll('[data-testid="recovery-words"] > li');
      items.forEach((li, i) => {
        const spans = li.querySelectorAll(':scope > span');
        const w = (spans[1]?.textContent || '').trim();
        if (w) map[i + 1] = w;
      });
      return map;
    });
    expect(Object.keys(wordsByPos).length, 'recovery code should yield 12 words').toBe(12);
    const recoveryConfirmCb = page
      .locator('button[role="checkbox"], input[type="checkbox"]')
      .first();
    await recoveryConfirmCb.click({ force: true });
    await clickWizardButton(page, /I've written it down/i);

    // 06b — StepRecovery, verify stage (still v2 step 5 of 7): type back the
    // 3 highlighted words, matched by position from the captured code.
    await page.waitForSelector('[data-testid="recovery-verify-block"]', { timeout: 15_000 });
    for (const inp of await page.locator('[data-testid^="verify-word-"]').all()) {
      const tid = await inp.getAttribute('data-testid');
      const z = parseInt(tid!.match(/verify-word-(\d+)$/)![1]);
      const w = wordsByPos[z + 1];
      if (w) await inp.fill(w);
    }
    await clickWizardButton(page, /Confirm and continue/i);

    // 06c — StepSuccess (v2 step 6 of 7, last wizard step). Either CTA hands
    // off to OrgSetupSurface.
    await expect(page.getByText("You're all set."), 'onboarding success screen').toBeVisible({
      timeout: 15_000,
    });
    await clickWizardButton(page, /Make my first entry/i);

    // 06d — OrgSetupSurface screen 1/3: organization name.
    const orgIn = page.locator('#org-name');
    await expect(orgIn, 'org name input').toBeVisible({ timeout: 15_000 });
    await orgIn.fill(ORG_NAME);
    await clickWizardButton(page, /Continue/i);

    // 06e — OrgSetupSurface screen 2/3: currencies. Native <select>, no
    // Radix popup, so no pointer-events race to guard against here.
    const primaryCurrency = page.locator('#primary-currency');
    await expect(primaryCurrency, 'primary currency select').toBeVisible({ timeout: 15_000 });
    await primaryCurrency.selectOption('BTC');
    await clickWizardButton(page, /Continue/i);

    // 06f (DL-0720/0721 parity): OrgSetupSurface screen 3/3: fiscal year
    // start and timezone, both read back on the Admin page in step 11.
    const fiscalSelect = page.locator('#fiscal-year-start');
    await expect(fiscalSelect, 'fiscal year start select').toBeVisible({ timeout: 15_000 });
    await fiscalSelect.selectOption('april');
    const timezoneSelect = page.locator('#timezone');
    await timezoneSelect.selectOption('America/New_York');
    await clickWizardButton(page, /Open my books/i);

    // 07 — ledger bootstrap; wait up to 45s for sidebar
    await expect(
      page.getByTestId('app-shell').first(),
      'authenticated shell after onboarding',
    ).toBeVisible({ timeout: 45_000 });

    // 08 — dashboard renders and ledger_status is actually 'ready', not just
    // "not the provisioning pill". LedgerReadyBadge and LedgerStatusPill both
    // render data-testid="ledger-status-pill" but are mutually exclusive on
    // data-ledger-status (ready vs provisioning/failed), so this fails
    // correctly if chart-of-accounts seeding errored (ledger_status='failed',
    // pill text "Setup failed") instead of only checking for absence of the
    // literal string "Finishing setup…", which failed and succeeded looked
    // identical to.
    //
    // Timeout is 120s because initChartOfAccounts (43 accounts, Argon2id +
    // AES-GCM) runs fire-and-forget after onComplete() returns in
    // OrgSetupSurface.tsx, taking ~30s on a laptop and 60-90s on a shared CI
    // runner. useLedgerStatus polls every 2s while provisioning, so it picks
    // up the DB 'ready' update within 2s of seeding completing. 120s covers
    // worst-case CI timing with headroom.
    // DO NOT call page.goto() before this assertion. initChartOfAccounts
    // runs client-side as a fire-and-forget IIFE after onComplete() fires.
    // A full page navigation terminates the browser JS context and kills the
    // in-progress insert loop, leaving ledger_status permanently stuck at
    // 'provisioning'. The MEK lives only in memory and is gone after a reload,
    // so no process resumes the inserts. Step 07 already confirmed app-shell
    // is mounted (the SPA is on the dashboard); wait for the pill here on the
    // current page.
    await expect(
      page.locator('[data-testid="ledger-status-pill"][data-ledger-status="ready"]'),
      'ledger_status must be ready, not provisioning or failed, after onboarding',
    ).toBeAttached({ timeout: 120_000 });

    // 09 — the above directly checks the seeded state (ledger_status flips
    // to 'ready' only after initChartOfAccounts completes without throwing,
    // per OnboardingWizard.tsx), so a separate chart_of_accounts REST query
    // is not needed to catch a failed seed.

    // 10 — master-recovery page renders (React #310 regression).
    // page.goto reloads the SPA which loses the in-memory MEK; need to
    // re-unlock and wait for the authenticated shell to mount before
    // checking for the heading.
    await page.goto(`${baseURL}/app/settings/master-recovery`, { waitUntil: 'domcontentloaded' });
    const lock = page.locator('text="Unlock your encrypted vault"').first();
    // Wait up to 15 s for EITHER the vault-lock prompt OR the authenticated
    // app shell. VaultGate must finish an async org_members query before it
    // renders VaultUnlockScreen; after a heavy onboarding flow that query
    // can take longer than the old 2 s deadline, causing the unlock block to
    // be silently skipped and the shell assertion to time out.
    await expect(
      lock.or(page.getByTestId('app-shell').first()),
      'vault lock screen or app shell after master-recovery goto',
    ).toBeVisible({ timeout: 15_000 });
    if (await lock.isVisible().catch(() => false)) {
      await page.locator('input[type="password"]').first().fill(VAULT_PW);
      await page.locator('button:has-text("Unlock Vault")').first().click();
      await lock.waitFor({ state: 'hidden', timeout: 30_000 });
    }
    // Wait for sidebar to mount (proves auth shell rendered).
    await expect(
      page.getByTestId('app-shell').first(),
      'app shell after master-recovery unlock',
    ).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1_500);
    await expect(
      page
        .locator('h1, h2')
        .filter({ hasText: /Master recovery key/i })
        .first(),
      'master-recovery heading must render — React #310 regression',
    ).toBeVisible({ timeout: 15_000 });

    // 11 (DL-0720/0721): admin settings readback. The fiscal-year-start and
    // timezone chosen during onboarding must survive the client-side
    // encrypt/decrypt round-trip and render on the Admin settings page. This
    // is a UI readback: the values are decrypted in the browser. A
    // service-role DB read would only ever see ciphertext, so it cannot
    // prove this.
    await page.goto(`${baseURL}/app/admin`, { waitUntil: 'domcontentloaded' });
    const adminLock = page.locator('text="Unlock your encrypted vault"').first();
    // Same robust pattern as step 10: settle the async VaultGate gate first,
    // then decide whether to unlock based on what actually rendered.
    await expect(
      adminLock.or(page.getByTestId('app-shell').first()),
      'vault lock screen or app shell on admin page',
    ).toBeVisible({ timeout: 15_000 });
    if (await adminLock.isVisible().catch(() => false)) {
      await page.locator('input[type="password"]').first().fill(VAULT_PW);
      await page.locator('button:has-text("Unlock Vault")').first().click();
      await adminLock.waitFor({ state: 'hidden', timeout: 30_000 });
    }
    await expect(page.getByTestId('app-shell').first(), 'app shell on admin page').toBeVisible({
      timeout: 15_000,
    });
    await page.waitForTimeout(2_000);
    await expect(
      page.getByTestId('admin-fiscal-month'),
      'admin fiscal-month readback must show April (DL-0720)',
    ).toContainText('April', { timeout: 15_000 });
    await expect(
      page.getByTestId('admin-timezone'),
      'admin timezone readback must show Eastern (DL-0721)',
    ).toContainText('Eastern', { timeout: 15_000 });
  });

  test(
    'vault password change: v1. re-written, old pw rejected, new pw unlocks (OWB-T0092)',
    async ({ page }) => {
      test.setTimeout(120_000);

      if (!supa) throw new Error('supa is null: beforeAll did not run');
      const userId = await findUserIdByEmail(supa, EMAIL);

      // Read the encrypted_private_key before any change so we can assert it is
      // unchanged after a wrong-password attempt and different after a correct one.
      const rowBeforeRes = await adminFetch(
        supa.url,
        supa.secret,
        `/rest/v1/user_vault_keys?user_id=eq.${userId}&select=encrypted_private_key`,
        'GET',
      );
      if (rowBeforeRes.status >= 400)
        throw new Error(
          `vault-keys read before: HTTP ${rowBeforeRes.status} ${rowBeforeRes.body}`,
        );
      const rowBeforeArr: Array<{ encrypted_private_key: string }> =
        JSON.parse(rowBeforeRes.body);
      if (!rowBeforeArr[0])
        throw new Error(
          'no user_vault_keys row: onboarding step 05 did not complete in this run',
        );
      const rowBefore = rowBeforeArr[0].encrypted_private_key;
      expect(rowBefore.startsWith('v1.'), 'pre-test row starts with v1.').toBe(true);

      // Sign in fresh (each serial test receives a new browser context).
      const baseURL = '';
      await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded' });
      const emailInput = page.locator('input[type="email"]').first();
      await expect(emailInput, 'login email field').toBeVisible({ timeout: 10_000 });
      await emailInput.fill(EMAIL);
      await page.locator('input[type="password"]').first().fill(PASSWORD);
      await page.locator('button[type="submit"]').first().click();
      await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 20_000 });

      // Navigate to the vault-password-change page.
      await page.goto(`${baseURL}/app/settings/change-password`, {
        waitUntil: 'domcontentloaded',
      });

      // Handle vault lock screen (vault is always locked after a fresh sign-in).
      const lockPw = page.locator('text="Unlock your encrypted vault"').first();
      await expect(
        lockPw.or(page.getByTestId('app-shell').first()),
        'lock or app-shell on change-password page',
      ).toBeVisible({ timeout: 15_000 });
      if (await lockPw.isVisible().catch(() => false)) {
        await page.locator('input[type="password"]').first().fill(VAULT_PW);
        await page.locator('button:has-text("Unlock Vault")').first().click();
        await lockPw.waitFor({ state: 'hidden', timeout: 30_000 });
      }

      // --- Wrong current password ---
      // The component renders the WebCrypto DOMException in p.text-destructive.
      await page.locator('#current').fill('DefinitelyWrongVaultPw-WalkE2E!');
      await page.locator('#new').fill(VAULT_PW_NEW);
      await page.locator('#confirm').fill(VAULT_PW_NEW);
      await page.locator('button[type="submit"]').first().click();

      const errPara = page.locator('p.text-destructive');
      await expect(errPara, 'wrong-pw: error paragraph visible').toBeVisible({ timeout: 15_000 });
      await expect(
        errPara,
        'wrong-pw: component shows WebCrypto decrypt failure message',
      ).toContainText('The operation failed for an operation-specific reason');

      // Must NOT have advanced to the recovery kit page.
      await expect(
        page.locator('h1').filter({ hasText: /Save Your New Recovery Kit/i }).first(),
        'wrong-pw: recovery kit heading must not appear',
      ).not.toBeVisible();

      // DB row must be unchanged after the failed attempt (booleans only, no values printed).
      const rowUnchangedRes = await adminFetch(
        supa.url,
        supa.secret,
        `/rest/v1/user_vault_keys?user_id=eq.${userId}&select=encrypted_private_key`,
        'GET',
      );
      if (rowUnchangedRes.status >= 400)
        throw new Error(
          `vault-keys read after wrong-pw: HTTP ${rowUnchangedRes.status} ${rowUnchangedRes.body}`,
        );
      const rowUnchangedArr: Array<{ encrypted_private_key: string }> =
        JSON.parse(rowUnchangedRes.body);
      const rowUnchanged = rowUnchangedArr[0]?.encrypted_private_key ?? '';
      expect(rowUnchanged.startsWith('v1.'), 'wrong-pw: row still starts with v1.').toBe(true);
      expect(rowUnchanged === rowBefore, 'wrong-pw: row is unchanged').toBe(true);

      // --- Successful password change ---
      await page.locator('#current').fill(VAULT_PW);
      await page.locator('#new').fill(VAULT_PW_NEW);
      await page.locator('#confirm').fill(VAULT_PW_NEW);
      await page.locator('button[type="submit"]').first().click();

      await expect(
        page.locator('h1').filter({ hasText: /Save Your New Recovery Kit/i }).first(),
        'successful change: recovery kit heading',
      ).toBeVisible({ timeout: 30_000 });

      // DB row must start with v1. and differ from the pre-test snapshot.
      const rowChangedRes = await adminFetch(
        supa.url,
        supa.secret,
        `/rest/v1/user_vault_keys?user_id=eq.${userId}&select=encrypted_private_key`,
        'GET',
      );
      if (rowChangedRes.status >= 400)
        throw new Error(
          `vault-keys read after change: HTTP ${rowChangedRes.status} ${rowChangedRes.body}`,
        );
      const rowChangedArr: Array<{ encrypted_private_key: string }> =
        JSON.parse(rowChangedRes.body);
      const rowChanged = rowChangedArr[0]?.encrypted_private_key ?? '';
      expect(rowChanged.startsWith('v1.'), 'after change: row starts with v1.').toBe(true);
      expect(rowChanged !== rowBefore, 'after change: row differs from snapshot').toBe(true);

      // Acknowledge the new recovery kit and dismiss.
      const ackCb = page.locator('button[role="checkbox"]').first();
      await expect(ackCb, 'recovery kit ack checkbox').toBeVisible({ timeout: 10_000 });
      await ackCb.click({ force: true });
      await page.locator('button:has-text("Done")').first().click();
      await page.waitForTimeout(2_000);

      // --- Sign out, sign back in, old pw rejected (once), new pw unlocks ---
      await page.evaluate(() => { window.localStorage.clear(); });
      await page.goto('/login', { waitUntil: 'domcontentloaded' });
      await expect(
        page.locator('input[type="email"]').first(),
        'login email after sign-out',
      ).toBeVisible({ timeout: 10_000 });
      await page.locator('input[type="email"]').first().fill(EMAIL);
      await page.locator('input[type="password"]').first().fill(PASSWORD);
      await page.locator('button[type="submit"]').first().click();
      await page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 20_000 });

      // Navigate to a vault-gated page to trigger the lock screen.
      await page.goto(`${baseURL}/app`, { waitUntil: 'domcontentloaded' });
      const lockAfter = page.locator('text="Unlock your encrypted vault"').first();
      await expect(
        lockAfter.or(page.getByTestId('app-shell').first()),
        'lock or app-shell after re-sign-in',
      ).toBeVisible({ timeout: 15_000 });

      if (!(await lockAfter.isVisible().catch(() => false))) {
        throw new Error(
          'expected vault lock screen after re-sign-in: MEK must not persist across sessions',
        );
      }

      // Old vault password is rejected (one attempt only, per CTO spec).
      await page.locator('input[type="password"]').first().fill(VAULT_PW);
      await page.locator('button:has-text("Unlock Vault")').first().click();
      await page.waitForTimeout(3_000);
      await expect(lockAfter, 'lock must remain after old vault password').toBeVisible();

      // New vault password unlocks.
      await page.locator('input[type="password"]').first().fill(VAULT_PW_NEW);
      await page.locator('button:has-text("Unlock Vault")').first().click();
      await lockAfter.waitFor({ state: 'hidden', timeout: 30_000 });
      await expect(
        page.getByTestId('app-shell').first(),
        'app shell visible after new vault password (OWB-T0092)',
      ).toBeVisible({ timeout: 15_000 });
    },
  );
});
