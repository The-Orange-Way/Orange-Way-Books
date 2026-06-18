# Orange Way Books — Documentation index

**Purpose:** Single map of where to read what, how “ZKA” is used in this repo, database objects, and vendored ledger fork status. Use this when onboarding or after parallel agent work.

---

## Words that sound alike (plain language)

| Term in docs | What it means here |
|--------------|-------------------|
| **ZKA (Zero-Knowledge Architecture)** The product design: sensitive fields are encrypted **in the browser** before they reach Supabase or legacy ledger backend; the vault password never goes to the server. |
| **ZKP (Zero-Knowledge Proof)** Cryptographic proofs (snarkjs, circom, etc.). **Not implemented yet** — research outlined under “Level 3” in `docs/OWB-LEVEL2-PATH.md`. |
| **“True ZKA”** In strict math terms, only ZKPs are “zero-knowledge proofs.” This app’s **Level 1 / 2** story is better described as **client-side encryption + split trust** (labels in Supabase, ledger lines in legacy ledger backend), optionally with **blind-mode ledger** so legacy ledger backend stores encrypted amount blobs. |

---

## Source of truth (read in this order)

0. **`README.md`** (repo root) — **Story, positioning, and quick start** for visitors and contributors.
1. **`docs/CONTRIBUTING.md`** — Canonical commit + PR format (WHY not WHAT), hard rules, and post-rewrite clone notes.
2. **`docs/OWB-ZKA-BRIDGE.md`** — Engineering tracks A–D (blind-mode ledger, ledger engine, encryption wiring, user-management pointer) + research index. *(Legacy root `ZKA-BRIDGE-PLAN.md` removed — use this file.)*
3. **`docs/OWB-ARCHITECTURE.md`** — Target Level 2 architecture (browser is the brain).
4. **`legacy/BLIND-MODE.md`** — What the vendored ledger fork changes and how blind journals behave.
5. **`supabase/migrations/*.sql`** — **Authoritative** for Postgres tables, columns, RLS, and triggers (generated clients must match these).

- **`docs/OWB-MultiCurrency-Brain.md`** — **Multi-currency system reference (Part 1 of dual-currency rebuild):** three-currency model (IAS 21 / ASC 830), rate pinning, FX revaluation, functional currency change, translation methods, IFRS vs GAAP, competitor gaps, edge cases, and glossary.

- **`docs/OWB-RESEARCH-NOSTR-AUTH.md`** — **Research (parked → v3.1+):** optional Nostr auth vs Supabase `auth.uid()` / RLS.
- **`docs/OWB-USER-MANAGEMENT-ZKA.md`** — **Track D:** user management + ZKA keys (roles, DEK, RSA wrap, revoke, custody; includes §14 DDL appendix).

---

## Supabase: tables created in migrations

These are the **`public.*` tables** introduced by migrations in this repo (run `supabase db diff` / reset locally to verify your database matches):

| Table | Role |
|-------|------|
| `organizations` | Org row; **`name` is encrypted at rest** when `key_version >= 2` (onboarding sets this); decrypt in UI with `decryptOrganization`. `external_journal_id` is currently a NULL placeholder kept for future external-ledger integrations (renamed from `legacy_journal_id`). |
| `org_members` | User ↔ org membership and role. |
| `org_settings` | Org prefs; includes `vault_verifier` and encrypted fiscal fields (L2). |
| `account_metadata` | Legacy chart path. Phase 1 introduced `chart_of_accounts` as the canonical CoA table; new work goes there. |
| `chart_of_accounts` | Fully-encrypted chart of accounts (post-Phase-1, replaces the dropped `legacy_account_map`). All metadata is `encrypted_*` (name, code, description, account type, sub-type, is-group, is-system, is-archived, allowed currencies); structural columns are `id`, `org_id`, `parent_id`, `opened_at`, `closed_at`, `key_version`. |
| `wallets` | Wallets; encrypted names; optional `external_account_id` (renamed from `legacy_account_id`, currently NULL pending future external-ledger work); encrypted balance (L2 column). |
| `transaction_metadata` | Per-transaction encrypted context. Originally keyed by legacy ledger backend tx id; the `legacy_transaction_id` column is now a legacy placeholder. |
| `transactions` | Operational tx rows; L2 encrypted amount/USD/rate columns; `linked_transfer_id`. |
| `contacts` | Contacts; encrypted PII columns with `key_version`. |
| `journal_entries` / `journal_entry_lines` | Manual JE path; encrypted numeric columns (L2). |
| `attachments` | File metadata (encrypted names/mime); storage objects are ciphertext. |
| `audit_logs` | Encrypted audit snapshots. |
| `connectors` | Third-party connectors; encrypted config. |
| `payment_requests` | Payment request workflow. |
| `exchange_rates` | Rate table (RLS + service role writes via Edge Function). |

**Keeping TypeScript in sync:** After migration changes, regenerate `src/integrations/supabase/types.ts` (e.g. `supabase gen types typescript --linked` or your project’s equivalent). A drifted types file will look like “missing tables” in the editor even when the database is correct.

---

## vendored ledger fork (`legacy/`)

- **Blind mode** is implemented in `the-ledger` / core types; journals can set `blindMode: true`; entries can carry `encrypted_units` / `encrypted_currency` alongside placeholder typed fields. See **`legacy/BLIND-MODE.md`**.
- **GraphQL server in this repo:** `legacy/legacy-server-minimal/` — minimal API used by the app (`journalCreate`, `accountCreate`, `txTemplateCreate`, `transactionPost`, queries). **Build tip:** `SQLX_OFFLINE=true cargo build` from `legacy-server-minimal` when no Postgres is running (sqlx offline data is checked in under `legacy/the-ledger/.sqlx/`).
- **Full `the-ledger` crate:** compile-time `sqlx` macros expect a **live Postgres** (`DATABASE_URL`) unless you use offline mode the same way — CI/docs should state which path you use.

---

## Frontend ↔ legacy ledger backend contract

- Browser calls **`src/lib/legacy-ledger.ts`** → Supabase Edge Function **`supabase/functions/legacy-proxy`** (JWT + org ownership checks) → legacy ledger backend URL with `LEDGER_GRAPHQL_URL` / `LEDGER_API_KEY`.
- Onboarding creates a **blind** journal and **ZKA_*** tx templates whose `units` / `currency` CEL params are **strings** (encrypted blobs from `encryptText` in `Transactions.tsx`).

---

## Open-source documentation rule

**Do not commit** production Supabase project refs, anon/service keys, legacy ledger backend URLs, API keys, or machine SSH hosts. Use placeholders (`YOUR_PROJECT_REF`, `https://YOUR-CALA-HOST/...`) in repo docs. Keep a **private** runbook (Notion, encrypted notes, or ops vault) for real values. The exception is preview URLs from the hosting provider if they are intentionally public — still avoid embedding **keys**.

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
| legacy ledger backend journal lines | Depends on deployed legacy ledger backend: blind journal + encrypted params vs legacy | See `legacy/BLIND-MODE.md` |

---

## When you change behavior, update

| Change | Update these |
|--------|----------------|
| New / renamed DB table or column | New migration **and** regen Supabase TS types **and** a line in this index if the table is user-facing. |
| legacy ledger backend GraphQL or blind rules | `legacy/BLIND-MODE.md`, `docs/OWB-ZKA-BRIDGE.md` Track A, and any onboarding template in `OnboardingWizard.tsx`. |
| Encryption coverage | `docs/OWB-ZKA-BRIDGE.md` Track C + `docs/OWB-ARCHITECTURE.md` “what’s encrypted” table. |

---

*Last reviewed: stubs removed; bridge doc expanded.*
