import { Seo } from '../Seo';
import { breadcrumbJsonLd, SOFTWARE_APP_JSON_LD } from '../seo';

const FEATURE_GROUPS: ReadonlyArray<{
  heading: string;
  intro: string;
  items: ReadonlyArray<{ name: string; body: string }>;
}> = [
  {
    heading: 'Zero-knowledge security',
    intro: 'Your data is encrypted on your device before it ever reaches the cloud.',
    items: [
      { name: 'Argon2id key derivation', body: 'Vault password is stretched with Argon2id (memory-hard) before producing your master key.' },
      { name: 'AES-GCM field encryption', body: 'Every sensitive field — amounts, memos, account names, contacts — is encrypted client-side.' },
      { name: 'Per-org envelope encryption', body: 'Multi-user orgs wrap a per-org data key with each member\'s public key.' },
      { name: 'ML-DSA-65 signing keys', body: 'Post-quantum signing keys protect organization-level mutations.' },
      { name: 'Key rotation', body: 'Hard rekey workflow rotates DEK and signing-key versions across all rows with rollback safety.' },
      { name: 'Verifier-based vault unlock', body: 'Wrong password cannot decrypt; we never validate against a server-stored hash.' },
    ],
  },
  {
    heading: 'Bitcoin-native accounting',
    intro: 'Built from day one for sats, BTC, and historical FX.',
    items: [
      { name: 'Sats / BTC / BTC-easy display', body: 'Switch display modes per organization; underlying ledger is exact.' },
      { name: 'Historical exchange rates', body: 'Each transaction stores a snapshot of the rate at posting time.' },
      { name: 'Pending-rate handling', body: 'Transactions without a confirmed rate are flagged and back-fillable.' },
      { name: 'OrangeRails connector', body: 'Sync Bitcoin wallets and transactions from OrangeRails-compatible sources.' },
      { name: 'Multi-currency primary/secondary', body: 'Render every report in primary (e.g. USD) and secondary (e.g. BTC).' },
      { name: 'FX revaluation runs', body: 'Period-end re-pricing under your chosen framework with reversal support.' },
    ],
  },
  {
    heading: 'Real double-entry ledger',
    intro: 'Built on a real ledger engine — not a spreadsheet pretending to be accounting.',
    items: [
      { name: 'IFRS and US GAAP', body: 'Choose your framework per organization; reports render accordingly.' },
      { name: 'Journal entries', body: 'Manual JEs with debit/credit, dual-currency amounts, and period-locked enforcement.' },
      { name: 'Period locks', body: 'Close periods to prevent retroactive changes; lock dates are auditable.' },
      { name: 'Standard reports', body: 'Trial balance, balance sheet, P&L, general ledger, all printable and CSV-exportable.' },
      { name: 'Chart of accounts', body: 'Hierarchical, IFRS/GAAP-aware, importable from CSV or QuickBooks.' },
      { name: 'Audit logs', body: 'Every mutation is logged with before/after snapshots, encrypted at rest.' },
    ],
  },
  {
    heading: 'Teams and governance',
    intro: 'Capability-based RBAC that scales from solo to enterprise.',
    items: [
      { name: 'Capability-based roles', body: 'Granular capabilities (transactions.write, payments.approve, roles.manage, etc.).' },
      { name: 'Custom role definitions', body: 'Build your own roles with exactly the capabilities you need.' },
      { name: 'Time-boxed roles', body: 'Grant access that auto-expires; perfect for contractors and temp accountants.' },
      { name: 'Auditor support sessions', body: 'Time-boxed external auditor access with full audit trail.' },
      { name: 'Invitation flow', body: 'Public-key-based invites; new members never see plaintext until they unlock their own vault.' },
      { name: 'Multi-organization', body: 'One user, many orgs. Switch with one click; keys are scoped per org.' },
    ],
  },
  {
    heading: 'Data portability',
    intro: 'Your books are yours. Always.',
    items: [
      { name: 'Full takeout export', body: 'Download every byte we hold, encrypted or decrypted, in JSON.' },
      { name: 'CSV import for everything', body: 'Chart of accounts, contacts, transactions, JEs, payments.' },
      { name: 'CSV export for every report', body: 'Currency-aware, format-correct, ready for Excel.' },
      { name: 'QuickBooks import wizard', body: 'Map your QuickBooks export onto a fresh Orange Way Books organization.' },
      { name: 'Open-source self-hosting', body: 'Move off our servers entirely — your data, your infrastructure.' },
      { name: 'Apache-2.0', body: 'No license fees, no vendor lock-in, ever.' },
    ],
  },
];

export default function Features() {
  return (
    <>
      <Seo
        title="Features"
        description="Every Orange Way Books feature: zero-knowledge encryption, Bitcoin-native accounting, double-entry ledger, IFRS/GAAP, role-based access, and full data portability."
        path="/features"
        jsonLd={[
          SOFTWARE_APP_JSON_LD,
          breadcrumbJsonLd([
            { name: 'Home', path: '/' },
            { name: 'Features', path: '/features' },
          ]),
        ]}
      />

      <div className="max-w-5xl mx-auto px-6 py-16">
        <header className="mb-16 text-center">
          <h1 className="text-4xl font-bold mb-4">Every feature, one page</h1>
          <p className="text-muted-foreground max-w-2xl mx-auto">
            Orange Way Books is a full accounting platform — not a notebook with
            crypto support bolted on. Here is everything it does today.
          </p>
        </header>

        <div className="space-y-16">
          {FEATURE_GROUPS.map((group) => (
            <section key={group.heading}>
              <h2 className="text-2xl font-bold mb-2">{group.heading}</h2>
              <p className="text-muted-foreground mb-6">{group.intro}</p>
              <div className="grid gap-4 sm:grid-cols-2">
                {group.items.map((item) => (
                  <div key={item.name} className="border border-border rounded-lg p-4 bg-card">
                    <h3 className="font-semibold mb-1 text-sm">{item.name}</h3>
                    <p className="text-sm text-muted-foreground">{item.body}</p>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}
