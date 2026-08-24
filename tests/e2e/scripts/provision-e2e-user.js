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

/**
 * Walk onboarding v2.
 *
 * Kept separate from the v1 walk above rather than merged into it. The two
 * flows share a purpose and almost no selectors, and a single walk that tried
 * to satisfy both would be one that quietly matches neither: every step here
 * differs from v1 in either its heading, its input placeholder, or its button
 * label.
 *
 * Step order is name, email, education, vault password, recovery kit, verify.
 * Every wait below is on the thing the next action needs, not a fixed sleep,
 * so a step that never arrives fails where it happened rather than several
 * steps later on a mystery selector.
 */
async function walkOnboardingV2(page, vaultPw) {
  const clickCta = async (label) => {
    const btn = page.locator(`button:has-text("${label}")`).first();
    await btn.waitFor({ state: 'visible', timeout: 15000 });
    await btn.click({ force: true });
  };

  // Step 1, name. Optional, but fill it rather than skipping: a provisioned
  // user that looks like a real one exercises the same path a customer takes.
  console.log('  v2 step: name');
  const nameInput = page.locator('input[placeholder="First name"]').first();
  if ((await nameInput.count()) > 0) await nameInput.fill('OWB E2E');
  await clickCta('Continue');

  // Step 2, email. The wizard mounts post-auth, so this step should recognise
  // the session it is already inside and offer a plain Continue. If it instead
  // shows the one-time code stage, stop here and say so: this script has no
  // inbox, so there is no code it could ever type, and every later step would
  // fail on a selector that has nothing to do with the real cause.
  console.log('  v2 step: email');
  const signedIn = await page
    .locator('text=Signed in as')
    .isVisible({ timeout: 10000 })
    .catch(() => false);
  if (!signedIn) {
    console.error('  v2 email step asked for a one-time code for an already authenticated user.');
    console.error('  This script cannot receive email, so the walk cannot continue.');
    process.exit(6);
  }
  await clickCta('Continue');

  // Step 3, education. A single acknowledgement.
  console.log('  v2 step: education');
  await clickCta('Got it');

  // Step 4, vault password. Argon2id at 64 MiB runs on the click, so the wait
  // for the recovery kit that follows is deliberately generous.
  console.log('  v2 step: vault password');
  await page.locator('input[placeholder="Vault password"]').fill(vaultPw);
  await page.locator('input[placeholder="Confirm vault password"]').fill(vaultPw);
  await clickCta('Set my password');

  // Step 5, recovery kit. v2 renders the words as list items carrying no
  // per-word test id, so read them positionally: each item is the position
  // label followed by the word. Keyed from 1 to match the verify inputs below,
  // which are indexed from 0 against the same word list.
  console.log('  v2 step: recovery kit');
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
    console.error('  recovery kit rendered no words. The vault was not created.');
    process.exit(7);
  }
  const ack = page.locator('button[role="checkbox"], input[type="checkbox"]').first();
  if ((await ack.count()) > 0)
    await ack.check({ force: true }).catch(async () => {
      await ack.click({ force: true }).catch(() => {});
    });
  await clickCta("I've written it down");

  // Step 6, verify. Same test ids as v1, indexed from 0 into the word list.
  console.log('  v2 step: verify recovery words');
  await page.waitForSelector('[data-testid="recovery-verify-block"]', { timeout: 15000 });
  for (const input of await page.locator('[data-testid^="verify-word-"]').all()) {
    const testId = await input.getAttribute('data-testid');
    const position = parseInt(testId.match(/verify-word-(\d+)$/)[1], 10);
    const word = wordsByPos[position + 1];
    if (word) await input.fill(word);
  }
  await clickCta('Confirm and continue');

  // Organization setup, which is where the org and the org_members row are
  // actually written. Everything above this point is preamble as far as the
  // fixture is concerned.
  console.log('  v2 step: organization setup');
  await page.waitForTimeout(2000);
  const orgInput = page.locator('input:visible').first();
  if ((await orgInput.count()) > 0) await orgInput.fill('OWB E2E Org').catch(() => {});
  for (let i = 0; i < 6; i++) {
    await page.waitForTimeout(1000);
    const btn = page
      .locator('button:visible:not([disabled])')
      .filter({ hasText: /Continue|Create organization|Finish|Get started|Done|Next/i })
      .first();
    if ((await btn.count()) === 0) break;
    try {
      await btn.click({ force: true, timeout: 1500 });
    } catch {}
  }
  console.log('  waiting 25s for ledger bootstrap');
  await page.waitForTimeout(25000);
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
  //   (a) onboarding wizard — first-time user
  //   (b) vault unlock screen — already onboarded
  //   (c) dashboard — already onboarded + unlocked (unlikely on fresh session)
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
  // Getting this wrong is not a loud failure, which is why it is worth a
  // separate check rather than a looser selector: the v1 heading below simply
  // never appears under v2, so the walk would fall through to the "already
  // authenticated" branch, reach /app (where the wizard renders for a user
  // with no organization), and report success having created nothing.
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
      console.error('  unlock rejected — vault pw drift');
      process.exit(2);
    }
    console.log('  unlock OK');
  } else if (v2Visible) {
    console.log('→ walking onboarding v2');
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
    for (let i = 0; i < 6; i++) {
      await page.waitForTimeout(1000);
      const btn = page
        .locator('button:visible:not([disabled])')
        .filter({ hasText: /Continue|Create organization|Finish|Get started|Done|Next/i })
        .first();
      if ((await btn.count()) === 0) break;
      try {
        await btn.click({ force: true, timeout: 1500 });
      } catch {}
    }
    console.log('  waiting 25s for ledger bootstrap');
    await page.waitForTimeout(25000);
  } else {
    console.log('→ neither onboarding nor unlock visible — assume already authenticated');
  }

  // Sanity: at the end we should be able to reach /app without bouncing back to /login
  await page.goto(`${BASE}/app`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const url = page.url();
  if (url.includes('/login')) {
    console.error('  ended up at /login — session lost');
    process.exit(3);
  }
  console.log('→ final URL:', url);

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
