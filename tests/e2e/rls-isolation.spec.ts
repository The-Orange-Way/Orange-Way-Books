/**
 * RLS isolation smoke — single-user containment check.
 *
 * Signs in as the e2e user, then queries every org-scoped table via the
 * REST API using the user's own session token. Asserts that every returned
 * row's org_id matches the user's own org. If RLS is missing or wrong,
 * this surfaces as "row visible whose org_id != user's org_id" — a hard
 * failure.
 *
 * This is the "single-user containment" version of the isolation smoke.
 * It proves RLS filters MY queries to MY data. It does NOT prove another
 * user can't reach into my data (that requires 2 real users + cross-read
 * attempts) — that's a follow-up.
 *
 * Companion to the structural RLS audit (separate doc); this spec
 * checks the runtime effect of every policy.
 *
 * Runs on every owb-full-suite invocation (not gated) — it's read-only.
 */

import { test, expect } from '@playwright/test';
import { signIn, unlockVaultIfNeeded } from './lib/auth';

interface SessionShape {
  access_token: string;
  user: { id: string };
}

// Tables that have an `org_id` column AND are user-visible (skip lookup
// tables that intentionally blanket-allow SELECT, and webhook/internal
// tables that have RLS-on + no policies — those return [] for the user role).
const ORG_SCOPED_TABLES = [
  'chart_of_accounts',
  'wallets',
  'journal_entries',
  'journal_entry_lines',
  'transactions',
  'contacts',
  'organizations',
  'org_settings',
  'org_members',
  'invoices',
];

test('RLS isolation — every returned row has my org_id', async ({ page }) => {
  test.setTimeout(60_000);
  const baseURL = 'https://books.orangeway.dev';

  await signIn(page);
  await page.goto(`${baseURL}/app`, { waitUntil: 'networkidle' });
  await unlockVaultIfNeeded(page);
  // Belt-and-suspenders: if helper missed the lock screen, re-check + fill manually.
  const stillLocked = await page
    .locator('text="Unlock your encrypted vault"')
    .first()
    .isVisible({ timeout: 500 })
    .catch(() => false);
  if (stillLocked) {
    await page
      .locator('input[type="password"]')
      .first()
      .fill(process.env.OWB_DEV_E2E_VAULT_PASSWORD!);
    await page.locator('button:has-text("Unlock Vault")').first().click();
    await page
      .locator('text="Unlock your encrypted vault"')
      .first()
      .waitFor({ state: 'hidden', timeout: 30_000 });
  }
  await expect(page.locator('text=Insights').first()).toBeVisible({ timeout: 15_000 });

  // Pull the active session token + the publishable apikey + the
  // supabase URL out of the page context. The SDK stores the session in
  // localStorage under a `sb-<ref>-auth-token` key; the publishable key
  // is baked into the bundle as VITE_SUPABASE_PUBLISHABLE_KEY.
  const ctx = await page.evaluate(() => {
    // Find the sb-...-auth-token key
    const sbKey = Object.keys(localStorage).find(
      (k) => k.startsWith('sb-') && k.endsWith('-auth-token'),
    );
    if (!sbKey) return { error: 'no session token in localStorage' as const };
    const raw = localStorage.getItem(sbKey);
    if (!raw) return { error: 'session token empty' as const };
    const session = JSON.parse(raw) as SessionShape;
    // Pull the publishable key + URL from the bundle's env imports. They
    // live on the supabase client itself but we don't have a clean global
    // export; the SDK puts them on requests via headers. Simplest:
    // call a function that uses the global supabase client (`window.supabase`
    // is not exported by Vite; fall back to reading from the network).
    return {
      access_token: session.access_token,
      user_id: session.user.id,
    };
  });

  if ('error' in ctx) throw new Error(`failed to read session: ${ctx.error}`);
  expect(ctx.access_token.length, 'access_token').toBeGreaterThan(20);

  // OWB DEV REST URL + publishable key. Publishable keys are designed to
  // be public (every browser session sees them); only sb_secret_* is
  // sensitive. Pulled from the dev bundle on 2026-05-31.
  const SUPA_URL = process.env.OWB_E2E_SUPABASE_URL!;
  const PUBLISHABLE_KEY = process.env.OWB_E2E_SUPABASE_PUBLISHABLE_KEY!;

  // 1. Resolve the user's own org_id(s) via org_members.
  const myOrgsResp = await page.evaluate(
    async ({ url, key, token, userId }) => {
      const r = await fetch(`${url}/rest/v1/org_members?user_id=eq.${userId}&select=org_id`, {
        headers: { apikey: key, Authorization: `Bearer ${token}` },
      });
      const status = r.status;
      const body = await r.text();
      return { status, body };
    },
    { url: SUPA_URL, key: PUBLISHABLE_KEY, token: ctx.access_token, userId: ctx.user_id },
  );

  expect(myOrgsResp.status, `org_members query: ${myOrgsResp.body}`).toBe(200);
  const myOrgs: Array<{ org_id: string }> = JSON.parse(myOrgsResp.body);
  expect(myOrgs.length, 'user must belong to ≥1 org').toBeGreaterThan(0);
  const myOrgIds = new Set(myOrgs.map((r) => r.org_id));

  // 2. For each org-scoped table, fetch ALL rows the user can see, assert
  //    every row's org_id is in myOrgIds.
  const failures: Array<{ table: string; reason: string }> = [];

  for (const table of ORG_SCOPED_TABLES) {
    const resp = await page.evaluate(
      async ({ url, key, token, table }) => {
        const r = await fetch(`${url}/rest/v1/${table}?select=*`, {
          headers: { apikey: key, Authorization: `Bearer ${token}` },
        });
        return { status: r.status, body: await r.text() };
      },
      { url: SUPA_URL, key: PUBLISHABLE_KEY, token: ctx.access_token, table },
    );

    if (resp.status !== 200) {
      // Some tables (e.g. `organizations` queried directly without filter)
      // may legitimately 200/[] or 401 depending on policy. Treat 4xx as
      // a finding but don't fail the test on them — they prove the
      // server refused the broad query, which is what we want.
      if (resp.status === 401 || resp.status === 403) {
        // Hard-deny — fine.
        continue;
      }
      failures.push({
        table,
        reason: `unexpected status ${resp.status}: ${resp.body.slice(0, 120)}`,
      });
      continue;
    }

    const rows: Array<Record<string, unknown>> = JSON.parse(resp.body);
    for (const row of rows) {
      // `organizations` table has `id` instead of `org_id` for the org's
      // own row; check that the id is in myOrgIds.
      const id = (row.org_id as string | undefined) ?? (row.id as string | undefined);
      if (!id) {
        failures.push({
          table,
          reason: `row has no org_id or id: ${JSON.stringify(row).slice(0, 120)}`,
        });
        continue;
      }
      if (!myOrgIds.has(id)) {
        failures.push({
          table,
          reason: `row org_id=${id} is NOT in user's org set ${[...myOrgIds].join(',')}`,
        });
      }
    }
  }

  if (failures.length > 0) {
    const summary = failures.map((f) => `  ${f.table}: ${f.reason}`).join('\n');
    throw new Error(`RLS isolation failures (${failures.length}):\n${summary}`);
  }
});
