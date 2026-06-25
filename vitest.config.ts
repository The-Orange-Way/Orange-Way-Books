import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'tests/**/*.{test,spec}.{ts,tsx}'],
    // E2E specs are Playwright-only; vitest's loader chokes on their
    // top-level test.afterAll() because they run under a different
    // harness. Playwright is invoked via `bun run test:e2e`, not
    // `bun run test`.
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  },
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
});
