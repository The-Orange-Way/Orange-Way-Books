import { Link } from 'react-router-dom';
import { Seo } from '../Seo';
import { breadcrumbJsonLd, faqJsonLd } from '../seo';

const PRICING_FAQ = [
  {
    q: 'Is Orange Way Books really free?',
    a: 'Yes. The hosted version is free for individual users. The entire codebase is open-source under Apache-2.0 with no license fee for self-hosting.',
  },
  {
    q: 'Will pricing change later?',
    a: 'A team/business tier with paid features (advanced governance, SLAs, support) is on the roadmap. Individual use will remain free.',
  },
  {
    q: 'Can I self-host to avoid any future fees?',
    a: 'Yes. Apache-2.0 means you can self-host the full stack on your own infrastructure indefinitely.',
  },
];

export default function Pricing() {
  return (
    <>
      <Seo
        title="Pricing"
        description="Orange Way Books is free for individuals and open-source for self-hosting. No credit card. No license fee. Optional paid team tier coming soon."
        path="/pricing"
        jsonLd={[
          faqJsonLd(PRICING_FAQ),
          breadcrumbJsonLd([
            { name: 'Home', path: '/' },
            { name: 'Pricing', path: '/pricing' },
          ]),
        ]}
      />

      <div className="max-w-5xl mx-auto px-6 py-16">
        <header className="text-center mb-12">
          <h1 className="text-4xl font-bold mb-4">Pricing</h1>
          <p className="text-muted-foreground max-w-xl mx-auto">
            Free to use. Free to self-host. No license fee, no per-seat trick,
            no surprise upsell at month two.
          </p>
        </header>

        <div className="grid gap-6 md:grid-cols-3 mb-16">
          <Plan
            name="Individual"
            price="Free"
            cta="Create account"
            ctaTo="/signup"
            highlight
            features={[
              'Unlimited transactions',
              'Zero-knowledge encryption',
              'All reports & exports',
              'OrangeRails Bitcoin connector',
              'IFRS & GAAP frameworks',
              'Single user',
            ]}
          />
          <Plan
            name="Team"
            price="Coming soon"
            cta="Get notified"
            ctaTo="/contact"
            features={[
              'Everything in Individual',
              'Multi-user organizations',
              'Capability-based roles',
              'Auditor support sessions',
              'Time-boxed access grants',
              'Priority support',
            ]}
          />
          <Plan
            name="Self-hosted"
            price="Free forever"
            cta="View on GitHub"
            ctaTo="https://github.com/The-Orange-Way/Orange-Way-Books"
            external
            features={[
              'Apache-2.0 license',
              'Run on your own infrastructure',
              'Full source code',
              'No telemetry',
              'No vendor lock-in',
              'Community support',
            ]}
          />
        </div>

        <section className="max-w-2xl mx-auto">
          <h2 className="text-2xl font-bold mb-6">Pricing questions</h2>
          <div className="space-y-6">
            {PRICING_FAQ.map((item) => (
              <div key={item.q}>
                <h3 className="font-semibold mb-1">{item.q}</h3>
                <p className="text-muted-foreground text-sm">{item.a}</p>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

function Plan({
  name,
  price,
  features,
  cta,
  ctaTo,
  highlight = false,
  external = false,
}: {
  name: string;
  price: string;
  features: ReadonlyArray<string>;
  cta: string;
  ctaTo: string;
  highlight?: boolean;
  external?: boolean;
}) {
  return (
    <article
      className={`border rounded-lg p-6 bg-card ${
        highlight ? 'border-primary shadow-sm' : 'border-border'
      }`}
    >
      <h3 className="text-lg font-semibold mb-1">{name}</h3>
      <p className="text-3xl font-bold mb-6">{price}</p>
      <ul className="space-y-2 mb-6 text-sm text-muted-foreground">
        {features.map((f) => (
          <li key={f} className="flex gap-2">
            <span className="text-primary">✓</span>
            <span>{f}</span>
          </li>
        ))}
      </ul>
      {external ? (
        <a
          href={ctaTo}
          rel="noopener noreferrer"
          className="block text-center px-4 py-2 rounded-md border border-border hover:bg-muted transition text-sm font-medium"
        >
          {cta}
        </a>
      ) : (
        <Link
          to={ctaTo}
          className={`block text-center px-4 py-2 rounded-md text-sm font-medium transition ${
            highlight
              ? 'bg-primary text-primary-foreground hover:opacity-90'
              : 'border border-border hover:bg-muted'
          }`}
        >
          {cta}
        </Link>
      )}
    </article>
  );
}
