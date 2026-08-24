// Provision a stable OWB DEV E2E test user with full onboarding (vault pw + org).
// Idempotent: if the user already exists, signs in and either confirms onboarding
// is complete OR finishes onboarding. Writes the fixture creds to a job-private
// temp dir (RUNNER_TEMP in CI), never a shared world-readable path.
//
// **DEV-ONLY by hard-coded guard.** The credentials below are committed in
// plaintext to a public repository and MUST NEVER be used to create a user
// on OWB PROD or any other live Supabase project. The check below pins the
// allowed project ref. To rotate the password, update both this file and
// the matching GitHub repo secrets / Jarvis vault entries.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

// Where transient creds live. On a CI runner /tmp is world-readable and shared;
// RUNNER_TEMP is a job-private dir GitHub wipes after the job, so prefer it.
// Allow an explicit override and only fall back to an OS temp dir for a purely
// local run. This keeps the fixture creds off a shared world-readable path.
const CREDS_DIR =
  process.env.OWB_E2E_CREDS_DIR ||
  (process.env.RUNNER_TEMP
    ? path.join(process.env.RUNNER_TEMP, 'owb-e2e')
    : path.join(os.tmpdir(), 'owb-e2e'));

// Read the fixture creds from the same OWB_DEV_E2E_* secrets the Playwright
// specs use, so provisioning and the specs are one source of truth. The
// plaintext literals are DEV-only fallbacks for a local run; in CI the secrets
// win. If these drift from the secrets, provisioning makes one user and the
// specs sign in as another, the exact failure this consolidates away.
const EMAIL = process.env.OWB_DEV_E2E_EMAIL || 'e2e@orangewaybooks.test';
const PASSWORD = process.env.OWB_DEV_E2E_PASSWORD || 'OwbE2E-Stable-2026!Pw';
const VAULT_PW = process.env.OWB_DEV_E2E_VAULT_PASSWORD || 'OwbE2EVault-Stable-2026!';

// Hard-coded allowlist of project refs this script may target, pinned as a
// LITERAL to the OWB DEV ref. This is the real guard: `ref` is derived below
// from the Supabase URL and must equal this constant. The previous version
// sourced the allowlist from an env var, which let the target validate itself,
// so a misconfig pointing at prod would have passed. Adding any production ref
// here is a security incident. To rotate DEV, change this one literal.
const OWB_DEV_PROJECT_REF = 'kbjvvhjkaanvyibjezsv';
const ALLOWED_PROJECT_REFS = new Set([OWB_DEV_PROJECT_REF]);

function adminCreateUser(supaUrl, secretKey, email, password) {
  return new Promise((res, rej) => {
    const body = JSON.stringify({ email, password, email_confirm: true });
    const u = new URL(supaUrl + '/auth/v1/admin/users');
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname,
        method: 'POST',
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
        },
      },
      (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => res({ status: r.statusCode, body: b }));
      },
    );
    req.on('error', rej);
    req.write(body);
    req.end();
  });
}

// Read back through PostgREST with the service key, which bypasses RLS. That is
// the point: it answers "does this row exist" rather than "can this caller see
// it", so a row hidden by a policy and a row that was never written stop looking
// the same. Distinguishing those two is exactly what this script could not do
// before, and it is why a broken fixture read as a healthy one for eight days.
/**
 * Walk onboarding v2.
 *
 * Kept separate from the v1 walk below rather than merged into it. The two
 * flows share a purpose and almost no selectors: every step differs from v1 in
 * either its heading, its input placeholder, or its button label, so a single
 * walk that tried to satisfy both would be one that quietly matches neither.
 *
 * The wizard is seven steps (name, email, education, vault password, recovery
 * kit with a staged verify, success) and is followed by a SEPARATE two screen
 * organization surface. That surface, not the wizard, is what writes the
 * organization and the org_members OWNER row, so it is the only part the
 * fixture actually depends on. Everything before it is preamble.
 *
 * Every step is clicked by its exact button label and every wait is on the
 * thing the next action needs, never a fixed sleep. When a button never
 * becomes clickable the walk exits non-zero and names the screen it stopped
 * on, because the failure this whole script exists to remove is the silent
 * one: a walk that stalls halfway and still reports success.
 *
 * Exit codes used here, kept distinct so a run says what broke:
 *   6  the email step asked for a one time code, which this script cannot read
 *   7  the recovery kit rendered no words, so no vault was created
 *   8  the organization surface never finished, so no organization exists
 *   9  some other wizard step never offered a clickable button
 */
async function walkOnboardingV2(page, vaultPw) {
  // Exact match, not substring: Playwright's has-text is a case insensitive
  // substring test, and "Continue" is a substring of "Confirm and continue".
  // Waits for enabled, not merely visible, because half of this flow's buttons
  // start disabled and a click on a disabled button is a silent no-op.
  const clickCta = async (label, screen, code) => {
    const btn = page.getByRole('button', { name: label, exact: true }).first();
    const deadline = Date.now() + 20000;
    for (;;) {
      const ready =
        (await btn.isVisible().catch(() => false)) && (await btn.isEnabled().catch(() => false));
      if (ready) break;
      if (Date.now() > deadline) {
        console.error(`  v2 stopped on ${screen}: the "${label}" button never became clickable.`);
        process.exit(code);
      }
      await page.waitForTimeout(500);
    }
    console.log(`  ${screen}: clicking "${label}"`);
    await btn.click();
  };

  // Step 1, name. Optional, but fill it rather than skipping: a provisioned
  // user that looks like a real one exercises the path a customer takes.
  const nameInput = page.locator('input[placeholder="First name"]').first();
  if ((await nameInput.count()) > 0) await nameInput.fill('OWB E2E');
  await clickCta('Continue', 'v2 step 1 (name)', 9);

  // Step 2, email. This wizard mounts post-auth, so the step should recognise
  // the session it is already inside and offer a plain Continue. If it instead
  // shows the one time code stage, stop here and say so: this script has no
  // inbox, so there is no code it could ever type, and every later step would
  // then fail on a selector that has nothing to do with the real cause.
  const signedIn = await page
    .locator('text=Signed in as')
    .isVisible({ timeout: 10000 })
    .catch(() => false);
  if (!signedIn) {
    console.error('  v2 stopped on step 2 (email): it asked an already authenticated user');
    console.error('  for a one time code. This script cannot receive email.');
    process.exit(6);
  }
  await clickCta('Continue', 'v2 step 2 (email)', 9);

  // Step 3, education. A single acknowledgement.
  await clickCta('Got it', 'v2 step 3 (education)', 9);

  // Step 4, vault password. Argon2id at 64 MiB runs on the click, so the wait
  // for the recovery kit that follows is deliberately generous.
  await page.locator('input[placeholder="Vault password"]').fill(vaultPw);
  await page.locator('input[placeholder="Confirm vault password"]').fill(vaultPw);
  await clickCta('Set my password', 'v2 step 4 (vault password)', 9);

  // Step 5a, recovery kit. v2 renders the words as list items carrying no
  // per word test id, so read them positionally: each item is the position
  // label followed by the word. Keyed from 1 to match the verify inputs, which
  // are indexed from 0 against the same word list.
  await page.waitForSelector('[data-testid="recovery-words"]', { timeout: 30000 });
  const wordsByPos = await page.evaluate(() => {
    const map = {};
    const items = document.querySelectorAll('[data-testid="recovery-words"] > li');
    items.forEach((li, index) => {
      const spans = li.querySelectorAll(':scope > span');
      const word = (spans[1] ? spans[1].textContent || '' : '').trim();
      if (/^[a-z]+$/.test(word)) map[index + 1] = word;
    });
    return map;
  });
  const captured = Object.keys(wordsByPos).length;
  console.log('  words captured:', captured);
  if (captured === 0) {
    console.error('  v2 stopped on step 5 (recovery kit): it rendered no words,');
    console.error('  which means the vault was never created.');
    process.exit(7);
  }
  const ack = page.locator('button[role="checkbox"], input[type="checkbox"]').first();
  if ((await ack.count()) > 0)
    await ack.check({ force: true }).catch(async () => {
      await ack.click({ force: true }).catch(() => {});
    });
  await clickCta("I've written it down", 'v2 step 5 (recovery kit)', 9);

  // Step 5b, the staged verify. Same step, second stage, and its Confirm stays
  // disabled until the typed words actually match, so a wrong capture above
  // surfaces here as a stall rather than as a pass.
  await page.waitForSelector('[data-testid="recovery-verify-block"]', { timeout: 15000 });
  for (const input of await page.locator('[data-testid^="verify-word-"]').all()) {
    const testId = await input.getAttribute('data-testid');
    const position = parseInt(testId.match(/verify-word-(\d+)$/)[1], 10);
    const word = wordsByPos[position + 1];
    if (word) await input.fill(word);
  }
  await clickCta('Confirm and continue', 'v2 step 5b (verify recovery words)', 9);

  // Step 6, success. The wizard is not finished until this is clicked: it is
  // the last step, so its Next is what hands control to the organization
  // surface. Skipping it was why the walk previously arrived at the org screens
  // that were never mounted.
  await clickCta('Make my first entry', 'v2 step 6 (success)', 9);

  // Organization setup. TWO screens, not one, and this is the phase that
  // actually writes the organization and the org_members OWNER row.
  const orgName = page.locator('#org-name');
  try {
    await orgName.waitFor({ state: 'visible', timeout: 20000 });
  } catch {
    console.error('  v2 stopped after the wizard: the organization name field never rendered,');
    console.error('  so the organization surface did not mount.');
    process.exit(8);
  }
  await orgName.fill('OWB E2E Org');
  await clickCta('Continue', 'org setup screen 1 of 2 (name)', 8);

  const currency = page.locator('#primary-currency');
  try {
    await currency.waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    console.error('  v2 stopped on org setup screen 1 of 2: the currency screen never arrived.');
    process.exit(8);
  }
  // The final button stays disabled until a primary currency is chosen, and the
  // select opens on a disabled placeholder, so this has to be set explicitly.
  // The value is read out of the DOM rather than named here: the list comes
  // from the currency registry, and a walk that hardcodes one code is a walk
  // that breaks the day that entry moves.
  const currencyValue = await page.$eval('#primary-currency', (el) => {
    const option = Array.from(el.options).find((o) => !o.disabled && o.value);
    return option ? option.value : '';
  });
  if (!currencyValue) {
    console.error('  v2 stopped on org setup screen 2 of 2: the primary currency select');
    console.error('  offered no enabled option, so its button can never enable.');
    process.exit(8);
  }
  await page.selectOption('#primary-currency', currencyValue);
  console.log(`  primary currency: ${currencyValue}`);
  await clickCta('Open my books', 'org setup screen 2 of 2 (currencies)', 8);

  console.log('  waiting 25s for ledger bootstrap');
  await page.waitForTimeout(25000);
}

function restGetJson(supaUrl, secretKey, pathAndQuery) {
  return new Promise((res, rej) => {
    const u = new URL(supaUrl + pathAndQuery);
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          apikey: secretKey,
          Authorization: `Bearer ${secretKey}`,
          Accept: 'application/json',
        },
      },
      (r) => {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => {
          let parsed = null;
          try {
            parsed = JSON.parse(b);
          } catch {
            parsed = null;
          }
          res({ status: r.statusCode, body: b, json: parsed });
        });
      },
    );
    req.on('error', rej);
    req.end();
  });
}

(async () => {
  // Source the DEV Supabase URL + secret (service) key. In CI both arrive as
  // env vars from GitHub Actions secrets; locally they fall back to the Jarvis
  // vault file. The URL is used both to reach the admin API and to derive the
  // project ref checked against ALLOWED_PROJECT_REFS below.
  const owb = (() => {
    const url = process.env.OWB_E2E_SUPABASE_URL;
    const secret = process.env.OWB_E2E_SUPABASE_SECRET_KEY;
    if (url && secret) return { url, secret };
    return JSON.parse(fs.readFileSync(path.join(CREDS_DIR, 'owb-dev-supabase.json'), 'utf8'));
  })();
  const BASE = 'https://books.orangeway.dev';

  // Refuse to run if owb.url targets anything outside the DEV allowlist.
  const ref = (() => {
    try {
      return new URL(owb.url).hostname.split('.')[0];
    } catch {
      return '';
    }
  })();
  if (!ALLOWED_PROJECT_REFS.has(ref)) {
    console.error(`✗ refusing to run: project ref "${ref}" is not in ALLOWED_PROJECT_REFS.`);
    console.error('  This script provisions a user with a password committed to the public repo.');
    console.error(
      '  Only OWB DEV is allowed. Edit ALLOWED_PROJECT_REFS in this file to add a ref.',
    );
    process.exit(2);
  }

  console.log('→ ensuring user exists:', EMAIL);
  const cr = await adminCreateUser(owb.url, owb.secret, EMAIL, PASSWORD);
  if (cr.status === 422 || cr.status === 200 || cr.status === 201) {
    console.log(`  user create: HTTP ${cr.status} (422 = already exists, fine)`);
  } else if (cr.status >= 400) {
    console.error('  user create failed:', cr.body);
    process.exit(1);
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();

  // Collect the two signals that actually explain a failed onboarding: browser
  // console errors, and non-2xx replies from Supabase. Previously both were
  // discarded, so when the org insert failed the run printed nothing about it
  // and exited 0. These are printed only on failure, so a healthy run stays quiet.
  const consoleErrors = [];
  const httpFailures = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300));
  });
  page.on('response', async (r) => {
    if (r.status() < 400 || !/supabase\.co/.test(r.url())) return;
    const body = await r.text().catch(() => '');
    httpFailures.push(
      `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname} ${body.slice(0, 300)}`,
    );
  });

  console.log('→ sign in');
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.toString().includes('/login'), { timeout: 30000 }),
    page.click('button[type="submit"]'),
  ]);
  await page.waitForTimeout(2000);

  // Three possible states:
  //   (a) onboarding wizard: first-time user
  //   (b) vault unlock screen: already onboarded
  //   (c) dashboard: already onboarded + unlocked (unlikely on fresh session)
  const onboardVisible = await page
    .locator('text=Set Up Orange Way Books')
    .isVisible({ timeout: 3000 })
    .catch(() => false);
  // Onboarding v2 (VITE_ONBOARDING_V2) is a different wizard, not a reskin of
  // v1, so it needs its own walk. It opens on the name step instead of the
  // vault password, its password inputs carry different placeholders, its
  // buttons are labelled per step rather than all "Continue", and it publishes
  // the recovery words as plain list items without the per-word test ids v1
  // exposes. Detect it by the heading of its first step.
  //
  // Worth a separate check rather than a looser selector, because getting it
  // wrong is not a loud failure: the v1 heading never appears under v2, so the
  // walk would fall through to the "already authenticated" branch, reach /app
  // (where the wizard renders for a user with no organization) and report
  // success having created nothing.
  const v2Visible = await page
    .locator('text=What should we call you?')
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  const unlockVisible = await page
    .locator('text="Unlock your encrypted vault"')
    .isVisible({ timeout: 1500 })
    .catch(() => false);

  if (unlockVisible) {
    console.log('→ user already onboarded; verifying unlock works');
    await page.locator('input[type="password"]').fill(VAULT_PW);
    await page.locator('button:has-text("Unlock Vault")').first().click();
    await page.waitForTimeout(3000);
    const stillLocked = await page
      .locator('button:has-text("Unlock Vault")')
      .isVisible()
      .catch(() => false);
    if (stillLocked) {
      console.error('  unlock rejected, vault pw drift');
      process.exit(2);
    }
    console.log('  unlock OK');
  } else if (v2Visible) {
    console.log('\u2192 walking onboarding v2');
    await walkOnboardingV2(page, VAULT_PW);
  } else if (onboardVisible) {
    console.log('→ walking onboarding');
    await page.locator('input[placeholder*="Minimum 14"]').fill(VAULT_PW);
    await page.locator('input[placeholder*="Re-enter"]').fill(VAULT_PW);
    await page.click('button:has-text("Continue")');
    await page.waitForSelector('[data-testid="recovery-code-grid"]', { timeout: 15000 });
    await page.waitForTimeout(1000);
    const wordsByPos = await page.evaluate(() => {
      const map = {};
      for (const el of Array.from(document.querySelectorAll('[data-testid^="recovery-word-"]'))) {
        const m = (el.getAttribute('data-testid') || '').match(/^recovery-word-(\d+)$/);
        if (!m) continue;
        const spans = el.querySelectorAll(':scope > span');
        const w = (spans[1] ? spans[1].textContent || '' : '').trim();
        if (/^[a-z]+$/.test(w)) map[parseInt(m[1], 10) + 1] = w;
      }
      return map;
    });
    console.log('  words captured:', Object.keys(wordsByPos).length);
    const cb = page.locator('button[role="checkbox"], input[type="checkbox"]').first();
    if ((await cb.count()) > 0)
      await cb.check({ force: true }).catch(async () => {
        await cb.click({ force: true }).catch(() => {});
      });
    await page.locator('button:has-text("Continue")').first().click({ force: true });
    await page.waitForSelector('[data-testid="recovery-verify-block"]', { timeout: 10000 });
    await page.waitForTimeout(500);
    for (const inp of await page.locator('[data-testid^="verify-word-"]').all()) {
      const tid = await inp.getAttribute('data-testid');
      const z = parseInt(tid.match(/verify-word-(\d+)$/)[1]);
      const w = wordsByPos[z + 1];
      if (w) await inp.fill(w);
    }
    await page.locator('button:has-text("Confirm")').first().click({ force: true });
    await page.waitForTimeout(2000);
    const orgIn = page.locator('input:visible').first();
    if ((await orgIn.count()) > 0) await orgIn.fill('OWB E2E Org').catch(() => {});

    // Step through Organization, Reporting and Calendar to the commit button.
    // Every iteration says which step it is on and which button it pressed. The
    // previous version swallowed each click in an empty catch and broke out of
    // the loop without a word when no enabled button matched, so a walk that
    // stalled on step 2 was indistinguishable from one that finished.
    let committed = false;
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(1000);
      const stepLabel = await page
        .locator('text=/Step \\d of \\d/')
        .first()
        .innerText()
        .catch(() => '(no step marker)');
      const btn = page
        .locator('button:visible:not([disabled])')
        .filter({ hasText: /Continue|Create organization|Finish|Get started|Done|Next/i })
        .first();
      if ((await btn.count()) === 0) {
        console.log(`  stalled on ${stepLabel}: no enabled button to advance`);
        break;
      }
      const label = (await btn.innerText().catch(() => '')).trim();
      console.log(`  ${stepLabel}: clicking "${label}"`);
      try {
        await btn.click({ force: true, timeout: 5000 });
      } catch (e) {
        console.log(`  click on "${label}" failed: ${String(e.message || e).slice(0, 160)}`);
        break;
      }
      if (/create organization|finish|get started|done/i.test(label)) {
        committed = true;
        break;
      }
    }
    if (!committed) {
      console.log('  never reached the commit button');
    }
    console.log('  waiting 25s for ledger bootstrap');
    await page.waitForTimeout(25000);
  } else {
    console.log('→ neither onboarding nor unlock visible, assume already authenticated');
  }

  // Sanity: at the end we should be able to reach /app without bouncing back to /login
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const url = page.url();
  if (url.includes('/login')) {
    console.error('  ended up at /login, session lost');
    process.exit(3);
  }
  console.log('→ final URL:', url);

  // The real check. Reaching /app proves nothing on its own: App.tsx renders the
  // onboarding wizard for ANY route while the user has no org membership, so a
  // user who never got an organization still lands on /app looking healthy. That
  // is precisely how this script reported success on every run from 2026-08-13
  // while the fixture had no org, and why three specs failed for eight days with
  // a fifteen second timeout that named none of this.
  //
  // So ask the database the same question App.tsx asks, with the service key so
  // RLS cannot mask the answer, and refuse to exit 0 unless the row is there.
  console.log('→ verifying the fixture really is onboarded');
  // Resolve the id from the auth admin API rather than from the browser. The
  // session in localStorage would also answer, but that blob carries the access
  // and refresh tokens, and the safe way to handle a secret is not to read it in
  // the first place. This asks by email and gets back only what is needed.
  const listed = await restGetJson(owb.url, owb.secret, `/auth/v1/admin/users?page=1&per_page=200`);
  // GoTrue has returned both {users: [...]} and a bare array across versions, so
  // accept either rather than reading a shape and calling a mismatch a failure.
  const users = Array.isArray(listed.json)
    ? listed.json
    : listed.json && Array.isArray(listed.json.users)
      ? listed.json.users
      : null;
  if (listed.status >= 400 || users === null) {
    // Exit 4 means this check could not run. Exit 5 below means it ran and the
    // fixture is genuinely broken. Keeping those apart matters: a checker that
    // reddens a run by malfunctioning is the same failure this commit removes.
    console.error(`✗ auth admin lookup failed: HTTP ${listed.status}, unexpected body shape`);
    process.exit(4);
  }
  const found = users.find((u) => (u.email || '').toLowerCase() === EMAIL.toLowerCase());
  const userId = found && found.id;
  if (!userId) {
    console.error(`✗ auth admin lookup returned ${users.length} users, none matching the fixture`);
    process.exit(4);
  }

  const membership = await restGetJson(
    owb.url,
    owb.secret,
    `/rest/v1/org_members?select=org_id,role&user_id=eq.${encodeURIComponent(userId)}`,
  );
  const rows = Array.isArray(membership.json) ? membership.json : [];
  if (membership.status >= 400 || rows.length === 0) {
    console.error('');
    console.error('✗ PROVISIONING FAILED: the fixture user has no organization.');
    console.error(`  org_members lookup: HTTP ${membership.status}, ${rows.length} row(s)`);
    console.error('  The specs that sign in and unlock a vault CANNOT pass in this state:');
    console.error('  with no membership the app renders onboarding, so there is no vault');
    console.error('  to unlock and no app shell to find.');
    if (httpFailures.length) {
      console.error('  Supabase replies that failed during the walk:');
      for (const f of httpFailures.slice(0, 10)) console.error('    ' + f);
    } else {
      console.error('  No failing Supabase reply was seen during the walk.');
    }
    if (consoleErrors.length) {
      console.error('  Browser console errors during the walk:');
      for (const c of consoleErrors.slice(0, 10)) console.error('    ' + c);
    }
    process.exit(5);
  }
  console.log(`  onboarded: ${rows.length} org membership row(s), role ${rows[0].role}`);

  fs.mkdirSync(CREDS_DIR, { recursive: true });
  const credsPath = path.join(CREDS_DIR, 'e2e-creds.json');
  fs.writeFileSync(
    credsPath,
    JSON.stringify(
      {
        email: EMAIL,
        password: PASSWORD,
        vault_password: VAULT_PW,
      },
      null,
      2,
    ),
  );
  console.log('→ wrote', credsPath);
  await browser.close();
})().catch((e) => {
  console.error('ERR:', e.stack || e);
  process.exit(1);
});
