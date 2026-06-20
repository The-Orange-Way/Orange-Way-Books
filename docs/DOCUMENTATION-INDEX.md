# Orange Way Books — Documentation index

**Purpose:** Single map of where to read what, how ZKA is used in this repo, and which database objects matter. Use this when onboarding or after parallel agent work.

---

## Words that sound alike (plain language)

| Term in docs | What it means here |
|--------------|-------------------|
| **ZKA (Zero-Knowledge Architecture)** | The product design: sensitive fields are encrypted **in the browser** before they reach Supabase. The vault password never goes to the server. |
| **ZKP (Zero-Knowledge Proof)** | Cryptographic proofs (snarkjs, circom, etc.). **Not implemented yet.** |
| **"True ZKA"** | In strict math terms, only ZKPs are "zero-knowledge proofs." This app's story is better described as **client-side encryption** with the server holding ciphertext and structural metadata only. |

---

## Source of truth (read in this order)

0. **`README.md`** (repo root) — Story, positioning, and quick start.
1. **`SECURITY.md`** — Threat model, encryption stack, what the server sees.
2. **`docs/CONTRIBUTING.md`** — Canonical commit + PR format and the hard rules.
3. **`docs/OWB-MultiCurrency-Brain.md`** — Multi-currency system reference: three-currency model (IAS 21 / ASC 830), rate pinning, FX revaluation, functional currency change, translation methods.
4. **`docs/OWB-USER-MANAGEMENT-ZKA.md`** — Multi-user key sharing and roles (DEK, KEM wrap, revoke, custody).
5. **`supabase/migrations/*.sql`** — **Authoritative** for Postgres tables, columns, RLS, and triggers (generated clients must match these).

- **`docs/OWB-RESEARCH-NOSTR-AUTH.md`** — Research (parked): optional Nostr auth vs Supabase `auth.uid()` / RLS.

---

## Supabase: tables created in migrations

These are the **`public.*` tables** introduced by migrations in this repo (run `supabase db diff` / reset locally to verify your database matches):

| Table | Role |
|-------|------|
| `organizations` | Org row; **`name` is encrypted at rest** when `key_version >= 2`; decrypt in UI with `decryptOrganization`. |
| `org_members` | User ↔ org membership and role. |
| `org_settings` | Org prefs; includes `vault_verifier` and encrypted fiscal fields. |
| `chart_of_accounts` | Fully-encrypted chart of accounts. All metadata is `encrypted_*` (name, code, description, account type, sub-type, is-group, is-system, is-archived, allowed currencies); structural columns are `id`, `org_id`, `parent_id`, `opened_at`, `closed_at`, `key_version`. |
| `wallets` | Wallets; encrypted names; encrypted balance. |
| `transactions` | Operational tx rows; encrypted amount/USD/rate columns; `linked_transfer_id`. |
| `contacts` | Contacts; encrypted PII columns with `key_version`. |
| `journal_entries` / `journal_entry_lines` | Manual JE path; encrypted numeric columns. |
| `attachments` | File metadata (encrypted names/mime); storage objects are ciphertext. |
| `audit_logs` | Encrypted audit snapshots. |
| `connectors` | Third-party connectors; encrypted config. |
| `payment_requests` | Payment request workflow. |
| `exchange_rates` | Rate table (RLS + service role writes via Edge Function). |

**Keeping TypeScript in sync:** After migration changes, regenerate `src/integrations/supabase/types.ts` (e.g. `supabase gen types typescript --linked` or your project's equivalent).

---

## Open-source documentation rule

**Do not commit** production Supabase project refs, anon/service keys, API keys, or machine SSH hosts. Use placeholders (`YOUR_PROJECT_REF`, etc.) in repo docs. Keep a **private** runbook (Notion, encrypted notes, or ops vault) for real values.

---

## Plaintext vs encrypted (practical checklist)

| Kind of data | At rest (Supabase PG) | Who can read it |
|--------------|------------------------|-----------------|
| Vault password | Never stored | User only |
| MEK | Never stored; browser memory when unlocked | User session only |
| User email | Supabase Auth (plaintext in auth schema) | Auth + user |
| Org display name | Ciphertext in `organizations.name` when `key_version >= 2` | Browser after unlock |
| Account / wallet / contact / tx descriptions | Ciphertext in app tables | Browser after unlock |
| Transaction dates | Plaintext `date` columns | Anyone with DB read |

---

## When you change behavior, update

| Change | Update these |
|--------|----------------|
| New / renamed DB table or column | New migration **and** regen Supabase TS types **and** a line in this index if the table is user-facing. |
| Encryption coverage | `SECURITY.md` "what the server sees" table. |
