/**
 * Playwright global setup — verifies the local stack is up before any
 * test runs. We intentionally do NOT auto-start Supabase or the mock
 * Flash server: `supabase start` takes 30-60s and can wedge mid-run,
 * and the mock needs env vars the user controls. Fail fast with a clear
 * message instead.
 *
 * Three services must be live:
 *   1. Supabase local on http://localhost:54321 (start with `supabase start`)
 *   2. Mock Flash server on http://localhost:8787
 *      (`deno run --allow-net --allow-env scripts/mock-flash/server.ts`)
 *   3. Vite dev server on http://localhost:8080 (`npm run dev`)
 *
 * See tests/e2e/README.md for the full pre-flight checklist.
 */

import type { FullConfig } from '@playwright/test';

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://localhost:54321';
const MOCK_FLASH_URL = process.env.MOCK_FLASH_URL ?? 'http://localhost:8787';
const VAULT_URL = process.env.VAULT_BASE_URL ?? 'http://localhost:8080';

async function probe(url: string, label: string, hint: string): Promise<void> {
  try {
    const res = await fetch(url, { method: 'GET' });
    // We don't care about status — only that something is listening and
    // it didn't fail at the network layer.
    if (res.status >= 500) {
      throw new Error(`${label} responded ${res.status}`);
    }
  } catch (err) {
    throw new Error(
      `\n\n[playwright global-setup] ${label} is not reachable at ${url}.\n` +
        `  Fix: ${hint}\n` +
        `  Underlying error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  // Probe in parallel so the user sees ALL missing services at once,
  // not one-by-one.
  const results = await Promise.allSettled([
    probe(
      `${SUPABASE_URL}/auth/v1/health`,
      'Supabase local',
      'run `supabase start` in another terminal',
    ),
    probe(
      MOCK_FLASH_URL,
      'Mock Flash server',
      'run `deno run --allow-net --allow-env scripts/mock-flash/server.ts` (see scripts/mock-flash/README.md)',
    ),
    probe(VAULT_URL, 'Vault dev server', 'run `npm run dev` in another terminal'),
  ]);

  const failures = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));

  if (failures.length > 0) {
    throw new Error(
      `\n${failures.join('\n')}\n` + `See tests/e2e/README.md for the full setup checklist.\n`,
    );
  }

  // eslint-disable-next-line no-console
  console.log('[playwright global-setup] all three services are reachable.');
}
