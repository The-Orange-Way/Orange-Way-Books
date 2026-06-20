import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';
import prerenderMarketingPlugin from './scripts/prerender-plugin';
import cspHashPlugin from './scripts/csp-hash-plugin';

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
    // only — dev keeps 'unsafe-inline' so Vite HMR injection works.
    mode !== 'development' && cspHashPlugin(),
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
