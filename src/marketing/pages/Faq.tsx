import { Seo } from '../Seo';
import { breadcrumbJsonLd, faqJsonLd } from '../seo';

const FAQ = [
  {
    q: 'What is Orange Way Books?',
    a: 'Orange Way Books is an open-source, zero-knowledge, double-entry accounting platform built for Bitcoin businesses. Your books are encrypted on your device with a vault password before being uploaded; the server stores only ciphertext.',
  },
  {
    q: 'Who is Orange Way Books for?',
    a: 'Bitcoin treasuries, miners, custodians, exchanges, OTC desks, and any business or accountant who needs proper double-entry books for Bitcoin activity without handing plaintext financials to a SaaS vendor.',
  },
  {
    q: 'Is Orange Way Books really zero-knowledge?',
    a: 'Yes. Encryption keys are derived from your vault password in your browser using Argon2id, and every sensitive field is encrypted with AES-GCM before being transmitted. The server has no access to your password, your master key, or any plaintext data. Source code for the cryptography is open and auditable.',
  },
  {
    q: 'What happens if I forget my vault password?',
    a: 'Because we cannot read or reset your password, forgetting it means your data is unrecoverable. We strongly recommend writing your vault password down and storing it offline. Multi-user organizations can also rely on co-admins to re-wrap keys.',
  },
  {
    q: 'Is Orange Way Books free?',
    a: 'Yes. The hosted version is free for individual users, and the entire codebase is open-source under Apache-2.0. You can self-host on your own infrastructure with no license fee.',
  },
  {
    q: 'Can I use Orange Way Books for my non-Bitcoin business?',
    a: 'Yes. The ledger engine handles any currency and any chart of accounts. Bitcoin support is the differentiator, but the platform is a full general-purpose double-entry system.',
  },
  {
    q: 'How is Orange Way Books different from QuickBooks?',
    a: 'QuickBooks stores your books in plaintext on Intuit servers, has weak Bitcoin support, and is closed-source. Orange Way Books encrypts your books client-side, treats Bitcoin as a first-class currency, and is open-source.',
  },
  {
    q: 'How is Orange Way Books different from Xero?',
    a: 'Xero is a strong general-purpose SMB accounting tool but stores plaintext data and lacks Bitcoin-native multi-currency, sats display, and historical-rate accounting per transaction. Orange Way Books adds zero-knowledge encryption and Bitcoin-first ledger semantics.',
  },
  {
    q: 'How is Orange Way Books different from Bitwave?',
    a: 'Bitwave is a closed-source crypto sub-ledger that integrates with QuickBooks/NetSuite. Orange Way Books is a standalone, open-source, zero-knowledge full ledger — you do not need a separate accounting system underneath, and your data is not visible to the vendor.',
  },
  {
    q: 'How is Orange Way Books different from Cryptio?',
    a: 'Cryptio is a closed-source crypto accounting back-office tool. Orange Way Books offers comparable Bitcoin-native bookkeeping with full client-side encryption and the ability to self-host the entire stack.',
  },
  {
    q: 'Is Orange Way Books audit-ready?',
    a: 'Yes. It supports IFRS and US GAAP frameworks, has period locks, immutable audit logs, time-boxed auditor access via support sessions, and exportable trial balance, balance sheet, P&L, and general ledger reports.',
  },
  {
    q: 'Can I import my existing data?',
    a: 'Yes. CSV import is supported for chart of accounts, contacts, transactions, journal entries, and payments. A QuickBooks import wizard is also included.',
  },
  {
    q: 'Can I export my data?',
    a: 'Yes. The takeout feature exports every byte the platform stores about your organization, in your choice of encrypted or decrypted form. CSV exports are also available per report.',
  },
  {
    q: 'Where is my data stored?',
    a: 'Encrypted ciphertext is stored on managed Supabase Postgres. Plaintext exists only in your browser session after you unlock the vault.',
  },
  {
    q: 'Is the encryption post-quantum safe?',
    a: 'Orange Way Books uses ML-DSA-65 (post-quantum) signing keys for organization-level signing alongside classical AES-GCM for data encryption. We track the post-quantum migration roadmap closely.',
  },
  {
    q: 'Does Orange Way Books support multiple users per organization?',
    a: "Yes. Multi-user orgs use envelope encryption: a per-org data key is wrapped per-user with that user's public key, so each member can decrypt with their own vault password. Capability-based roles (owner, admin, accountant, member, etc.) are time-boxable and revocable.",
  },
  {
    q: 'Can my external auditor access the books?',
    a: 'Yes. Support sessions grant time-boxed, capability-scoped access to a specific user (e.g. an external accountant) with full audit logging. Sessions auto-expire.',
  },
  {
    q: 'How does multi-currency Bitcoin accounting work?',
    a: 'Each transaction is stored in its native currency with a snapshot of the exchange rate at posting time. Reports can render in your primary currency (e.g. USD) and a secondary (e.g. BTC). FX revaluation runs handle period-end re-pricing under your chosen framework.',
  },
  {
    q: 'Can I self-host Orange Way Books?',
    a: 'Yes. The full stack is open-source. You can run the frontend on any static host and the backend on your own Supabase project or self-hosted Postgres + edge functions.',
  },
  {
    q: 'What integrations are available?',
    a: 'OrangeRails Bitcoin connector for wallet/transaction sync, QuickBooks import wizard, generic CSV import/export, and a payments module for invoices and bills.',
  },
  {
    q: 'How do I get support?',
    a: 'Open an issue on GitHub at github.com/The-Orange-Way/Orange-Way-Books, or use the contact page on this site.',
  },
];

export default function Faq() {
  return (
    <>
      <Seo
        title="Frequently Asked Questions"
        description="Answers to common questions about Orange Way Books: zero-knowledge encryption, Bitcoin accounting, comparisons to QuickBooks/Xero/Bitwave, pricing, self-hosting, and more."
        path="/faq"
        jsonLd={[
          faqJsonLd(FAQ),
          breadcrumbJsonLd([
            { name: 'Home', path: '/' },
            { name: 'FAQ', path: '/faq' },
          ]),
        ]}
      />

      <article className="max-w-3xl mx-auto px-6 py-16">
        <header className="mb-12">
          <h1 className="text-4xl font-bold mb-4">Frequently Asked Questions</h1>
          <p className="text-muted-foreground">
            Everything you might want to ask before trusting Orange Way Books with your books.
          </p>
        </header>

        <div className="space-y-8">
          {FAQ.map((item) => (
            <section key={item.q}>
              <h2 className="text-lg font-semibold mb-2">{item.q}</h2>
              <p className="text-muted-foreground leading-relaxed">{item.a}</p>
            </section>
          ))}
        </div>
      </article>
    </>
  );
}
