import { Seo } from '../Seo';
import { breadcrumbJsonLd } from '../seo';

export default function Terms() {
  return (
    <>
      <Seo
        title="Terms of Service"
        description="The terms governing your use of Orange Way Books. Plain language: be a good citizen, do not abuse the service, and we will do our part."
        path="/terms"
        jsonLd={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Terms', path: '/terms' },
        ])}
      />

      <article className="max-w-3xl mx-auto px-6 py-16 prose-invert">
        <header className="mb-10">
          <h1 className="text-4xl font-bold mb-4">Terms of Service</h1>
          <p className="text-sm text-muted-foreground">Last updated: 2026-07-08.</p>
        </header>

        <Section title="Use of the service">
          <p className="text-muted-foreground">
            You may use Orange Way Books to keep the books for yourself, your business, or your
            organization. You agree not to abuse the service, attempt to break the encryption of
            other users, or use the service to violate applicable law.
          </p>
        </Section>

        <Section title="Accounts">
          <p className="text-muted-foreground">
            You are responsible for keeping your vault password and recovery code safe. We cannot
            recover them for you, and that is by design: your books are encrypted on your device
            with keys only you hold.
          </p>
        </Section>

        <Section title="Beta status">
          <p className="text-muted-foreground">
            Orange Way Books is in beta. The service is provided as is. Maintain your own backups
            via Settings then Data export.
          </p>
        </Section>

        <Section title="Termination">
          <p className="text-muted-foreground">
            You may stop using the service at any time and export your books via Settings then Data
            export. We may suspend or terminate accounts that abuse the service.
          </p>
        </Section>

        <Section title="Liability">
          <p className="text-muted-foreground">
            Orange Way Books is provided without warranties. To the maximum extent permitted by law,
            our aggregate liability is limited to the greater of the fees you paid in the 12 months
            preceding the claim or one hundred Canadian dollars (CAD 100).
          </p>
        </Section>

        <p className="mt-10 text-xs text-muted-foreground">Questions? Email legal@orangeway.app.</p>
      </article>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10">
      <h2 className="text-2xl font-semibold mb-4">{title}</h2>
      {children}
    </section>
  );
}
