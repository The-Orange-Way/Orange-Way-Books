/**
 * S13 — Vite plugin that hardens the production CSP.
 *
 * The source `index.html` carries a CSP with `script-src 'unsafe-inline'`
 * because Vite's dev server injects HMR client scripts inline at runtime.
 * In production, the only inline scripts that ship are static content the
 * build itself emits (JSON-LD blocks, any plugin-emitted bootstrap snippets).
 *
 * This plugin runs at the end of the build pipeline. For every .html file
 * Vite emits, it:
 *   1. Finds every inline <script>...</script> block (any type — JSON-LD,
 *      vanilla module, etc. — since CSP's script-src gates all of them).
 *   2. Computes a SHA-256 hash of the EXACT inner contents, base64-encoded.
 *   3. Rewrites the CSP meta tag's `script-src` directive:
 *        - removes `'unsafe-inline'`
 *        - adds one `'sha256-<base64>'` token per unique inline script hash
 *
 * The hash format is what the CSP spec requires: the entire script body
 * (whitespace included) is hashed exactly. If a future plugin tweaks an
 * inline block, the hash regenerates automatically on the next build.
 *
 * Dev mode is untouched — `'unsafe-inline'` stays so Vite's HMR + tooling
 * keep working. `apply: 'build'` enforces that.
 */

import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

const INLINE_SCRIPT_RE = /<script\b(?![^>]*\bsrc\s*=)[^>]*>([\s\S]*?)<\/script>/gi;
const CSP_META_RE = /<meta\s+http-equiv\s*=\s*"Content-Security-Policy"[^>]*content\s*=\s*"([\s\S]*?)"\s*\/?>/i;
const SCRIPT_SRC_RE = /(script-src\s+)([^;]+)(;|$)/i;

function hashScript(body: string): string {
  const digest = createHash('sha256').update(body, 'utf8').digest('base64');
  return `'sha256-${digest}'`;
}

function harden(html: string): string {
  const inlineHashes = new Set<string>();
  let match: RegExpExecArray | null;
  INLINE_SCRIPT_RE.lastIndex = 0;
  while ((match = INLINE_SCRIPT_RE.exec(html)) !== null) {
    inlineHashes.add(hashScript(match[1]));
  }

  const cspMatch = html.match(CSP_META_RE);
  if (!cspMatch) return html;
  const cspContent = cspMatch[1];

  const scriptSrcMatch = cspContent.match(SCRIPT_SRC_RE);
  if (!scriptSrcMatch) return html;

  const sources = scriptSrcMatch[2]
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => s !== "'unsafe-inline'");

  for (const hash of inlineHashes) {
    if (!sources.includes(hash)) sources.push(hash);
  }

  const newScriptSrc = `${scriptSrcMatch[1]}${sources.join(' ')}${scriptSrcMatch[3]}`;
  const newCspContent = cspContent.replace(SCRIPT_SRC_RE, newScriptSrc);
  return html.replace(CSP_META_RE, (full) => full.replace(cspContent, newCspContent));
}

export default function cspHashPlugin(): Plugin {
  return {
    name: 'csp-hash-plugin',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        return harden(html);
      },
    },
  };
}
