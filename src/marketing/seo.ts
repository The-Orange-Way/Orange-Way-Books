/**
 * Sitewide SEO constants used by the marketing site.
 * Keep all canonical strings in one place so JSON-LD, OG tags, and
 * sitemap/llms.txt generators stay in sync.
 */

export const SITE_URL = 'https://books.orangeway.app';
export const SITE_NAME = 'Orange Way Books';
export const SITE_TAGLINE = 'Zero-Knowledge Bitcoin Accounting';
export const SITE_DESCRIPTION =
  'Orange Way Books is the open-source, zero-knowledge accounting platform built for Bitcoin businesses. Your books are encrypted on your device — the server cannot read them. Multi-currency, double-entry, IFRS/GAAP-ready.';

export const ORG_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: SITE_NAME,
  url: SITE_URL,
  logo: `${SITE_URL}/icon-512.png`,
  sameAs: ['https://github.com/The-Orange-Way/Orange-Way-Books'],
};

export const WEBSITE_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: SITE_NAME,
  url: SITE_URL,
  description: SITE_DESCRIPTION,
};

export const SOFTWARE_APP_JSON_LD = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: SITE_NAME,
  applicationCategory: 'BusinessApplication',
  applicationSubCategory: 'AccountingApplication',
  operatingSystem: 'Web',
  description: SITE_DESCRIPTION,
  url: SITE_URL,
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
    description: 'Free, open-source. Apache-2.0 licensed.',
  },
  featureList: [
    'Zero-knowledge end-to-end encryption',
    'Bitcoin-native multi-currency ledger',
    'Double-entry bookkeeping with a server-side ledger engine',
    'IFRS and US GAAP frameworks',
    'Multi-organization support',
    'Role-based access control',
    'CSV import/export',
    'OrangeRails Bitcoin connector',
    'Post-quantum signing keys',
    'Open source (Apache-2.0)',
  ],
};

/**
 * Build a BreadcrumbList JSON-LD object from an ordered list of
 * { name, path } items. The first item is the site root.
 */
export function breadcrumbJsonLd(items: ReadonlyArray<{ name: string; path: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: item.name,
      item: `${SITE_URL}${item.path}`,
    })),
  };
}

/**
 * Build a FAQPage JSON-LD object from an ordered list of { q, a } items.
 */
export function faqJsonLd(items: ReadonlyArray<{ q: string; a: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.a,
      },
    })),
  };
}
