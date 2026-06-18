import { Link, useParams } from 'react-router-dom';
import { Seo } from '../Seo';
import { breadcrumbJsonLd, SITE_URL } from '../seo';

interface CompetitorProfile {
  name: string;
  category: string;
  bitcoinSupport: string;
  zkEncryption: string;
  doubleEntry: string;
  ifrsGaap: string;
  openSource: string;
  selfHostable: string;
  pricing: string;
  vendorReadsBooks: string;
  bestFor: string;
  whenToPickThem: string;
  url?: string;
}

const COMPETITORS: Record<string, CompetitorProfile> = {
  quickbooks: {
    name: 'QuickBooks',
    category: 'General-purpose SMB accounting',
    bitcoinSupport: 'Limited — no native sats, no historical-rate snapshots per tx',
    zkEncryption: 'No — Intuit stores plaintext',
    doubleEntry: 'Yes',
    ifrsGaap: 'US GAAP focus; IFRS via add-ons',
    openSource: 'No — proprietary',
    selfHostable: 'No — SaaS only (Desktop is being sunset)',
    pricing: 'Paid SaaS, ~$30–$200/mo per company',
    vendorReadsBooks: 'Yes — Intuit can read all data',
    bestFor: 'Traditional SMBs with no Bitcoin exposure who need deep accountant-network integration.',
    whenToPickThem: 'You have no Bitcoin activity, your accountant requires QuickBooks-format files, and ecosystem integrations matter more than data privacy.',
    url: 'https://quickbooks.intuit.com',
  },
  xero: {
    name: 'Xero',
    category: 'General-purpose SMB accounting',
    bitcoinSupport: 'Limited — multi-currency exists but not Bitcoin-native (no sats display, no per-tx rate snapshots)',
    zkEncryption: 'No — plaintext on Xero servers',
    doubleEntry: 'Yes',
    ifrsGaap: 'IFRS-friendly; GAAP via configuration',
    openSource: 'No — proprietary',
    selfHostable: 'No — SaaS only',
    pricing: 'Paid SaaS, ~$15–$78/mo per org',
    vendorReadsBooks: 'Yes — Xero can read all data',
    bestFor: 'International SMBs that prioritize ease of use and bank-feed integrations.',
    whenToPickThem: 'You operate in fiat only and want a polished, well-integrated SaaS with strong bank feeds.',
    url: 'https://xero.com',
  },
  wave: {
    name: 'Wave',
    category: 'Free SMB accounting',
    bitcoinSupport: 'None',
    zkEncryption: 'No — plaintext',
    doubleEntry: 'Yes (basic)',
    ifrsGaap: 'Limited — US/Canadian focus',
    openSource: 'No — proprietary',
    selfHostable: 'No',
    pricing: 'Free core; paid for payments/payroll',
    vendorReadsBooks: 'Yes',
    bestFor: 'Freelancers and very small fiat-only businesses on a budget.',
    whenToPickThem: 'You need basic invoicing and books for a fiat-only freelance business and price is the only constraint.',
    url: 'https://waveapps.com',
  },
  freshbooks: {
    name: 'FreshBooks',
    category: 'Invoicing-first SMB accounting',
    bitcoinSupport: 'None',
    zkEncryption: 'No — plaintext',
    doubleEntry: 'Yes (added later; invoicing remains the focus)',
    ifrsGaap: 'US/Canada/UK focus',
    openSource: 'No — proprietary',
    selfHostable: 'No',
    pricing: 'Paid SaaS, ~$19–$60/mo per org',
    vendorReadsBooks: 'Yes',
    bestFor: 'Service businesses whose primary need is invoicing & time tracking.',
    whenToPickThem: 'Your business is service-based, invoicing is the priority, and you have no Bitcoin exposure.',
    url: 'https://freshbooks.com',
  },
  bitwave: {
    name: 'Bitwave',
    category: 'Crypto sub-ledger',
    bitcoinSupport: 'Yes — multi-chain crypto sub-ledger',
    zkEncryption: 'No — vendor reads everything',
    doubleEntry: 'Sub-ledger only — relies on QuickBooks/NetSuite as the GL',
    ifrsGaap: 'Yes',
    openSource: 'No — proprietary',
    selfHostable: 'No',
    pricing: 'Enterprise SaaS — contact sales',
    vendorReadsBooks: 'Yes',
    bestFor: 'Crypto-active enterprises already committed to QuickBooks or NetSuite as their GL.',
    whenToPickThem: 'You need a managed crypto sub-ledger that integrates with QuickBooks/NetSuite, you have budget for enterprise SaaS, and zero-knowledge is not a requirement.',
    url: 'https://bitwave.io',
  },
  cryptio: {
    name: 'Cryptio',
    category: 'Crypto back-office accounting',
    bitcoinSupport: 'Yes — broad crypto coverage',
    zkEncryption: 'No — vendor reads everything',
    doubleEntry: 'Sub-ledger; integrates with mainstream GLs',
    ifrsGaap: 'Yes',
    openSource: 'No — proprietary',
    selfHostable: 'No',
    pricing: 'Enterprise SaaS — contact sales',
    vendorReadsBooks: 'Yes',
    bestFor: 'Crypto enterprises wanting a managed back-office tool with vendor support.',
    whenToPickThem: 'You want a managed crypto back-office with a vendor SLA and you do not need self-hosting or zero-knowledge.',
    url: 'https://cryptio.co',
  },
  spreadsheets: {
    name: 'Spreadsheets',
    category: 'DIY (Excel / Google Sheets)',
    bitcoinSupport: 'Whatever you build manually',
    zkEncryption: 'Only if you encrypt the file yourself',
    doubleEntry: 'Manual — error-prone, no enforcement',
    ifrsGaap: 'Manual',
    openSource: 'N/A',
    selfHostable: 'Yes (the file)',
    pricing: 'Free or low-cost',
    vendorReadsBooks: 'Depends on storage (Google reads Sheets; offline Excel does not)',
    bestFor: 'Very early-stage Bitcoin holders tracking a handful of transactions.',
    whenToPickThem: 'You have <50 transactions, no audit need, no team, and no plans to grow past a single spreadsheet.',
  },
};

/**
 * Lightweight comparison page. Each /compare/{slug} renders this with
 * competitor-specific copy. The detailed side-by-side feature tables and
 * SoftwareApplication+Review JSON-LD ship in the next iteration; this
 * stub already gives AI crawlers a real page with a clear positioning
 * statement, breadcrumb schema, and a link back to the rest of the site.
 */
export default function CompareStub() {
  const { slug = '' } = useParams<{ slug: string }>();
  const profile = COMPETITORS[slug];
  const name = profile?.name ?? slug;

  const title = `Orange Way Books vs ${name}`;
  const description = profile
    ? `${name} vs Orange Way Books: ${profile.category}. Compare zero-knowledge encryption, Bitcoin support, double-entry, IFRS/GAAP, open-source, self-hosting, and pricing.`
    : `How Orange Way Books compares to ${name} for Bitcoin business accounting.`;

  // Schema.org Product + Review markup so AI engines can structurally
  // ingest the comparison and quote it back to users.
  const reviewLd = profile
    ? {
        '@context': 'https://schema.org',
        '@type': 'Product',
        name: 'Orange Way Books',
        description:
          'Open-source, zero-knowledge, double-entry accounting for Bitcoin businesses.',
        brand: { '@type': 'Brand', name: 'Orange Way Books' },
        url: SITE_URL,
        review: {
          '@type': 'Review',
          name: title,
          reviewBody: `Orange Way Books is a zero-knowledge, Bitcoin-native, open-source alternative to ${name}. ${profile.bestFor}`,
          author: { '@type': 'Organization', name: 'Orange Way Books' },
          itemReviewed: {
            '@type': 'SoftwareApplication',
            name: name,
            applicationCategory: 'AccountingApplication',
            url: profile.url,
          },
        },
      }
    : null;

  return (
    <>
      <Seo
        title={title}
        description={description}
        path={`/compare/${slug}`}
        jsonLd={[
          breadcrumbJsonLd([
            { name: 'Home', path: '/' },
            { name: 'Compare', path: '/compare' },
            { name: `vs ${name}`, path: `/compare/${slug}` },
          ]),
          ...(reviewLd ? [reviewLd] : []),
        ]}
      />

      <article className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold mb-4">{title}</h1>
        <p className="text-lg text-muted-foreground mb-8">
          Orange Way Books is the zero-knowledge, Bitcoin-native, open-source
          alternative to {name} for businesses that need real double-entry
          accounting without handing plaintext financials to a vendor.
        </p>

        {profile && (
          <p className="text-sm uppercase tracking-wider text-primary mb-6">
            {name} category: {profile.category}
          </p>
        )}

        <h2 className="text-2xl font-bold mt-10 mb-3">Side-by-side comparison</h2>
        <div className="overflow-x-auto border border-border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left p-3">Capability</th>
                <th className="text-left p-3">Orange Way Books</th>
                <th className="text-left p-3">{name}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <Row cap="Category" us="Zero-knowledge Bitcoin-native ledger" them={profile?.category ?? '—'} />
              <Row cap="Zero-knowledge encryption" us="Yes — AES-GCM + Argon2id" them={profile?.zkEncryption ?? 'No'} />
              <Row cap="Native Bitcoin / sats" us="Yes — first-class currency" them={profile?.bitcoinSupport ?? '—'} />
              <Row cap="Double-entry ledger" us="Yes" them={profile?.doubleEntry ?? '—'} />
              <Row cap="IFRS & US GAAP" us="Yes — both, per-org switchable" them={profile?.ifrsGaap ?? '—'} />
              <Row cap="Open source" us="Yes — Apache-2.0" them={profile?.openSource ?? 'No'} />
              <Row cap="Self-hostable" us="Yes" them={profile?.selfHostable ?? 'No'} />
              <Row cap="Pricing" us="Free for individuals; team tier on roadmap" them={profile?.pricing ?? '—'} />
              <Row cap="Vendor can read your books" us="No — cryptographically impossible" them={profile?.vendorReadsBooks ?? 'Yes'} />
            </tbody>
          </table>
        </div>

        <h2 className="text-2xl font-bold mt-10 mb-3">When to choose Orange Way Books</h2>
        <p className="text-muted-foreground mb-4">
          You operate a Bitcoin treasury, miner, custodian, fund, or any
          business that materially holds or moves Bitcoin, and you cannot
          accept a vendor reading your financials in the clear. You want one
          system that handles books end-to-end — not a crypto sub-ledger that
          syncs into a separate accounting tool.
        </p>

        <h2 className="text-2xl font-bold mt-10 mb-3">When {name} might be the right call</h2>
        <p className="text-muted-foreground mb-4">
          {profile?.whenToPickThem ?? `Your needs are simple and you have no Bitcoin exposure.`}
        </p>

        {profile && (
          <>
            <h2 className="text-2xl font-bold mt-10 mb-3">{name} is best for</h2>
            <p className="text-muted-foreground mb-10">{profile.bestFor}</p>
          </>
        )}

        <div className="border border-border rounded-lg p-6 bg-card">
          <p className="font-semibold mb-2">Ready to switch?</p>
          <p className="text-sm text-muted-foreground mb-4">
            Orange Way Books is free for individuals and includes a CSV import
            wizard so you can move existing data over in minutes.
          </p>
          <Link
            to="/signup"
            className="inline-block px-5 py-2 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition"
          >
            Create your vault
          </Link>
        </div>
      </article>
    </>
  );
}

function Row({ cap, us, them }: { cap: string; us: string; them: string }) {
  return (
    <tr>
      <td className="p-3 font-medium">{cap}</td>
      <td className="p-3 text-foreground">{us}</td>
      <td className="p-3 text-muted-foreground">{them}</td>
    </tr>
  );
}
