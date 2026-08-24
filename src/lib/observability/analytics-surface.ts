/**
 * Which routes analytics is allowed to run on.
 *
 * Orange Way Books ships the marketing site and the authenticated app from one
 * SPA, so "marketing-site analytics" is a claim about routes, not about
 * hostnames. This module is the only place that claim is encoded.
 *
 * Default deny: a path is non-marketing unless it is listed here. Adding a
 * new app screen therefore requires no analytics change, and forgetting to
 * update this file makes the new screen silent rather than tracked.
 */

// PRIVACY DECISION, NOT ROUTING CONFIG. This set is the code-side encoding
// of the privacy policy's claim that analytics runs on the public marketing
// site only. Adding a path here widens what we collect from real users, so
// a change to this list needs a privacy review, not just a code review.
// Matching is exact after trailing-slash normalisation, deliberately not a
// prefix match: "/security" is marketing, "/settings/security" is not.
// Exception: "/compare/:slug" compare pages are matched by prefix below.
const MARKETING_PATHS = new Set([
  '/',
  '/about',
  '/ai',
  '/compare',
  '/contact',
  '/docs',
  '/faq',
  '/features',
  '/pricing',
  '/privacy',
  '/privacy-changelog',
  '/security',
  '/terms',
]);

/** Normalise a pathname so "/features/" and "/features" compare equal. */
function normalise(pathname: string): string {
  if (!pathname) return '/';
  const trimmed = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return trimmed === '' ? '/' : trimmed;
}

/**
 * True only for public marketing pages. Every authenticated app surface,
 * every auth screen, every public-invoice link, and every unrecognised
 * path returns false.
 *
 * Exact match is intentional for all fixed paths. "/compare/:slug" compare
 * sub-pages are the one exception handled by prefix match below.
 */
export function isMarketingPath(pathname: string): boolean {
  const p = normalise(pathname);
  if (MARKETING_PATHS.has(p)) return true;
  // /compare/:slug pages are marketing (product comparison stubs).
  if (p.startsWith('/compare/')) return true;
  return false;
}

/** Exported for tests only: the exact set the gate reads. */
export const MARKETING_PATHS_FOR_TEST: ReadonlySet<string> = MARKETING_PATHS;
