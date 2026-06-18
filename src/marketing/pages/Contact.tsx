import { Seo } from '../Seo';
import { breadcrumbJsonLd } from '../seo';

export default function Contact() {
  return (
    <>
      <Seo
        title="Contact"
        description="Reach Orange Way Books: open a GitHub issue, email security disclosures, or join the community."
        path="/contact"
        jsonLd={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Contact', path: '/contact' },
        ])}
      />

      <article className="max-w-2xl mx-auto px-6 py-16">
        <h1 className="text-4xl font-bold mb-6">Contact</h1>
        <p className="text-muted-foreground mb-10">
          Orange Way Books is an open-source project. The fastest way to reach
          us is through the channels below.
        </p>

        <div className="space-y-6">
          <ContactRow
            label="GitHub Issues"
            href="https://github.com/The-Orange-Way/Orange-Way-Books/issues"
            body="Bug reports, feature requests, general questions."
          />
          <ContactRow
            label="Security disclosures"
            href="https://github.com/The-Orange-Way/Orange-Way-Books/security/advisories"
            body="Please use private security advisories on GitHub for anything sensitive."
          />
          <ContactRow
            label="Source code"
            href="https://github.com/The-Orange-Way/Orange-Way-Books"
            body="Browse, fork, audit. Apache-2.0 licensed."
          />
        </div>
      </article>
    </>
  );
}

function ContactRow({ label, href, body }: { label: string; href: string; body: string }) {
  return (
    <a
      href={href}
      rel="noopener noreferrer"
      className="block border border-border rounded-lg p-5 bg-card hover:bg-muted transition"
    >
      <div className="font-semibold mb-1">{label}</div>
      <div className="text-sm text-muted-foreground">{body}</div>
    </a>
  );
}
