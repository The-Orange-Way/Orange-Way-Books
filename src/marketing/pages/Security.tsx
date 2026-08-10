import { Seo } from '../Seo';
import { breadcrumbJsonLd } from '../seo';

export default function Security() {
  return (
    <>
      <Seo
        title="Security & Zero-Knowledge Architecture"
        description="How Orange Way Books keeps your books invisible to the server: Argon2id, AES-GCM, ML-DSA-65 signing keys, envelope encryption, and a verifier-based vault unlock."
        path="/security"
        jsonLd={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Security', path: '/security' },
        ])}
      />

      <article className="max-w-3xl mx-auto px-6 py-16 prose-invert">
        <header className="mb-10">
          <h1 className="text-4xl font-bold mb-4">Security &amp; Zero-Knowledge Architecture</h1>
          <p className="text-muted-foreground">
            Orange Way Books is built so that the server cannot read your data, even if subpoenaed,
            even if breached. Here is exactly how.
          </p>
        </header>

        <Section title="Threat model">
          <p>
            We assume the database, the hosting provider, and Orange Way Books staff are{' '}
            <strong>untrusted</strong>. The only trusted components are your browser session and
            your vault password. Every guarantee below flows from that assumption.
          </p>
        </Section>

        <Section title="How vault unlock works">
          <ol className="list-decimal pl-6 space-y-2 text-muted-foreground">
            <li>You enter your vault password in the browser. It never leaves your device.</li>
            <li>
              Argon2id (memory-hard, configurable cost) stretches the password into a 256-bit master
              key.
            </li>
            <li>
              The master key decrypts a per-organization data encryption key (DEK) stored as
              ciphertext on the server.
            </li>
            <li>
              The DEK is held in memory for the session only and is used to decrypt every field on
              demand.
            </li>
          </ol>
        </Section>

        <Section title="What is encrypted">
          <p>
            Every business-meaningful field: transaction amounts, memos, contact names and
            addresses, account names, journal-entry descriptions, attachments, payment payee data.
            Encryption uses AES-GCM (authenticated). Field-level encryption means we can still index
            by org and by row id, but not by value.
          </p>
        </Section>

        <Section title="Multi-user organizations">
          <p>
            When you invite a teammate, their public key is used to wrap the org DEK. Each member
            ends up with their own ciphertext copy of the same key. Removing a member revokes their
            wrap; rotating the key re-wraps for everyone except the removed user.
          </p>
        </Section>

        <Section title="Post-quantum signing">
          <p>
            Sensitive mutations are signed by an organization signing key using ML-DSA-65
            (NIST-standard post-quantum signature scheme). The corresponding public key is stored
            server-side; verification happens in a database trigger before write.
          </p>
        </Section>

        <Section title="Key rotation and recovery">
          <p>
            A guided rekey workflow rotates DEK and signing-key versions across every row of
            business data, with rollback windows and progress visibility. Old wrapped keys are
            purged on a schedule. There is no password reset, losing your vault password means
            losing your data, which is the point.
          </p>
        </Section>

        <Section title="Open-source and auditable">
          <p>
            The full source is on{' '}
            <a
              href="https://github.com/The-Orange-Way/Orange-Way-Books"
              className="text-primary hover:underline"
            >
              GitHub
            </a>{' '}
            under Apache-2.0. Read every cryptographic primitive before you trust us with one sat.
            Self-host if you prefer to trust nobody at all.
          </p>
        </Section>
      </article>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-2xl font-bold mb-3">{title}</h2>
      <div className="text-muted-foreground leading-relaxed">{children}</div>
    </section>
  );
}
