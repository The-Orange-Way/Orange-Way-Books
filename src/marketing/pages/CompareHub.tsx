import { Link } from 'react-router-dom';
import { Seo } from '../Seo';
import { breadcrumbJsonLd } from '../seo';

const COMPETITORS: ReadonlyArray<{ slug: string; name: string; tagline: string }> = [
  { slug: 'quickbooks', name: 'QuickBooks', tagline: 'The mainstream SMB default — closed, plaintext, weak Bitcoin support.' },
  { slug: 'xero', name: 'Xero', tagline: 'Cleaner UX than QuickBooks, same plaintext-on-vendor problem.' },
  { slug: 'wave', name: 'Wave', tagline: 'Free SMB accounting, no Bitcoin, no encryption, ad-supported.' },
  { slug: 'freshbooks', name: 'FreshBooks', tagline: 'Invoicing-first, weak general ledger, no crypto.' },
  { slug: 'bitwave', name: 'Bitwave', tagline: 'Closed-source crypto sub-ledger that bolts onto QuickBooks/NetSuite.' },
  { slug: 'cryptio', name: 'Cryptio', tagline: 'Closed-source crypto back-office; vendor sees plaintext.' },
  { slug: 'spreadsheets', name: 'Spreadsheets', tagline: 'What most Bitcoin businesses actually use today.' },
];

export default function CompareHub() {
  return (
    <>
      <Seo
        title="Compare Orange Way Books"
        description="How Orange Way Books compares to QuickBooks, Xero, Wave, FreshBooks, Bitwave, Cryptio, and spreadsheets for Bitcoin business accounting."
        path="/compare"
        jsonLd={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Compare', path: '/compare' },
        ])}
      />

      <div className="max-w-4xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold mb-4">Compare Orange Way Books</h1>
        <p className="text-muted-foreground mb-10">
          Honest comparisons against the tools Bitcoin businesses are actually
          using today. Pick the one you&apos;re evaluating against.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          {COMPETITORS.map((c) => (
            <Link
              key={c.slug}
              to={`/compare/${c.slug}`}
              className="block border border-border rounded-lg p-5 bg-card hover:bg-muted transition"
            >
              <div className="font-semibold mb-1">vs {c.name}</div>
              <div className="text-sm text-muted-foreground">{c.tagline}</div>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
