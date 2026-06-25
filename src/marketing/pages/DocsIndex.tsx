import { Seo } from '../Seo';
import { breadcrumbJsonLd } from '../seo';

export default function DocsIndex() {
  return (
    <>
      <Seo
        title="Documentation"
        description="Orange Way Books documentation: architecture, zero-knowledge guide, security model, getting started."
        path="/docs"
        jsonLd={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Docs', path: '/docs' },
        ])}
      />

      <div className="max-w-3xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold mb-4">Documentation</h1>
        <p className="text-muted-foreground mb-8">
          Detailed docs are being rolled out from the project&apos;s internal design documents. In
          the meantime, the canonical source is the{' '}
          <a
            href="https://github.com/The-Orange-Way/Orange-Way-Books/tree/main/docs"
            className="text-primary hover:underline"
            rel="noopener noreferrer"
          >
            /docs folder on GitHub
          </a>
          , which includes architecture, the ZKA guide, the enterprise security model, and the
          multi-currency brain.
        </p>

        <ul className="space-y-3 text-sm">
          <li>
            <a
              className="text-primary hover:underline"
              href="https://github.com/The-Orange-Way/Orange-Way-Books/blob/main/docs/OWB-ARCHITECTURE.md"
            >
              OWB-ARCHITECTURE.md — system overview
            </a>
          </li>
          <li>
            <a
              className="text-primary hover:underline"
              href="https://github.com/The-Orange-Way/Orange-Way-Books/blob/main/docs/OWB-ZKA-BRIDGE.md"
            >
              OWB-ZKA-BRIDGE.md — zero-knowledge architecture
            </a>
          </li>
          <li>
            <a
              className="text-primary hover:underline"
              href="https://github.com/The-Orange-Way/Orange-Way-Books/blob/main/docs/OWB-ENTERPRISE-SECURITY.md"
            >
              OWB-ENTERPRISE-SECURITY.md — enterprise security
            </a>
          </li>
          <li>
            <a
              className="text-primary hover:underline"
              href="https://github.com/The-Orange-Way/Orange-Way-Books/blob/main/docs/OWB-MultiCurrency-Brain.md"
            >
              OWB-MultiCurrency-Brain.md — FX & multi-currency
            </a>
          </li>
        </ul>
      </div>
    </>
  );
}
