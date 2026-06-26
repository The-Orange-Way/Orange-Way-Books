import { Link } from 'react-router-dom';
import { Seo } from '../Seo';
import { breadcrumbJsonLd } from '../seo';

export default function Privacy() {
  return (
    <>
      <Seo
        title="Privacy Policy"
        description="What Orange Way Books collects, what it cannot collect by design, who it shares data with, and how to exercise your data rights."
        path="/privacy"
        jsonLd={breadcrumbJsonLd([
          { name: 'Home', path: '/' },
          { name: 'Privacy', path: '/privacy' },
        ])}
      />

      <article className="max-w-3xl mx-auto px-6 py-16 prose-invert">
        <header className="mb-10">
          <h1 className="text-4xl font-bold mb-4">Privacy Policy</h1>
          <p className="text-muted-foreground">
            What we collect, what we cannot collect by design, who else sees it, and how to exercise
            your rights. Plain-English version first, controller / sub-processor / retention details
            after.
          </p>
          <p className="text-sm text-muted-foreground mt-4">Last updated: 2026-06-26.</p>
        </header>

        <Section title="The short version">
          <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
            <li>
              <strong>Your books are unreadable to us by design.</strong> Categories, memos, journal
              entries, account names, customer records, vendor contracts, and balances you enter are
              encrypted on your device before they reach our servers. We store ciphertext and
              timestamps.{' '}
              <Link to="/security" className="underline">
                See the threat model.
              </Link>
            </li>
            <li>
              <strong>We do collect some things.</strong> Your email address (for the account), the
              timestamps on encrypted rows (so the server can answer "show me May" without reading
              the row), basic billing metadata, and anonymous product analytics when you use the
              marketing site. Details below.
            </li>
            <li>
              <strong>What we share.</strong> Sub-processors named below (Supabase for the database,
              PostHog for analytics, Resend for email, optionally Flash for Lightning billing). We
              do not sell data and have no advertising business.
            </li>
            <li>
              <strong>What you can do.</strong> Export your data, delete your account, opt out of
              analytics, file a complaint. Contact info at the bottom.
            </li>
          </ul>
        </Section>

        <Section title="Data we collect">
          <h3 className="text-lg font-semibold mt-4 mb-2">From you, directly</h3>
          <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
            <li>
              <strong>Account.</strong> Email address, the password verifier stored by Supabase Auth
              (used to sign you in), and the encrypted vault key wrap derived from your vault
              password (Argon2id). The vault password is a separate secret from your Supabase Auth
              password; we cannot recover the vault password.
            </li>
            <li>
              <strong>Encrypted business data.</strong> Stored as ciphertext. Includes a per-row
              date so the database can answer time-range queries.
            </li>
            <li>
              <strong>Billing.</strong> Subscription tier, payment method handle held by the payment
              processor (we never see card numbers), billing-related email.
            </li>
            <li>
              <strong>Support correspondence</strong> when you write in.
            </li>
          </ul>

          <h3 className="text-lg font-semibold mt-6 mb-2">From your browser, automatically</h3>
          <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
            <li>
              <strong>Server logs.</strong> IP address, user-agent, request path, and response
              status. Retained 30 days for abuse and debugging.
            </li>
            <li>
              <strong>Authentication cookies</strong> when you sign in. Cleared on sign-out.
            </li>
            <li>
              <strong>Marketing-site analytics</strong> via PostHog when the operator has enabled
              it. Pageview event with referrer, country (from IP, not stored), and a session-scoped
              anonymous identifier. Stored in memory only, no persistent cookie, no cross-site
              tracking. The PostHog SDK is configured with `respect_dnt: true`, so a Do-Not-Track
              signal disables event sending. Also disabled when you dismiss the analytics notice.
              Disabled entirely on self-hosted builds.
            </li>
            <li>
              <strong>Anti-abuse signals at signup</strong> via hCaptcha when the operator
              configures a site key. hCaptcha receives your IP address, user-agent, and behavioral
              signals from the challenge widget so it can score whether the request looks human. The
              score is the only thing returned to Orange Way Books. See hCaptcha's privacy notice
              for the upstream side.
            </li>
          </ul>

          <h3 className="text-lg font-semibold mt-6 mb-2">From third parties</h3>
          <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
            <li>
              <strong>Bank and exchange data via Orange Rails (optional).</strong> If you connect a
              bank or exchange, Orange Rails receives the upstream feed and forwards encrypted
              records to Orange Way Books. The upstream institution and Orange Rails see the
              plaintext feed; we do not. See the Orange Rails privacy policy for the upstream side.
            </li>
            <li>
              <strong>Live exchange rates via ORBI (optional).</strong> When ORBI is configured, the
              app fetches public BTC↔fiat rates from a read-only ORBI Supabase project. The request
              carries no user identifier; ORBI sees a generic anonymous read.
            </li>
          </ul>
        </Section>

        <Section title="What we cannot see, by design">
          <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
            <li>The contents of your encrypted rows.</li>
            <li>Your vault password or any key derived from it.</li>
            <li>
              The plaintext of attachments, attachment filenames, and attachment MIME types. File{' '}
              <em>size</em> and <em>count</em> remain as plaintext metadata, the same trade-off the
              threat model documents for row counts.
            </li>
            <li>The categorization choices, memos, and account labels you enter.</li>
          </ul>
          <p className="text-muted-foreground mt-4">
            The threat model document explains exactly which metadata remains plaintext (row dates,
            row counts, sub-second timing) and the trade-off behind each one.
          </p>
        </Section>

        <Section title="How we use what we collect">
          <ul className="list-disc pl-6 space-y-2 text-muted-foreground">
            <li>
              To provide the service: deliver the app, run the encrypted database, send
              transactional email.
            </li>
            <li>To bill you for paid plans.</li>
            <li>To detect abuse: rate-limit, block obvious attackers, respond to incidents.</li>
            <li>
              To improve the marketing site: aggregate, anonymous traffic patterns. We do not build
              profiles.
            </li>
          </ul>
          <p className="text-muted-foreground mt-4">
            We do not sell your data. We have no advertising business. Material changes to this
            position would be announced under the "Changes to this policy" rules below.
          </p>
        </Section>

        <Section title="Sub-processors">
          <p className="text-muted-foreground">
            A handful of third parties touch parts of Orange Way Books. Each one only sees what is
            listed below. Because your books are encrypted on your device, none of these companies
            can read your accounts, balances, transactions, contacts, or invoices.
          </p>

          <h3 className="mt-6 text-lg font-semibold">Supabase</h3>
          <p className="mt-2 text-muted-foreground">
            Stores your account, authentication state, and the ciphertext your device produces.
            Hosted in the United States. Sees: your email, the ciphertext blobs (which it cannot
            decrypt), and connection metadata. Retention: as long as your account exists, plus 30
            days after deletion for backups.
          </p>

          <h3 className="mt-6 text-lg font-semibold">Cloudflare</h3>
          <p className="mt-2 text-muted-foreground">
            Hosts the website and runs the captcha challenge that appears on signup. Cloudflare is
            headquartered in the United States. Sees: standard request metadata (IP, user agent,
            timestamp) and the captcha challenge response. The captcha vendor (hCaptcha today) does
            not use tracking cookies and does not build a profile of you. Retention: edge logs are
            typically deleted within 7 days.
          </p>

          <h3 className="mt-6 text-lg font-semibold">Resend</h3>
          <p className="mt-2 text-muted-foreground">
            Sends the transactional emails we generate: signup confirmations, password reset links,
            and any future notification we explicitly opt into. Headquartered in Delaware, United
            States, with mail delivery infrastructure in the United States and Europe. Sees: your
            email address and the email body. Retention: send logs for the period required by the
            Resend service plan, typically up to 30 days.
          </p>

          <h3 className="mt-6 text-lg font-semibold">GlitchTip</h3>
          <p className="mt-2 text-muted-foreground">
            Receives error reports when the app crashes so we can fix bugs faster. We run GlitchTip
            on our own server. Sees: the technical details of the crash (route name, stack trace,
            browser version). Before any report leaves your device, an in-browser scrubber strips
            known sensitive field names (passwords, recovery codes, vault keys, account balances,
            merchant names) and rewrites URL fragments. Retention: 30 days on the GlitchTip server.
          </p>

          <h3 className="mt-6 text-lg font-semibold">PostHog (optional)</h3>
          <p className="mt-2 text-muted-foreground">
            Marketing-site analytics. Disabled by default on self-hosted builds. Anonymous events
            only; no cross-site cookies, no profiles. Sees: page views and aggregate clicks. The
            actual retention is the value the operator has configured on the PostHog project; our
            target is 90 days.
          </p>

          <h3 className="mt-6 text-lg font-semibold">Flash (optional)</h3>
          <p className="mt-2 text-muted-foreground">
            Lightning billing for paid plans. Engaged only if you subscribe to a paid tier. Sees:
            the payment metadata required to settle the invoice.
          </p>

          <h3 className="mt-6 text-lg font-semibold">Orange Rails (optional)</h3>
          <p className="mt-2 text-muted-foreground">
            Bank and exchange aggregator. Engaged only when the operator enables a connection. Sees:
            the read-only credentials you authorize for the connection and the resulting transaction
            metadata.
          </p>

          <h3 className="mt-6 text-lg font-semibold">ORBI (optional)</h3>
          <p className="mt-2 text-muted-foreground">
            BTC/fiat historical exchange rates. Public read-only data; no user identifier is sent.
          </p>
        </Section>

        <Section title="Retention">
          <p className="text-muted-foreground">
            These are our target retention windows. We delete on a periodic schedule; if an
            automated deletion job has not yet run for a given window, the data is held for the
            shorter of "until the next scheduled deletion" or "until you ask us to delete it."
          </p>
          <ul className="list-disc pl-6 space-y-2 text-muted-foreground mt-4">
            <li>Encrypted business data: kept until you delete it or close your account.</li>
            <li>
              Account email and billing metadata: kept while your account is active. Target window
              after closure is 365 days for tax/audit obligations, then deletion.
            </li>
            <li>
              Server logs: target 30 days. Exact rotation is controlled by the hosting providers
              (Supabase, edge-function runtime).
            </li>
            <li>
              Analytics events: target 90 days. The actual retention in PostHog is the value the
              operator has configured on the PostHog project.
            </li>
            <li>Support correspondence: target 24 months from last message.</li>
          </ul>
        </Section>

        <Section title="Your rights">
          <p className="text-muted-foreground">
            Depending on where you live (EU/UK GDPR, Quebec Law 25, California CCPA, others), you
            have one or more of the following rights:
          </p>
          <ul className="list-disc pl-6 space-y-2 text-muted-foreground mt-4">
            <li>
              <strong>Access</strong> the data we hold about you.
            </li>
            <li>
              <strong>Export</strong> your encrypted books and account metadata in a
              machine-readable format. Available in-app under Settings → Data export.
            </li>
            <li>
              <strong>Correct</strong> inaccurate account information.
            </li>
            <li>
              <strong>Delete</strong> your account and the data we hold for you. Available in-app
              under Settings → Close account.
            </li>
            <li>
              <strong>Opt out of analytics.</strong> Dismiss the analytics notice (top of any
              marketing page) or use a Do-Not-Track signal.
            </li>
            <li>
              <strong>File a complaint</strong> with your local data-protection authority. In Canada
              that's the Commission d'accès à l'information du Québec (Law 25) or the Office of the
              Privacy Commissioner of Canada (PIPEDA); in the EU, your national DPA; in the UK, the
              ICO.
            </li>
          </ul>
        </Section>

        <Section title="Self-hosted deployments">
          <p className="text-muted-foreground">
            If you run Orange Way Books on your own infrastructure, the controller is you (or your
            organization), not Orange Way Books. This policy describes the SaaS deployment we
            operate. Self-hosted builds disable PostHog and Resend by default; you decide which
            sub-processors to configure. Orange Way Books is not a sub-processor of self-hosted
            deployments and has no access to data flowing through them.
          </p>
        </Section>

        <Section title="Contact">
          <p className="text-muted-foreground">
            For privacy questions, data-rights requests, or breach notifications, write to
            privacy@orangeway.app. We aim to respond within 30 days as required by GDPR Art. 12 and
            equivalent statutes.
          </p>
        </Section>

        <Section title="Changes to this policy">
          <p className="text-muted-foreground">
            Material changes will be announced in-app and on the marketing site at least 30 days
            before they take effect. The "Last updated" date at the top of this page reflects the
            most recent revision.
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
