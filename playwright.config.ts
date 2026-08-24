import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright smoke tests.
 *
 * Target is required: PLAYWRIGHT_BASE_URL=<url> npx playwright test
 * There is no default. CI serves the PR build and sets this; an unset
 * value fails fast so a run can never silently test the deployed site.
 *
 * Tests live in tests/e2e/. They are intentionally shallow — page loads,
 * no console errors, key routes return 200. Deeper integration tests
 * land alongside the features they test.
 */
const baseURL = process.env.PLAYWRIGHT_BASE_URL;
if (!baseURL) {
  throw new Error(
    'PLAYWRIGHT_BASE_URL must be set to the target under test. Refusing to default: ' +
      'a default would silently test the deployed site instead of the code under review.',
  );
}

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30 * 1000,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [
        ['github'],
        ['html', { open: 'never' }],
        ['json', { outputFile: 'playwright-report/results.json' }],
        ['list'],
      ]
    : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
