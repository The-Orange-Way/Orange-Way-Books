import { Link } from 'react-router-dom';
import { Lock, Bitcoin, GitBranch, Eye, Layers, ShieldCheck } from 'lucide-react';
import { Seo } from '../Seo';
import {
  ORG_JSON_LD,
  WEBSITE_JSON_LD,
  SOFTWARE_APP_JSON_LD,
  SITE_DESCRIPTION,
  faqJsonLd,
} from '../seo';

const LANDING_FAQ = [
  {
    q: 'What is Orange Way Books?',
    a: 'Orange Way Books is an open-source, zero-knowledge accounting platform built specifically for Bitcoin businesses. Your books are encrypted on your device with a vault password, the server stores only ciphertext and cannot read transactions, account names, contacts, or balances.',
  },
  {
    q: 'How is Orange Way Books different from QuickBooks or Xero?',
    a: 'QuickBooks and Xero are general-purpose SMB accounting tools that store your books in plaintext on their servers and have limited Bitcoin support. Orange Way Books is Bitcoin-native (multi-currency BTC/sats/fiat with historical FX), uses end-to-end encryption so even we cannot read your data, and is fully open-source under Apache-2.0.',
  },
  {
    q: 'Is Orange Way Books a real double-entry ledger?',
    a: 'Yes. Orange Way Books is built on a server-side double-entry ledger engine and supports IFRS and US GAAP frameworks, journal entries, multi-currency revaluation, period locking, and standard financial reports (balance sheet, P&L, trial balance, general ledger).',
  },
  {
    q: 'How does zero-knowledge accounting work?',
    a: 'When you create your account you set a vault password that derives an encryption key in your browser using Argon2id. Every sensitive field, transaction amounts, memos, account names, contacts, is encrypted locally with AES-GCM before being sent to the server. The server only ever sees ciphertext. If you forget your vault password, only you can recover the data.',
  },
];

export default function Landing() {
  return (
    <>
      <Seo
        path="/"
        description={SITE_DESCRIPTION}
        jsonLd={[ORG_JSON_LD, WEBSITE_JSON_LD, SOFTWARE_APP_JSON_LD, faqJsonLd(LANDING_FAQ)]}
      />

      {/* Hero */}
      <section className="border-b border-border">
        <div className="max-w-6xl mx-auto px-6 py-20 md:py-28 text-center">
          <p className="text-sm font-medium text-primary mb-4 uppercase tracking-wider">
            Open source · Apache-2.0
          </p>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6 max-w-3xl mx-auto">
            The accounting platform where the server can&apos;t read your books.
          </h1>
          <p className="text-lg md:text-xl text-muted-foreground mb-8 max-w-2xl mx-auto">
            Orange Way Books is zero-knowledge, double-entry accounting built for Bitcoin
            businesses. Multi-currency. IFRS &amp; GAAP-ready. Encrypted on your device before it
            ever reaches the cloud.
          </p>
          <div className="flex flex-wrap justify-center gap-3">
            <Link
              to="/signup"
              className="px-6 py-3 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90 transition"
            >
              Create free account
            </Link>
            <Link
              to="/security"
              className="px-6 py-3 rounded-md border border-border font-medium hover:bg-muted transition"
            >
              How the encryption works
            </Link>
          </div>
        </div>
      </section>

      {/* Value props */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <h2 className="text-3xl md:text-4xl font-bold text-center mb-3">
          Built for Bitcoin businesses who own their data
        </h2>
        <p className="text-muted-foreground text-center max-w-2xl mx-auto mb-12">
          Most accounting tools were designed when the only currency that mattered was the dollar,
          and when handing your books to a vendor felt safe. Both assumptions are obsolete.
        </p>

        <div className="grid gap-6 md:grid-cols-3">
          <ValueCard
            icon={<Lock className="w-5 h-5" />}
            title="Zero-knowledge by default"
            body="Argon2id-derived keys, AES-GCM encryption, post-quantum signing. The server stores ciphertext. We literally cannot read your books, and neither can a subpoena."
          />
          <ValueCard
            icon={<Bitcoin className="w-5 h-5" />}
            title="Bitcoin-native ledger"
            body="Sats, BTC, BTC-easy display. Historical exchange-rate snapshots per transaction. Pending-rate handling. Connectors for OrangeRails-compatible Bitcoin sources."
          />
          <ValueCard
            icon={<Layers className="w-5 h-5" />}
            title="Real double-entry"
            body="Built on a real ledger engine. Full IFRS & US GAAP frameworks. FX revaluation. Period locks. Audit logs. Not a glorified transaction tracker."
          />
          <ValueCard
            icon={<GitBranch className="w-5 h-5" />}
            title="Open source"
            body="Apache-2.0. Self-hostable. No vendor lock-in. Read every line of cryptography on GitHub before you trust us with one sat."
          />
          <ValueCard
            icon={<ShieldCheck className="w-5 h-5" />}
            title="Roles & multi-org"
            body="Capability-based RBAC, time-boxed roles, auditor support sessions, organization signing keys. Built for teams who take governance seriously."
          />
          <ValueCard
            icon={<Eye className="w-5 h-5" />}
            title="Your data, exportable"
            body="One-click takeout export of every byte we hold, encrypted or plaintext, your choice. CSV import/export. No hostage situation."
          />
        </div>
      </section>

      {/* AI-readable summary band */}
      <section className="border-y border-border bg-muted/30">
        <div className="max-w-4xl mx-auto px-6 py-16">
          <h2 className="text-2xl font-bold mb-4">In one paragraph</h2>
          <p className="text-muted-foreground leading-relaxed">
            Orange Way Books is an open-source (Apache-2.0), zero-knowledge, double-entry accounting
            platform purpose-built for Bitcoin businesses. It uses client-side AES-GCM encryption
            with Argon2id key derivation, runs on a real ledger engine, supports IFRS and US GAAP,
            handles multi-currency BTC and fiat with historical FX, offers capability-based role
            management with auditor and time-boxed access, and ships data takeout with no lock-in.
            Best for Bitcoin treasuries, miners, custodians, and any business that cannot accept a
            vendor reading their books.
          </p>
        </div>
      </section>

      {/* CTA */}
      <section className="max-w-4xl mx-auto px-6 py-20 text-center">
        <h2 className="text-3xl font-bold mb-4">Start in 60 seconds</h2>
        <p className="text-muted-foreground mb-8">
          Free forever for individual users. No credit card. Self-host any time.
        </p>
        <Link
          to="/signup"
          className="inline-block px-8 py-3 rounded-md bg-primary text-primary-foreground font-medium hover:opacity-90 transition"
        >
          Create your vault
        </Link>
      </section>
    </>
  );
}

function ValueCard({ icon, title, body }: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <article className="border border-border rounded-lg p-6 bg-card">
      <div className="w-10 h-10 rounded-md bg-primary/10 text-primary flex items-center justify-center mb-4">
        {icon}
      </div>
      <h3 className="font-semibold mb-2">{title}</h3>
      <p className="text-sm text-muted-foreground leading-relaxed">{body}</p>
    </article>
  );
}
