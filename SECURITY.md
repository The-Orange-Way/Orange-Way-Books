# Orange Way Books -- Security Architecture

Orange Way Books stores only ciphertext. Your financial data -- amounts, account
names, wallet names, contact names, memos, currencies -- is encrypted in your
browser before it reaches Supabase. We have no key. Neither does Supabase.

Think of it as a safe-deposit box at a bank: the bank holds the box and keeps
it safe. Only you have the key. The bank cannot open it, cannot be compelled
to open it, and could not open it even if every employee tried.

---

## Encryption stack

### Layer 1 -- Password to Key

Orange Way Books supports three key derivation versions. New vaults use v3.
Existing vaults can opt in to v3 via Settings -> Security.

**Version 3: Argon2id (current, new vaults)**

Argon2id is a memory-hard KDF -- winner of NIST's Password Hashing Competition.

| Setting          | Value                         |
| ---------------- | ----------------------------- |
| Memory           | 64 MiB per attempt            |
| Iterations       | 3                             |
| Parallelism      | 4 threads                     |
| Output           | 256-bit Master Encryption Key |
| Minimum password | 14 characters (new vaults)    |

**Version 2: PBKDF2-SHA256 (existing vaults, still secure)**

PBKDF2 at 310,000 iterations with a per-org random salt. Not memory-hard,
but very strong with a good password. Upgrade to v3 is recommended.

**Version 1: PBKDF2-SHA256 (legacy, upgrade strongly recommended)**

PBKDF2 at 310,000 iterations with a deterministic salt (userId only).
Precomputation is theoretically possible for a targeted attack. Please upgrade.

**Crack-time comparison (single RTX 4090):**

| Password                       | PBKDF2 v1/v2      | Argon2id v3        |
| ------------------------------ | ----------------- | ------------------ |
| 4 EFF words                    | ~2 years          | ~19 years          |
| 5 EFF words                    | ~20 million years | ~200 million years |
| Nation-state 10k GPUs, 4 words | ~17 hours         | ~7 days            |

With a 5-word EFF passphrase, both versions are effectively unbreakable
today. Argon2id v3 raises the ceiling by 10x and future-proofs against
improving GPU hardware.

### Layer 2 -- Data encryption (AES-256-GCM)

Every `enc_*` column in the Supabase database uses **AES-256-GCM**:

- 96-bit random IV generated fresh for every encrypt call
- 128-bit authentication tag -- tampered data is rejected before any plaintext
  is returned
- Format: `base64(iv[12] + ciphertext + auth_tag[16])`

AES-256 is what the US government uses for top-secret data. Brute-forcing
a 256-bit key requires more operations than atoms in the observable universe.

### Layer 3 -- Per-org random salt

Vault v2 and v3 use a per-org random 32-byte salt stored in
`org_settings.vault_salt`. This means:

- Rainbow tables computed against one org are useless against any other
- Two orgs using identical passwords have completely independent MEKs
- Salt rotation (future) rotates the derived key without a password change

### Layer 4 -- Zero server knowledge

The server stores `enc_*` columns. It has no key and no way to decrypt.
Dates are stored plaintext for filtering. Everything else -- amounts,
names, descriptions, currencies, account types -- is ciphertext only.

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

**Example -- what Supabase literally stores for a $4,200 transaction:**

```
enc_amount:      "aB3kL9mP2qR7wQ4nX1jZ8vY5cD6fE0hT"
enc_description: "zR7wQ4nX1jZ8vY5cD6fE0hTaB3kL9mP"
date:            "2026-04-18"
```

To an attacker who breaches the database, this is indistinguishable from
random noise.

---

## Vault format

The vault is at format version 1 (Argon2id, OWASP 2023 parameters,
random-MEK wrapping). A KDF strategy registry is in place so future
upgrades to memory/iteration parameters land as a single appended entry
without touching consumers.

---

## Shipped vs. planned

### Shipped

- Argon2id KDF (OWASP 2023 parameters), random 32-byte MEK wrapped by
  the password-derived KEK so password rotation re-wraps the MEK
  instead of re-encrypting every row
- Strategy map for KDF versions (open/closed for future bumps)
- zxcvbn-ts strength meter + EFF passphrase generator on vault setup
- Security tab in Admin panel showing current version
- Test suite: KDF round-trip, verifier, tamper rejection, wrong-password
  rejection

### Coming

- Post-quantum key material (hybrid X25519 + ML-KEM-768 + ML-DSA-65) modeled
  on OrangeRails' implementation. Protects long-lived data keys against
  future quantum computers.

### Future

- Role-scoped data keys (per-recipient key wrapping for multi-member orgs)
- Hardware key (FIDO2/WebAuthn) as second unlock factor
- ML-KEM-1024 upgrade path when NIST issues revised parameter guidance
- Salt rotation without password change

---

## How contributors can help

**1. Hybrid PQC layer**
We need an audited TypeScript implementation of hybrid X25519 + ML-KEM-768
KEM together with ML-DSA-65 signatures, suitable for use from the browser
without WASM. A contribution that ports a vetted reference (Bitwarden,
libsodium-binding, etc.) would land cleanly behind the existing
`encryptInviteWrap` / `signMutation` interfaces.

**2. Argon2id unlock benchmarks on mobile**
Measure 64 MiB / 3 iteration unlock latency on mid-range Android (Snapdragon
7 Gen 1) and iOS (A15 Bionic). If it causes a visible pause, add a Web Worker
offload for the Argon2id computation.

**3. Security audit**

- `src/lib/vault.ts` -- KDF primitives, verifier scheme
- `src/lib/crypto-fields.ts` -- per-table field encrypt/decrypt
- Look for: IV reuse scenarios, key material in error messages, missing tamper
  detection on specific field types

**4. Passphrase word list**
Current EFF word list yields ~51 bits per 4 words. The EFF long list
(7,776 words, 12.9 bits/word) gives a small strength increase with no UX cost.

---

## Security disclosure

Found a vulnerability? Please do not open a public GitHub issue.
Email the maintainers directly. We target 72-hour acknowledgment and
90-day coordinated disclosure.
