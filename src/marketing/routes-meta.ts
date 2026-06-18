/**
 * Single source of truth for the public marketing routes.
 *
 * Used at BUILD TIME by the prerender Vite plugin to emit one static
 * `index.html` per route with route-specific <title>, <meta description>,
 * <link rel="canonical">, an AI-readable <noscript> body fallback, and
 * route-specific JSON-LD. Bots that don't execute JS get the right
 * content; React still hydrates normally for real users.
 *
 * To add a new public route:
 *   1. Add it to PUBLIC_ROUTES below.
 *   2. Add it to public/sitemap.xml (or regenerate that file from this list).
 *   3. Wire the route in src/App.tsx as usual.
 */

export interface PublicRouteMeta {
  /** Path without trailing slash. Use "/" for the landing page. */
  path: string;
  /** <title>. Keep under 60 chars where possible. */
  title: string;
  /** <meta name="description">. Keep under 160 chars. */
  description: string;
  /** <h1> shown in the <noscript> fallback (and used by AI crawlers). */
  h1: string;
  /** Plain-text body for the <noscript> fallback. */
  summary: string;
  /** Optional extra JSON-LD blocks specific to this route. */
  jsonLd?: Array<Record<string, unknown>>;
}

const SITE_URL = 'https://books.orangeway.app';

function breadcrumb(items: Array<{ name: string; path: string }>) {
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

const FAQ_ITEMS: Array<{ q: string; a: string }> = [
  {
    q: 'What is Orange Way Books?',
    a: 'Orange Way Books is an open-source, zero-knowledge, double-entry accounting platform for Bitcoin businesses. Books are encrypted on your device with Argon2id + AES-GCM before being uploaded; the server stores only ciphertext.',
  },
  {
    q: 'How is Orange Way Books different from QuickBooks or Xero?',
    a: 'QuickBooks and Xero store your books in plaintext and are not Bitcoin-native. Orange Way Books is zero-knowledge (the vendor mathematically cannot read your books) and treats sats and BTC as first-class currencies with per-transaction historical exchange-rate snapshots.',
  },
  {
    q: 'How is Orange Way Books different from Bitwave or Cryptio?',
    a: 'Bitwave and Cryptio are crypto sub-ledgers that sync into QuickBooks or NetSuite as the general ledger. Orange Way Books is a complete double-entry GL on its own — and unlike those products, the vendor cannot read your data.',
  },
  {
    q: 'Is Orange Way Books free?',
    a: 'Yes. Orange Way Books is free for individuals, free to self-host, and licensed under Apache-2.0. A paid team tier is on the roadmap.',
  },
  {
    q: 'Can Orange Way Books really not read my books?',
    a: 'Correct. Your vault password derives a key on your device using Argon2id; that key encrypts every sensitive field with AES-GCM before upload. The server only ever sees ciphertext.',
  },
  {
    q: 'Does Orange Way Books support IFRS and US GAAP?',
    a: 'Yes. Both IFRS and US GAAP frameworks are supported and can be selected per organization.',
  },
  {
    q: 'Can I self-host Orange Way Books?',
    a: 'Yes. The entire stack is open source under Apache-2.0 and can be self-hosted on your own infrastructure.',
  },
];

export const PUBLIC_ROUTES: PublicRouteMeta[] = [
  {
    path: '/',
    title: 'Orange Way Books — Zero-Knowledge Bitcoin Accounting',
    description:
      'Open-source, zero-knowledge accounting for Bitcoin businesses. Encrypted on your device. Double-entry. IFRS & GAAP. Free.',
    h1: 'Orange Way Books — Zero-Knowledge Bitcoin Accounting',
    summary:
      "Orange Way Books is the open-source, zero-knowledge accounting platform built for Bitcoin businesses. Your books are encrypted on your device with a vault password before being uploaded; the server stores only ciphertext. Apache-2.0 licensed. Multi-currency BTC and fiat with historical exchange rates. Real server-side double-entry ledger. IFRS and US GAAP. Capability-based RBAC. ML-DSA-65 post-quantum signing keys. Full data takeout. Self-hostable.",
    jsonLd: [breadcrumb([{ name: 'Home', path: '/' }])],
  },
  {
    path: '/features',
    title: 'Features — Orange Way Books',
    description:
      'Zero-knowledge encryption, Bitcoin-native multi-currency ledger, double-entry, IFRS/GAAP, RBAC, post-quantum signing, full data takeout.',
    h1: 'Orange Way Books Features',
    summary:
      'Argon2id key derivation, AES-GCM field encryption, ML-DSA-65 post-quantum signing keys, a server-side double-entry ledger, sats/BTC/fiat with per-transaction historical FX, IFRS and US GAAP frameworks, capability-based RBAC with time-boxed roles, auditor support sessions, hard rekey workflow, full encrypted or plaintext takeout export, CSV import/export, OrangeRails Bitcoin connector, multi-organization with envelope encryption.',
    jsonLd: [
      breadcrumb([
        { name: 'Home', path: '/' },
        { name: 'Features', path: '/features' },
      ]),
    ],
  },
  {
    path: '/security',
    title: 'Security & Zero-Knowledge Architecture — Orange Way Books',
    description:
      'How Orange Way Books makes it cryptographically impossible for the vendor to read your books: Argon2id, AES-GCM, ML-DSA-65, envelope encryption.',
    h1: 'Security & Zero-Knowledge Architecture',
    summary:
      "Orange Way Books uses Argon2id (memory-hard) for key derivation, AES-GCM for authenticated field encryption, and per-organization envelope encryption so each member's wrapped DEK is never visible to anyone else. ML-DSA-65 post-quantum signing keys protect organization-level signatures. Wrong vault password cannot decrypt — there is no server-side hash check. Key rotation (rekey) rotates DEK and signing-key versions across all rows with rollback. The server only ever sees ciphertext.",
    jsonLd: [
      breadcrumb([
        { name: 'Home', path: '/' },
        { name: 'Security', path: '/security' },
      ]),
    ],
  },
  {
    path: '/pricing',
    title: 'Pricing — Orange Way Books',
    description:
      'Free for individuals. Free to self-host. Apache-2.0 licensed. Paid team tier on roadmap.',
    h1: 'Pricing',
    summary:
      'Orange Way Books is free for individuals and free to self-host under Apache-2.0. A paid team tier with collaboration features is on the roadmap. There is no usage cap, no transaction limit, and no vendor lock-in — full data takeout is included.',
    jsonLd: [
      breadcrumb([
        { name: 'Home', path: '/' },
        { name: 'Pricing', path: '/pricing' },
      ]),
    ],
  },
  {
    path: '/faq',
    title: 'FAQ — Orange Way Books',
    description:
      'Answers about zero-knowledge encryption, Bitcoin-native accounting, IFRS/GAAP, self-hosting, comparisons to QuickBooks, Xero, Bitwave, and Cryptio.',
    h1: 'Frequently Asked Questions',
    summary: FAQ_ITEMS.map((item) => `Q: ${item.q}\nA: ${item.a}`).join('\n\n'),
    jsonLd: [
      breadcrumb([
        { name: 'Home', path: '/' },
        { name: 'FAQ', path: '/faq' },
      ]),
      {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: FAQ_ITEMS.map((item) => ({
          '@type': 'Question',
          name: item.q,
          acceptedAnswer: { '@type': 'Answer', text: item.a },
        })),
      },
    ],
  },
  {
    path: '/about',
    title: 'About — Orange Way Books',
    description:
      'Why Orange Way Books exists: Bitcoin businesses cannot accept a vendor reading their books in the clear.',
    h1: 'About Orange Way Books',
    summary:
      'Orange Way Books was built because Bitcoin businesses — treasuries, miners, custodians, OTC desks, funds — cannot accept a SaaS vendor reading their financials in plaintext. It is open source under Apache-2.0 and designed to be self-hosted by anyone who wants full sovereignty over their books.',
    jsonLd: [
      breadcrumb([
        { name: 'Home', path: '/' },
        { name: 'About', path: '/about' },
      ]),
    ],
  },
  {
    path: '/contact',
    title: 'Contact — Orange Way Books',
    description:
      'Get in touch with the Orange Way Books team. Open-source project — issues and PRs welcome on GitHub.',
    h1: 'Contact',
    summary:
      'Orange Way Books is an open-source project. Issues, feature requests, and pull requests are welcome on GitHub at https://github.com/The-Orange-Way/Orange-Way-Books.',
    jsonLd: [
      breadcrumb([
        { name: 'Home', path: '/' },
        { name: 'Contact', path: '/contact' },
      ]),
    ],
  },
  {
    path: '/compare',
    title: 'Compare Orange Way Books — vs QuickBooks, Xero, Bitwave, Cryptio',
    description:
      'Side-by-side comparisons of Orange Way Books vs the leading SMB and crypto accounting tools.',
    h1: 'Compare Orange Way Books',
    summary:
      'Side-by-side comparisons of Orange Way Books versus QuickBooks, Xero, Wave, FreshBooks, Bitwave, Cryptio, and spreadsheets across zero-knowledge encryption, Bitcoin-native support, double-entry posture, IFRS/GAAP, open-source license, self-hosting, and pricing.',
    jsonLd: [
      breadcrumb([
        { name: 'Home', path: '/' },
        { name: 'Compare', path: '/compare' },
      ]),
    ],
  },
  {
    path: '/docs',
    title: 'Docs — Orange Way Books',
    description:
      'Curated documentation: architecture, data flow, zero-knowledge guide, multi-currency brain, ops guide, roadmap.',
    h1: 'Documentation',
    summary:
      'Curated docs covering Orange Way Books architecture, data flow, the zero-knowledge architecture guide, multi-currency brain, operations guide, roadmap, and competitive analysis.',
    jsonLd: [
      breadcrumb([
        { name: 'Home', path: '/' },
        { name: 'Docs', path: '/docs' },
      ]),
    ],
  },
];

/**
 * Per-competitor compare-page metadata. These slugs must match the
 * COMPETITORS object keys in src/marketing/pages/CompareStub.tsx.
 */
export const COMPARE_ROUTES: PublicRouteMeta[] = (
  [
    { slug: 'quickbooks', name: 'QuickBooks' },
    { slug: 'xero', name: 'Xero' },
    { slug: 'wave', name: 'Wave' },
    { slug: 'freshbooks', name: 'FreshBooks' },
    { slug: 'bitwave', name: 'Bitwave' },
    { slug: 'cryptio', name: 'Cryptio' },
    { slug: 'spreadsheets', name: 'Spreadsheets' },
  ] as const
).map(({ slug, name }) => ({
  path: `/compare/${slug}`,
  title: `Orange Way Books vs ${name}`,
  description: `${name} vs Orange Way Books: compare zero-knowledge encryption, Bitcoin support, double-entry, IFRS/GAAP, open-source, self-hosting, and pricing.`,
  h1: `Orange Way Books vs ${name}`,
  summary: `Orange Way Books is the zero-knowledge, Bitcoin-native, open-source alternative to ${name} for businesses that need real double-entry accounting without handing plaintext financials to a vendor. The server cannot read your books — encryption happens on your device with Argon2id and AES-GCM.`,
  jsonLd: [
    breadcrumb([
      { name: 'Home', path: '/' },
      { name: 'Compare', path: '/compare' },
      { name: `vs ${name}`, path: `/compare/${slug}` },
    ]),
    {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: 'Orange Way Books',
      description:
        'Open-source, zero-knowledge, double-entry accounting for Bitcoin businesses.',
      brand: { '@type': 'Brand', name: 'Orange Way Books' },
      url: SITE_URL,
      review: {
        '@type': 'Review',
        name: `Orange Way Books vs ${name}`,
        reviewBody: `Orange Way Books is a zero-knowledge, Bitcoin-native, open-source alternative to ${name}.`,
        author: { '@type': 'Organization', name: 'Orange Way Books' },
        itemReviewed: {
          '@type': 'SoftwareApplication',
          name,
          applicationCategory: 'AccountingApplication',
        },
      },
    },
  ],
}));

export const ALL_PRERENDER_ROUTES: PublicRouteMeta[] = [
  ...PUBLIC_ROUTES,
  ...COMPARE_ROUTES,
];