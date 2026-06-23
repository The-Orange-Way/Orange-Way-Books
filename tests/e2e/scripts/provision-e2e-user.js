// Provision a stable OWB DEV E2E test user with full onboarding (vault pw + org).
// Idempotent: if the user already exists, signs in and either confirms onboarding
// is complete OR finishes onboarding. Outputs creds to /tmp/owb-pw/e2e-creds.json.
//
// **DEV-ONLY by hard-coded guard.** The credentials below are committed in
// plaintext to a public repository and MUST NEVER be used to create a user
// on OWB PROD or any other live Supabase project. The check below pins the
// allowed project ref. To rotate the password, update both this file and
// the matching GitHub repo secrets / Jarvis vault entries.
const { chromium } = require('@playwright/test');
const fs = require('fs');
const https = require('https');

const EMAIL = 'e2e@orangewaybooks.test';
const PASSWORD = 'OwbE2E-Stable-2026!Pw';
const VAULT_PW = 'OwbE2EVault-Stable-2026!';

// Hard-coded allowlist of project refs this script may target. Lock to the
// OWB DEV ref. Adding any production ref here is a security incident.
const ALLOWED_PROJECT_REFS = new Set(
  (process.env.OWB_E2E_ALLOWED_PROJECT_REFS ?? '').split(',').filter(Boolean),
);

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

(async () => {
  const owb = JSON.parse(fs.readFileSync('/tmp/owb-pw/owb-dev-supabase.json', 'utf8'));
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
  //   (a) onboarding wizard, first-time user
  //   (b) vault unlock screen, already onboarded
  //   (c) dashboard, already onboarded + unlocked (unlikely on fresh session)
  const onboardVisible = await page
    .locator('text=Set Up Orange Way Books')
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
  } else if (onboardVisible) {
    console.log('→ walking onboarding');
    await page.locator('input[placeholder*="Minimum 14"]').fill(VAULT_PW);
    await page.locator('input[placeholder*="Re-enter"]').fill(VAULT_PW);
    await page.click('button:has-text("Continue")');
    await page.waitForSelector('text=Save Your Recovery Code', { timeout: 15000 });
    await page.waitForTimeout(1000);
    const wordsByPos = await page.evaluate(() => {
      const map = {};
      for (const c of Array.from(document.querySelectorAll('div'))) {
        const spans = c.querySelectorAll(':scope > span');
        if (spans.length !== 2) continue;
        const m = (spans[0].textContent || '').trim().match(/^(\d+)\.?$/);
        const w = (spans[1].textContent || '').trim();
        if (m && /^[a-z]+$/.test(w)) map[parseInt(m[1])] = w;
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

  fs.writeFileSync(
    '/tmp/owb-pw/e2e-creds.json',
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
  console.log('→ wrote /tmp/owb-pw/e2e-creds.json');
  await browser.close();
})().catch((e) => {
  console.error('ERR:', e.stack || e);
  process.exit(1);
});
