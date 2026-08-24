import { Link } from 'react-router-dom';
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
          <p className="text-sm text-muted-foreground">Last updated: 2026-07-13.</p>
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
            You are responsible for keeping your vault password and recovery kit safe. We cannot
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

        <Section title="Pricing, billing, and refunds">
          <p className="text-muted-foreground">
            Prices are in Canadian dollars and exclude applicable taxes. You are responsible for any
            sales tax, GST, HST, or VAT that applies where you are. The plans on offer are on the
            Pricing page.
          </p>
          <p className="mt-4 text-muted-foreground">
            Paid plans are billed monthly. We do not keep a payment instrument on file and nothing
            is charged to you automatically: at the end of each cycle your billing page shows a
            payment link (Bitcoin Lightning or fiat) and the subscription continues only if you pay
            it. Annual plans and automatic renewal are not offered today.
          </p>
          <p className="mt-4 text-muted-foreground">
            Because nothing renews on its own, you stop a paid plan by not paying the next cycle.
            Your access continues to the end of the billing period you have already paid for. If you
            want the billing account closed on the record before then, write to legal@orangeway.app.
            A monthly cycle is not refundable once it has begun.
          </p>
          <p className="mt-4 text-muted-foreground">
            Current pricing applies during the beta period. We give at least 30 days written notice
            by email before any price increase takes effect at or after general availability. If we
            introduce annual plans or automatic renewal, these terms will be updated before that
            goes live.
          </p>
          <p className="mt-4 text-muted-foreground">
            Consumers in the EU and the UK have a statutory 14-day right to withdraw from a distance
            contract, starting on the purchase date. That right is forfeited once you have actively
            used the hosted service during the withdrawal window (EU Consumer Rights Directive
            Article 16(m)). Write to legal@orangeway.app before the period expires to exercise it.
          </p>
          <p className="mt-4 text-muted-foreground">
            Think a charge was made in error? Write to legal@orangeway.app within 60 days. We
            investigate and credit or refund confirmed errors.
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

        <Section title="Governing law">
          <p className="text-muted-foreground">
            These Terms are governed by the laws of the Province of Ontario and the federal laws of
            Canada applicable therein. Disputes submit to the exclusive jurisdiction of Ontario
            courts.
          </p>
        </Section>

        <Section title="Contact">
          <p className="text-muted-foreground">
            General contact, support, and billing questions: legal@orangeway.app. Bug reports,
            feature requests, and private security disclosures go through the channels on the{' '}
            <Link to="/contact" className="underline">
              Contact page
            </Link>
            . Privacy requests are handled through the contact named on the{' '}
            <Link to="/privacy" className="underline">
              Privacy page
            </Link>
            .
          </p>
        </Section>
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
