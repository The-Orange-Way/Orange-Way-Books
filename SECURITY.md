# Orange Way Books -- Security Architecture

Orange Way Books stores only ciphertext. Your financial data, amounts,
account names, wallet names, contact names, memos, currencies, is encrypted
in your browser before it reaches Supabase. We have no key. Neither does
Supabase.

Think of it as a safe-deposit box at a bank: the bank holds the box and
keeps it safe. Only you have the key. The bank cannot open it, cannot be
compelled to open it, and could not open it even if every employee tried.

> **Note on this document.** Earlier revisions of this file described
> three vault format versions (v1 / v2 / v3). The product never shipped
> the v2 or v3 narratives in production; an internal collapse of the key
> derivation registry to a single entry simplified the threat model. This
> rewrite reflects the v1-only reality and moves the post-quantum layer
> out of "Coming" into "Shipped." If you read an older copy that claimed
> "Argon2id v3 is recommended over v2/v1", that copy was inaccurate.

---

## Encryption stack

### Layer 1 -- Password to key (Argon2id KDF)

A single key derivation function (KDF) is in use across the product.
Argon2id is a memory-hard password-hashing algorithm, winner of the
2015 Password Hashing Competition (PHC).

| Setting          | Value                               |
| ---------------- | ----------------------------------- |
| Memory           | 64 MiB per attempt                  |
| Iterations       | 3                                   |
| Parallelism      | 4 threads                           |
| Salt             | Per-org random 32-byte salt         |
| Output           | 256-bit Master Encryption Key (MEK) |
| Minimum password | 14 characters                       |

The 64 MiB / 3 / 4 parameters match the OWASP 2023 recommendation and the
upstream Argon2 RFC 9106 second-choice profile. The KDF registry inside
`src/lib/vault.ts` is set up so a future tuning lands as one appended
entry, without touching consumers.

**Crack-time orientation (single RTX 4090, order-of-magnitude):**

| Password    | Argon2id (this product) |
| ----------- | ----------------------- |
| 4 EFF words | ~19 years               |
| 5 EFF words | ~200 million years      |

These numbers are rough estimates, not guarantees. A 4-word passphrase
is breakable in days by a nation-state with thousands of GPUs; a 5-word
passphrase is effectively unbreakable today against any known adversary.
We recommend 5 words or more, and the in-app strength meter (zxcvbn-ts)
will nudge you there.

### Layer 2 -- Data encryption (AES-256-GCM)

Every `enc_*` column in the Supabase database uses **AES-256-GCM**
(Authenticated Encryption with Associated Data, GCM mode):

- 96-bit random initialisation vector (IV) generated fresh for every
  encrypt call.
- 128-bit authentication tag, tampered data is rejected before any
  plaintext is returned.
- Format: `base64(iv[12] + ciphertext + auth_tag[16])`.

AES-256-GCM is the same algorithm the NSA approves for TOP SECRET
workloads under its Commercial National Security Algorithm (CNSA) suite.
The OWB build is not FIPS-validated; the algorithm choice and key
management are what they would be in a FIPS module.

### Layer 3 -- MEK wrapping (random key, KEK-wrapped)

The password-derived key never encrypts your data directly. The vault
generates a random 256-bit Master Encryption Key (MEK) and wraps it with
a Key Encryption Key (KEK) derived from your password via Argon2id. Two
practical consequences:

- Password rotation re-wraps the MEK in milliseconds instead of
  re-encrypting every row in your books.
- The MEK is independent of the password's strength; the password's job
  is only to protect the wrap.

### Layer 4 -- Per-org random salt

A per-org random 32-byte salt is stored in `org_settings.vault_salt`.
This means:

- Rainbow tables computed against one org are useless against any other.
- Two orgs using identical passwords have completely independent MEKs.
- Salt rotation (future) rotates the derived key without a password
  change.

### Layer 5 -- Hybrid post-quantum key material

For multi-user orgs and inter-service messages, OWB pairs classical
X25519 with the post-quantum Key Encapsulation Mechanism (KEM)
ML-KEM-768, and signs with the post-quantum Digital Signature Algorithm
(DSA) ML-DSA-65. The classical and post-quantum shares are combined via
HKDF-SHA-256 so the result is at least as strong as the stronger of the
two.

This protects long-lived data keys against an adversary who records
ciphertext today and decrypts it years from now on a quantum computer
("harvest now, decrypt later"). When NIST issues revised parameter
guidance, the registry pattern lets us bump the ML-KEM level without
touching consumers.

The post-quantum implementation is shipped but has not been
independently audited. Reviewing `src/lib/key-wrapping.ts`,
`src/lib/pqc.ts`, and `src/lib/signing-key.ts` is one of the highest-
value places an outside cryptographer can contribute.

### Layer 6 -- Zero server knowledge

The server stores `enc_*` columns. It has no key and no way to decrypt.
Dates are stored plaintext for filtering. Everything else, amounts,
names, descriptions, currencies, account types, is ciphertext only.

---

## What the server sees

| Field               | Server stores          | Server can read            |
| ------------------- | ---------------------- | -------------------------- |
| Org name            | AES-256-GCM ciphertext | Never                      |
| Transaction amount  | AES-256-GCM ciphertext | Never                      |
| Contact name        | AES-256-GCM ciphertext | Never                      |
| Wallet name         | AES-256-GCM ciphertext | Never                      |
| Account type        | AES-256-GCM ciphertext | Never                      |
| Currency            | AES-256-GCM ciphertext | Never                      |
| Transaction date    | Plaintext              | Yes (needed for filtering) |
| Your vault password | Never transmitted      | Never                      |

**Example of what Supabase stores for a single transaction row:**

```
enc_amount:      "aB3kL9mP2qR7wQ4nX1jZ8vY5cD6fE0hT"
enc_description: "zR7wQ4nX1jZ8vY5cD6fE0hTaB3kL9mP"
date:            "2026-04-18"
```

To an attacker who breaches the database, the encrypted bytes are
indistinguishable from random noise. See the next section for known
limitations on what an attacker could still infer.

---

## Known limitations

The encryption stack protects the content of every field. It does not
hide some structural facts an observer of the database can still see.

- **Ciphertext length correlates with plaintext length.** Amounts are
  encrypted as their stringified decimal representation, so a row with a
  $4 transaction has a slightly shorter `enc_amount` than a row with a
  $4,200,000 transaction. Fixed-width amount encoding is on the roadmap
  (see Future).
- **Transaction dates are plaintext.** A database breach reveals when an
  org was active; combined with the org's identity it can disclose
  business-rhythm patterns. We accepted this trade-off so reports can
  filter by date server-side without round-tripping every row.
- **Row counts are plaintext.** An attacker can see how many transactions
  an org has, even though they cannot read any of them.

These are deliberate trade-offs called out so an auditor or a customer
reading the doc can decide whether they materially affect their threat
model.

---

## Vault format

The vault is at format version 1: Argon2id KDF (parameters above),
per-org random salt, random 256-bit MEK wrapped by the password-derived
KEK, AES-256-GCM field encryption, hybrid X25519 + ML-KEM-768 KEM with
ML-DSA-65 signatures for the multi-user / inter-service surfaces. The
single-version posture is deliberate: by collapsing the KDF registry to
one entry we removed a class of vault-state lock-outs where an
out-of-date client could persist a version the current code refuses to
unlock. Future upgrades to memory or iteration parameters land as a
single appended entry without touching consumers.

---

## Recovery

Vault recovery uses a 12-word recovery code drawn from the BIP-39
English wordlist (2048 words). Twelve words at 11 bits each give 132
bits of fully random entropy. The code is generated in your browser at
vault setup and shown once only.

The phrase uses the same words as a Bitcoin wallet seed phrase but is
**not** a BIP-39 mnemonic: there is no checksum word, and the phrase
cannot be imported into a Bitcoin wallet. It is used as HKDF key
material to unlock the vault.

**Important: Orange Way Books cannot recover, reset, or escrow this
code.** If you lose both your password and your recovery code, the data
is unrecoverable by design. The same property is what gives the ZKA
guarantee its weight: we cannot decrypt your books even if we wanted to,
and we cannot help an attacker who has compromised one factor unlock
your vault using a stored second factor.

The recovery code is an **independent** unlock path, not a 2-factor
add-on. Either the password OR the recovery code is sufficient to derive
the MEK wrapping key. They are not combined.

In multi-user orgs, each user also has a personal master recovery code
that unlocks all orgs that user belongs to, using a per-user salt so the
same 12 English words produce different keys for different users.

---

## Data-subject rights

The encryption posture is designed to support each of the standard
data-subject rights without server-side decryption:

- **Right to access / portability (GDPR Art. 15 / Art. 20).** A
  signed-in user can export their full plaintext takeout from the Admin
  panel; the export decrypts client-side and the server never sees the
  plaintext.
- **Right to erasure (GDPR Art. 17 / Law 25 s.28.1).** Deleting the
  org's `org_settings.vault_salt` row and the wrapped MEK renders every
  remaining `enc_*` ciphertext for that org cryptographically
  irrecoverable. This is "crypto-shredding" and it satisfies erasure
  without requiring per-row deletion across every table.

---

## Sub-processors and data residency

Orange Way Books uses Supabase as the database, authentication, file
storage, and edge-function provider; Cloudflare Pages as the static
frontend host; Resend for transactional email; and a self-hosted
Chatwoot instance at `support.orangeway.app` for the optional in-app
live-chat widget. All four are sub-processors under GDPR / Law 25.
Customers are notified of any change to this list. The choice of region
for each project is recorded in the project settings of each environment.

Chat content sent through the Chatwoot widget is plaintext to the
operator and is explicitly NOT in the zero-knowledge scope. The
encryption-at-rest guarantee covers stored books-data only. Customers
who do not want operator-readable chat should not open the widget.

---

## What is and is not in scope

### Shipped

- Argon2id KDF (OWASP 2023 parameters), random 32-byte MEK wrapped by
  the password-derived KEK so password rotation re-wraps the MEK instead
  of re-encrypting every row.
- KDF registry (single entry today, open for future parameter bumps).
- zxcvbn-ts strength meter + EFF passphrase generator on vault setup.
- Security tab in Admin panel showing current version.
- Hybrid X25519 + ML-KEM-768 KEM and ML-DSA-65 signatures for multi-user
  invite wraps and signed mutations. Implementation shipped; not yet
  independently audited.
- 12-word recovery code (BIP-39 English wordlist, 132 bits of entropy,
  no BIP-39 checksum, not wallet-importable) + per-user-salted master recovery code.
- Client-side takeout export (Art. 15 / Art. 20 portability).
- Test suite: KDF round-trip, verifier, tamper rejection, wrong-password
  rejection.

### Future

- Fixed-width amount encryption so ciphertext length stops correlating
  with plaintext magnitude.
- Role-scoped data keys (per-recipient key wrapping for multi-member
  orgs).
- Hardware key (FIDO2 / WebAuthn) as a second unlock factor.
- ML-KEM-1024 upgrade path when NIST issues revised parameter guidance.
- Salt rotation without password change.

---

## How contributors can help

**1. Independent audit of the post-quantum layer.**
`src/lib/key-wrapping.ts`, `src/lib/pqc.ts`, `src/lib/signing-key.ts`.
Look for: hybrid combiner soundness, IV reuse scenarios, key material
in error messages, missing tamper detection on specific field types.

**2. Argon2id unlock benchmarks on mobile.**
Measure 64 MiB / 3 iteration unlock latency on mid-range Android
(Snapdragon 7 Gen 1) and iOS (A15 Bionic). If it causes a visible pause,
add a Web Worker offload for the Argon2id computation.

**3. Field-level audit of the encryption helpers.**
`src/lib/vault.ts`, `src/lib/crypto-fields.ts`. Look for: any field that
could have been encrypted but is plaintext for legacy reasons; any
plaintext that could leak into a log line or error message.

**4. Passphrase wordlist coverage.**
Current EFF short list yields ~51 bits per 4 words. The EFF long list
(7,776 words, 12.9 bits/word) gives a small strength increase with no
UX cost.

---

## Security disclosure

Found a vulnerability? Please do not open a public GitHub issue. Email
the maintainers directly. We target 72-hour acknowledgment and 90-day
coordinated disclosure. The maintainer-contact list and the canonical
disclosure address are kept current in `SECURITY.md` at the repo root.
