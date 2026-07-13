# Orange Way Books -- Terms of Service

> **This is a placeholder.** It is intended to ship alongside an early
> SaaS / self-host launch as a baseline so the product is not operating
> with literally nothing on file. A lawyer should review this document
> before any commercial scale-up. If you are reading this as a
> prospective customer with a real budget, ask the maintainers for the
> reviewed version.

Last updated: 2026-07-13. Effective on the same date.

---

## 1. Who we are

Orange Way Books is operated by Morning Revolution, an Ontario-domiciled
operator. References to "we", "us", or "Orange Way Books" in this
document mean the operator. References to "you" mean the individual or
organisation creating an account or self-hosting the software.

The privacy contact email is published in the public site's footer
alongside the general contact address. A reviewed version of this
document will replace the footer-indirection with a literal address.

## 2. The service

Orange Way Books is a zero-knowledge bookkeeping application. The
product comes in two forms:

- **Hosted (SaaS):** an account on `books.orangeway.app`. The hosted
  service is offered on a free tier plus paid tiers; current pricing is
  on the public Pricing page.
- **Self-hosted:** the open-source codebase under the Apache-2.0
  licence. You may run the software on infrastructure you control. The
  self-hosted form is not subject to the hosted-service availability or
  support commitments below.

The product is described in plain English in the public README and the
`SECURITY.md` document at the root of the repository. The architectural
claim that we cannot read your books is operational: it is enforced by
the encryption stack, not by policy. See `SECURITY.md` for the
technical details and the Known Limitations section.

## 3. Account responsibilities

When you create an account, you choose a vault password and accept a
12-word recovery code shown once in your browser. Both are derived and
held client-side.

**You are responsible for keeping the vault password and the recovery
code safe.** Orange Way Books cannot recover, reset, or escrow either.
If you lose both, the data you encrypted under them is cryptographically
unrecoverable by design. The same property is what gives the
zero-knowledge guarantee its weight: we cannot decrypt your books even
if we wanted to, and we cannot help an attacker who has compromised one
factor unlock your vault using a stored second factor.

You agree to keep your account credentials confidential, not to share
them, and to notify us promptly if you believe an account has been
compromised. Notifying us does not unlock the data; it lets us
co-ordinate.

## 4. Acceptable use

You will not use the service to:

- Process data on behalf of third parties without the legal basis to
  do so.
- Submit content you do not have the right to store (including
  third-party trade secrets, classified information, or anything
  subject to a court order to preserve elsewhere).
- Attempt to circumvent rate limits or other technical controls.
- Reverse-engineer the hosted service's infrastructure (the open-source
  codebase is the supported way to inspect product behaviour).

The hosted service may suspend or terminate an account that violates
this section.

## 5. Pricing, billing, and refunds

Prices are in Canadian dollars (CAD) and exclude applicable taxes. You
are responsible for any sales tax, GST, HST, or VAT that applies in
your jurisdiction. The plans on offer are listed on the public Pricing
page.

**How billing works today.** Paid plans are billed monthly. We do not
store a payment instrument and nothing is charged to you automatically.
At the end of each cycle the billing page shows a payment link (Bitcoin
Lightning or fiat, through our payment provider) and the subscription
continues only if you choose to pay it. Annual plans and automatic
renewal are not offered today.

**Stopping a paid plan.** Because nothing renews automatically, you stop
a paid plan by not paying the next cycle's payment link. Your access
continues to the end of the billing period you have already paid for. If
you want the billing account closed on the record before then, contact
support using the address in the site footer.

**Refunds.** A monthly billing cycle is non-refundable once it has
begun.

**Beta pricing.** Current pricing applies during the beta period. We
will give at least 30 days written notice by email before any price
increase takes effect at or after general availability.

**New billing options.** If we introduce annual plans, automatic
renewal, or any other billing mechanism, this section will be updated
before that mechanism goes live and the notice period in section 11
applies.

**EU and UK consumers.** You have a statutory 14-day right to withdraw
from a distance contract. The period begins on the purchase date. The
right is forfeited once you have actively used the hosted service
during the withdrawal window (EU Consumer Rights Directive Art. 16(m)).
Contact support before the period expires to exercise this right.

**Disputed charges.** Contact support within 60 days of any charge you
believe was made in error. We will investigate and credit or refund
confirmed errors.

## 6. Data and privacy

Orange Way Books processes only as much data as the architecture
allows it to see. The encryption stack means most fields (amounts,
contact names, descriptions, account names, etc.) are ciphertext on
our side; we store ciphertext and metadata that does not require a
key (dates, row counts, identifiers).

The full privacy posture, including the list of sub-processors
(currently Supabase for database and authentication, Cloudflare Pages
for the static frontend, Resend for transactional email, and Chatwoot
for the optional in-app live-chat widget), data residency notes, and
how to exercise data-subject rights, is on the public **Privacy** page
at `/privacy` and in `SECURITY.md`. Both apply.

Chat messages sent through the Chatwoot widget are plaintext to the
operator and are explicitly outside the zero-knowledge scope; the
"the server cannot read your books" guarantee covers stored books-data
only, never chat content.

**Cross-border data transfer.** Supabase, Cloudflare, Resend, and the
operator's self-hosted Chatwoot instance may
store or process some metadata outside Quebec and Canada (typically
in the United States or the European Union, depending on the region
configured for each project). The encrypted fields (`enc_*` columns)
remain ciphertext throughout transit and at rest; the operator and
the sub-processors do not hold a decryption key. The current region
of each sub-processor is documented on the Privacy page. By using the
hosted service you acknowledge that this transfer occurs.

**Breach notification.** If a confidentiality incident occurs that
presents a risk of serious injury to data subjects, we will notify
the Commission d'accès à l'information (CAI) and affected individuals
as required by Quebec Law 25 §3.5 and, where applicable, supervisory
authorities under GDPR Article 33 (within 72 hours of becoming aware
where feasible). As an organization subject to the Personal
Information Protection and Electronic Documents Act (PIPEDA), we will
report any breach of security safeguards that creates a real risk of
significant harm to the Office of the Privacy Commissioner of Canada
(OPC) as soon as feasible, and notify affected individuals as required
under the Breach of Security Safeguards Regulations (SOR/2018-64). We
target a 72-hour acknowledgment window for any inbound vulnerability
report on the same channel; see `SECURITY.md` for the disclosure
address and timeline.

We do not sell customer data, do not run an ad business, and do not
build personal profiles on the analytics side (self-hosted builds run
no telemetry; hosted builds run a memory-only analytics setup with no
user-level identification).

## 7. Service availability

The hosted service is offered on a best-effort basis. We aim for high
availability and back the data with the underlying provider's
point-in-time recovery, but we do not commit to a specific uptime
percentage on free or current paid tiers. If you require a contractual
SLA, contact the maintainers before relying on the hosted service.

Scheduled maintenance is announced when possible. Emergency
maintenance may run without notice.

## 8. Open-source code and contributions

The source code is licensed under the Apache Licence, Version 2.0. See
`LICENSE` and `NOTICE` at the root of the repository for full terms,
including the required attribution clause and the disclaimer of
warranty.

Contributions are accepted under the same Apache-2.0 licence. By
opening a pull request you certify that you have the right to submit
the code under that licence (DCO-style).

## 9. Warranty disclaimer

The service is provided **"as is"** and **"as available"** without
warranties of any kind, express or implied, including without
limitation any implied warranties of merchantability, fitness for a
particular purpose, or non-infringement. You bear the full risk of
using the service.

## 10. Limitation of liability

To the maximum extent permitted by applicable law, Orange Way Books'
total liability arising from or related to the service is limited to
the amount you paid for the hosted service in the twelve months
preceding the claim, or one hundred Canadian dollars (CAD 100),
whichever is greater. In no event is Orange Way Books liable for
indirect, incidental, special, or consequential damages, even if
advised of the possibility of such damages. Some jurisdictions do not
allow these limitations; in those jurisdictions the limitation applies
to the maximum extent permitted by law.

## 11. Changes to these terms

We may revise these terms from time to time. Material changes will be
announced on the public site and, for hosted-service customers, by
email at least thirty days before they take effect. Continued use of
the service after a change takes effect constitutes acceptance.

## 12. Governing law and dispute resolution

These terms are governed by the laws of the Province of Ontario and the
applicable laws of Canada, without regard to conflict-of-laws rules.
Each party submits to the exclusive jurisdiction of the courts of
competent jurisdiction in the Province of Ontario for any dispute
arising out of or in connection with these terms or the service.

If you are a consumer resident in a jurisdiction whose mandatory
consumer-protection laws grant you broader rights, those rights
prevail.

## 13. Contact

- General contact and support: the email address on the public site's
  footer.
- Security disclosure: see `SECURITY.md` for the responsible-disclosure
  contact and timeline.

## 14. Document version

This is the placeholder draft dated 2026-07-13 (version 0.3, marked
"placeholder, lawyer review pending"). Version 0.3 scopes the pricing,
billing, and refund clause to the billing flow that ships today (monthly,
per-cycle payment link, no stored payment instrument, no automatic
renewal) and keeps the Ontario governing-law and jurisdiction terms. The
note at the top of this file restates the same caveat for any reader who
skipped the preamble. A reviewed version will replace this file in a
future release. Older versions remain in the git history of this
repository for reference. The PR that lands the reviewed version will
reference this document by commit hash for an unambiguous audit trail.
