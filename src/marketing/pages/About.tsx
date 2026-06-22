import { Seo } from '../Seo';
import { breadcrumbJsonLd, ORG_JSON_LD } from '../seo';

export default function About() {
  return (
    <>
      <Seo
        title="About"
        description="Why Orange Way Books exists: Bitcoin businesses deserve double-entry accounting that does not require trusting a vendor with plaintext financials."
        path="/about"
        jsonLd={[
          ORG_JSON_LD,
          breadcrumbJsonLd([
            { name: 'Home', path: '/' },
            { name: 'About', path: '/about' },
          ]),
        ]}
      />

      <article className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold mb-6">About Orange Way Books</h1>
        <p className="text-lg text-muted-foreground mb-8">
          Orange Way Books exists because Bitcoin businesses deserve real accounting — and because
          trusting a SaaS vendor with plaintext books stopped being acceptable a long time ago.
        </p>

        <h2 className="text-2xl font-bold mt-10 mb-4">The problem</h2>
        <p className="text-muted-foreground mb-6">
          Every existing accounting platform stores your books in plaintext on a server you
          don&apos;t control. Some have weak Bitcoin support; others bolt on a sub-ledger. None of
          them can credibly say &quot;we cannot read your data&quot; — because they can.
        </p>

        <h2 className="text-2xl font-bold mt-10 mb-4">Our approach</h2>
        <p className="text-muted-foreground mb-6">
          Encrypt everything in the browser before it leaves the device. Run a real double-entry
          ledger underneath. Make Bitcoin a first-class currency, not an afterthought. Open-source
          the entire stack so anyone can verify the cryptography or self-host. Charge nothing for
          individuals.
        </p>

        <h2 className="text-2xl font-bold mt-10 mb-4">Open source</h2>
        <p className="text-muted-foreground mb-6">
          Orange Way Books is licensed under Apache-2.0 and developed in the open at{' '}
          <a
            href="https://github.com/The-Orange-Way/Orange-Way-Books"
            className="text-primary hover:underline"
          >
            github.com/The-Orange-Way/Orange-Way-Books
          </a>
          . Issues, pull requests, and security disclosures all welcome.
        </p>
      </article>
    </>
  );
}
