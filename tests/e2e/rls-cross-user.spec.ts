/**
 * RLS cross-user smoke — user A cannot see user B's org data.
 *
 * Companion to the single-user RLS isolation spec. This is the real
 * cross-tenant test: it creates a fresh user B with their own org, signs
 * in as user A (the existing e2e user), and asserts that A can't read B's
 * org via any common attack surface (broad SELECT, filtered SELECT by
 * B's org_id, org_members lookup for B's user_id, etc.).
 *
 * Setup uses the service-role REST API to create user B + their org +
 * org_members row directly. We deliberately do NOT walk B through UI
 * onboarding — that would take 30s and add brittleness. We just need B
 * to exist with a known org_id so we can attempt to read it as user A.
 *
 * Cleanup: deletes user B + their org at the end. Idempotent on re-runs.
 *
 * Read-only from A's perspective. Writes only to admin-side tables to
 * create the B fixture.
 */

import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import https from 'node:https';
import { signIn, unlockVaultIfNeeded } from './lib/auth';

interface SupaCreds {
  url: string;
  secret: string;
}

function readSupaCreds(): SupaCreds | null {
  try {
    return JSON.parse(fs.readFileSync('/tmp/owb-pw/owb-dev-supabase.json', 'utf8'));
  } catch {
    // No local creds file (the normal case in CI and on a laptop that has
    // never run the provision script). Fall back to the same env vars the
    // "Run Playwright" CI step already sets from the dev environment scope,
    // so this spec can run without ever writing the DEV service-role key
    // to disk. The file path above stays as a laptop convenience only.
    const url = process.env.OWB_E2E_SUPABASE_URL;
    const secret = process.env.OWB_E2E_SUPABASE_SECRET_KEY;
    if (url && secret) return { url, secret };
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
          Prefer: 'return=representation',
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

const USER_B_EMAIL = 'e2e-bob@orangewaybooks.test';
const USER_B_PASSWORD = 'OwbE2EBob-2026!CrossTenant';
const ALLOWED_PROJECT_REFS = new Set(
  (process.env.OWB_E2E_ALLOWED_PROJECT_REFS ?? '').split(',').filter(Boolean),
);
const SUPA_URL = process.env.OWB_E2E_SUPABASE_URL!;
const PUBLISHABLE_KEY = process.env.OWB_E2E_SUPABASE_PUBLISHABLE_KEY!;

// Skip when no Supabase admin creds are available at all: neither the
// laptop convenience file nor the OWB_E2E_SUPABASE_URL /
// OWB_E2E_SUPABASE_SECRET_KEY env vars. CI sets those env vars from the
// dev environment scope on every push and same-repo PR run, so this spec
// executes there; a fork PR or a laptop with neither still skips cleanly.
const HAVE_LOCAL_CREDS = (() => {
  try {
    return !!readSupaCreds();
  } catch {
    return false;
  }
})();
test.skip(
  !HAVE_LOCAL_CREDS,
  'no Supabase admin creds available (no /tmp/owb-pw/owb-dev-supabase.json and no OWB_E2E_SUPABASE_URL/SECRET_KEY env vars) — cross-user spec skipped',
);

test.describe.serial('RLS cross-user — user A cannot see user B', () => {
  let supa: SupaCreds;
  let userBId = '';
  let userBOrgId = '';

  test.beforeAll(async () => {
    const c = readSupaCreds();
    if (!c) throw new Error('cannot read /tmp/owb-pw/owb-dev-supabase.json');
    supa = c;
    const ref = new URL(supa.url).hostname.split('.')[0];
    if (!ALLOWED_PROJECT_REFS.has(ref)) throw new Error(`refusing project ref "${ref}" — DEV only`);

    // 1. Create user B (idempotent: 422 if already exists)
    const cr = await adminFetch(supa.url, supa.secret, '/auth/v1/admin/users', 'POST', {
      email: USER_B_EMAIL,
      password: USER_B_PASSWORD,
      email_confirm: true,
    });
    if (cr.status === 200 || cr.status === 201) {
      userBId = JSON.parse(cr.body).id;
    } else if (cr.status === 422) {
      // Already exists — look up
      const q = await adminFetch(
        supa.url,
        supa.secret,
        `/auth/v1/admin/users?email=${encodeURIComponent(USER_B_EMAIL)}`,
        'GET',
      );
      userBId = JSON.parse(q.body).users[0].id;
    } else {
      throw new Error(`admin user-create user B: HTTP ${cr.status} ${cr.body}`);
    }

    // 2. Clean any existing org for B (so we start fresh)
    const memQ = await adminFetch(
      supa.url,
      supa.secret,
      `/rest/v1/org_members?user_id=eq.${userBId}&select=org_id`,
      'GET',
    );
    const mems: Array<{ org_id: string }> = JSON.parse(memQ.body);
    for (const m of mems) {
      await adminFetch(supa.url, supa.secret, `/rest/v1/organizations?id=eq.${m.org_id}`, 'DELETE');
    }

    // 3. Insert org for B + org_members row. Use service role so RLS doesn't get in the way.
    // organizations.name holds the encrypted ciphertext as text (the JS layer
    // encrypts before insert). For cross-tenant ISOLATION testing we don't care
    // what the value decrypts to — user A shouldn't even see this row exists.
    const orgIns = await adminFetch(supa.url, supa.secret, '/rest/v1/organizations', 'POST', {
      name: 'cipher-placeholder-for-user-B-org',
      key_version: 2,
    });
    if (orgIns.status >= 400) {
      throw new Error(`user-B org insert: HTTP ${orgIns.status} ${orgIns.body}`);
    }
    userBOrgId = JSON.parse(orgIns.body)[0].id;

    const mIns = await adminFetch(supa.url, supa.secret, '/rest/v1/org_members', 'POST', {
      user_id: userBId,
      org_id: userBOrgId,
      role: 'OWNER',
    });
    if (mIns.status >= 400) {
      throw new Error(`user-B org_members insert: HTTP ${mIns.status} ${mIns.body}`);
    }

    if (!userBOrgId) throw new Error('userBOrgId empty after insert');
  });

  test.afterAll(async () => {
    if (userBOrgId) {
      await adminFetch(
        supa.url,
        supa.secret,
        `/rest/v1/organizations?id=eq.${userBOrgId}`,
        'DELETE',
      ).catch(() => undefined);
    }
    // Leave the auth.users row in place for idempotent re-runs.
  });

  test('user A cannot read user B via any cross-tenant query path', async ({ page }) => {
    test.setTimeout(60_000);

    // Sign in as user A (the existing e2e user).
    await signIn(page);
    await page.goto('/app', { waitUntil: 'networkidle' });
    await unlockVaultIfNeeded(page);
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
    await expect(page.getByTestId('app-shell').first()).toBeVisible({ timeout: 15_000 });

    // Pull A's session token.
    const ctx = await page.evaluate(() => {
      const sbKey = Object.keys(localStorage).find(
        (k) => k.startsWith('sb-') && k.endsWith('-auth-token'),
      );
      if (!sbKey) return { error: 'no session' as const };
      const session = JSON.parse(localStorage.getItem(sbKey)!);
      return { access_token: session.access_token as string, user_id: session.user.id as string };
    });
    if ('error' in ctx) throw new Error(ctx.error);

    const callerFetch = async (path: string): Promise<{ status: number; body: string }> => {
      return page.evaluate(
        async ({ url, key, token, p }) => {
          const r = await fetch(`${url}${p}`, {
            headers: { apikey: key, Authorization: `Bearer ${token}` },
          });
          return { status: r.status, body: await r.text() };
        },
        { url: SUPA_URL, key: PUBLISHABLE_KEY, token: ctx.access_token, p: path },
      );
    };

    // ── Attack 1: broad SELECT on organizations — must not include B's org.
    const orgs = await callerFetch('/rest/v1/organizations?select=id');
    expect(orgs.status, `organizations SELECT: ${orgs.body}`).toBe(200);
    const orgRows: Array<{ id: string }> = JSON.parse(orgs.body);
    const sawB = orgRows.some((r) => r.id === userBOrgId);
    expect(
      sawB,
      `user A must NOT see user B's org ${userBOrgId} in broad SELECT — actually got ${orgRows.length} rows`,
    ).toBe(false);

    // ── Attack 2: filtered SELECT by B's org_id — must return 0 rows.
    const filt = await callerFetch(`/rest/v1/organizations?id=eq.${userBOrgId}&select=*`);
    expect(filt.status, `filtered SELECT: ${filt.body}`).toBe(200);
    const filtRows: unknown[] = JSON.parse(filt.body);
    expect(filtRows.length, `user A must get 0 rows when filtering to B's org_id`).toBe(0);

    // ── Attack 3: org_members lookup for B's user_id — must return 0 rows.
    const memLookup = await callerFetch(`/rest/v1/org_members?user_id=eq.${userBId}&select=*`);
    expect(memLookup.status, `org_members lookup: ${memLookup.body}`).toBe(200);
    const memRows: unknown[] = JSON.parse(memLookup.body);
    expect(memRows.length, `user A must get 0 rows when querying org_members for B's user_id`).toBe(
      0,
    );

    // ── Attack 4: every other org-scoped table filtered by B's org_id — must return 0 rows.
    // journal_entry_lines + transaction_lines etc. don't carry org_id directly
    // (they FK to a parent that does). The parent table coverage above
    // already proves user A can't see B's journal_entries; lines are RLS'd
    // transitively via the parent.
    for (const table of [
      'chart_of_accounts',
      'wallets',
      'journal_entries',
      'contacts',
      'org_settings',
      'invoices',
    ]) {
      const r = await callerFetch(`/rest/v1/${table}?org_id=eq.${userBOrgId}&select=*&limit=10`);
      // 200 with [] is the success case (RLS filtered it). 401/403 also fine (hard deny).
      if (r.status === 200) {
        const rows: unknown[] = JSON.parse(r.body);
        expect(rows.length, `user A must get 0 rows from ${table} filtered by B's org_id`).toBe(0);
      } else if (r.status === 401 || r.status === 403) {
        // Hard deny — fine
      } else {
        throw new Error(`${table} unexpected status ${r.status}: ${r.body.slice(0, 120)}`);
      }
    }
  });
});
