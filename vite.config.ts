import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import prerenderMarketingPlugin from './scripts/prerender-plugin';
import cspHashPlugin from './scripts/csp-hash-plugin';
import thirdPartyLicensesPlugin from './scripts/third-party-licenses-plugin';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  server: {
    host: '::',
    port: 8080,
    hmr: {
      overlay: false,
    },
  },
  plugins: [
    react(),
    // Emit per-route static HTML after the SPA build so AI crawlers
    // and search bots see route-specific <title>, <meta description>,
    // canonical URL, JSON-LD, and a real <noscript> body even without
    // executing JavaScript. See scripts/prerender-plugin.ts.
    mode !== 'development' && prerenderMarketingPlugin(),
    // Rewrites the CSP meta tag in every emitted .html to add sha256
    // hashes for each inline <script> and drop 'unsafe-inline'. Build
    // only: dev keeps 'unsafe-inline' so Vite HMR injection works.
    mode !== 'development' && cspHashPlugin(),
    // Emit dist/third-party-licenses.txt with the full machine-enumerated
    // attribution surface required by Apache 2.0 §4(d). Complements the
    // curated NOTICE file at the repo root. Build-only; dev mode does not
    // touch the dependency graph.
    mode !== 'development' && thirdPartyLicensesPlugin(),
  ].filter(Boolean),
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
    dedupe: [
      'react',
      'react-dom',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      '@tanstack/react-query',
      '@tanstack/query-core',
    ],
  },
}));
