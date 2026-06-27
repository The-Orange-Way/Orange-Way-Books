import type { Plugin } from 'vite';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ALL_PRERENDER_ROUTES, type PublicRouteMeta } from '../src/marketing/routes-meta';

/**
 * Build-time prerender plugin.
 *
 * Static hosting only runs `vite build` and serves the resulting
 * dist/ folder; it does not run a Node SSR step. Full DOM prerendering
 * (react-snap, vite-plugin-prerender) would need a Chromium binary at
 * build time, which isn't available in this environment.
 *
 * Instead we do a lightweight HTML-only prerender: after the SPA build
 * completes, copy dist/index.html for every public marketing route, then
 * inject route-specific <title>, <meta name="description">, canonical link,
 * page-specific JSON-LD, and a richer <noscript> body. The React bundle
 * still hydrates normally, so end users see no difference — but bots and
 * AI crawlers that don't execute JS now get the right content per route.
 *
 * Output layout (so the static host's directory-index fallback serves the
 * file at the matching URL without redirects):
 *   dist/index.html               (root, replaced)
 *   dist/features/index.html
 *   dist/security/index.html
 *   dist/compare/quickbooks/index.html
 *   ...
 */
export default function prerenderMarketingPlugin(): Plugin {
  return {
    name: 'prerender-marketing-routes',
    apply: 'build',
    enforce: 'post',
    async closeBundle() {
      // Vite build output is dist/ in this project (default).
      const distDir = path.resolve(process.cwd(), 'dist');
      const shellPath = path.join(distDir, 'index.html');

      let shell: string;
      try {
        shell = await fs.readFile(shellPath, 'utf8');
      } catch (err) {
        // If there's no built shell, the SPA build failed — bail silently
        // so we don't mask the real error.
        return;
      }

      for (const route of ALL_PRERENDER_ROUTES) {
        const html = renderRoute(shell, route);
        const outPath =
          route.path === '/'
            ? path.join(distDir, 'index.html')
            : path.join(distDir, route.path.replace(/^\//, ''), 'index.html');

        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, html, 'utf8');
      }

      // Generate sitemap.xml from the same route list, so the sitemap can
      // never drift from the routes we actually prerender. Hand-maintaining
      // a separate public/sitemap.xml is how the /compare/* pages ended up
      // listed there but absent from this list (and how lastmod went missing
      // entirely). One source of truth removes both failure modes.
      await fs.writeFile(path.join(distDir, 'sitemap.xml'), renderSitemap(), 'utf8');
    },
  };
}

const SITE_URL = 'https://books.orangeway.app';

/**
 * Per-path sitemap tuning. Routes absent from this map fall back to the
 * defaults below: a missing entry degrades gracefully rather than dropping
 * the URL, so adding a route to routes-meta.ts is enough to get it indexed.
 */
const SITEMAP_TUNING: Record<string, { changefreq: string; priority: string }> = {
  '/': { changefreq: 'weekly', priority: '1.0' },
  '/features': { changefreq: 'weekly', priority: '0.9' },
  '/security': { changefreq: 'monthly', priority: '0.9' },
  '/pricing': { changefreq: 'monthly', priority: '0.8' },
  '/faq': { changefreq: 'weekly', priority: '0.9' },
  '/about': { changefreq: 'monthly', priority: '0.6' },
  '/contact': { changefreq: 'monthly', priority: '0.5' },
  '/docs': { changefreq: 'weekly', priority: '0.7' },
  '/compare': { changefreq: 'weekly', priority: '0.8' },
  '/compare/quickbooks': { changefreq: 'monthly', priority: '0.8' },
  '/compare/xero': { changefreq: 'monthly', priority: '0.8' },
  '/compare/wave': { changefreq: 'monthly', priority: '0.7' },
  '/compare/freshbooks': { changefreq: 'monthly', priority: '0.7' },
  '/compare/bitwave': { changefreq: 'monthly', priority: '0.8' },
  '/compare/cryptio': { changefreq: 'monthly', priority: '0.8' },
  '/compare/spreadsheets': { changefreq: 'monthly', priority: '0.7' },
};

const SITEMAP_DEFAULT = { changefreq: 'monthly', priority: '0.5' };

/** Build the sitemap from ALL_PRERENDER_ROUTES. lastmod = build (deploy) date. */
function renderSitemap(): string {
  const lastmod = new Date().toISOString().slice(0, 10); // YYYY-MM-DD, UTC
  const urls = ALL_PRERENDER_ROUTES.map((route) => {
    const loc = `${SITE_URL}${route.path === '/' ? '/' : route.path}`;
    const { changefreq, priority } = SITEMAP_TUNING[route.path] ?? SITEMAP_DEFAULT;
    return `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Render a single route by mutating the built shell HTML. */
function renderRoute(shell: string, route: PublicRouteMeta): string {
  const SITE_URL = 'https://books.orangeway.app';
  const canonical = `${SITE_URL}${route.path === '/' ? '' : route.path}`;

  let html = shell;

  // <title>
  html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(route.title)}</title>`);

  // <meta name="description">
  html = html.replace(
    /<meta\s+name="description"\s+content="[^"]*"\s*\/?>/,
    `<meta name="description" content="${escapeHtml(route.description)}" />`,
  );

  // <link rel="canonical">
  if (/<link\s+rel="canonical"/.test(html)) {
    html = html.replace(
      /<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>/,
      `<link rel="canonical" href="${canonical}" />`,
    );
  } else {
    html = html.replace('</head>', `<link rel="canonical" href="${canonical}" />\n</head>`);
  }

  // OG / Twitter title + description (for social embed bots)
  html = html
    .replace(
      /<meta\s+property="og:title"\s+content="[^"]*">/,
      `<meta property="og:title" content="${escapeHtml(route.title)}">`,
    )
    .replace(
      /<meta\s+name="twitter:title"\s+content="[^"]*">/,
      `<meta name="twitter:title" content="${escapeHtml(route.title)}">`,
    )
    .replace(
      /<meta\s+property="og:description"\s+content="[^"]*">/,
      `<meta property="og:description" content="${escapeHtml(route.description)}">`,
    )
    .replace(
      /<meta\s+name="twitter:description"\s+content="[^"]*">/,
      `<meta name="twitter:description" content="${escapeHtml(route.description)}">`,
    );

  // Inject page-specific JSON-LD just before </head>. We keep the existing
  // sitewide Organization/WebSite/SoftwareApplication block intact.
  if (route.jsonLd && route.jsonLd.length > 0) {
    const blocks = route.jsonLd
      .map((obj) => `<script type="application/ld+json">\n${JSON.stringify(obj)}\n</script>`)
      .join('\n');
    html = html.replace('</head>', `${blocks}\n</head>`);
  }

  // Replace the <noscript> fallback inside #root with a route-specific one
  // so bots see a real H1 + paragraph for the actual page they fetched.
  const noscriptBody = `      <noscript>\n        <h1>${escapeHtml(route.h1)}</h1>\n        <p>${escapeHtml(
    route.summary,
  )}</p>\n        <p>Visit: <a href="/features">Features</a> · <a href="/security">Security</a> · <a href="/pricing">Pricing</a> · <a href="/faq">FAQ</a> · <a href="/compare">Compare</a> · <a href="/docs">Docs</a></p>\n      </noscript>`;
  html = html.replace(/<noscript>[\s\S]*?<\/noscript>/, noscriptBody);

  return html;
}
