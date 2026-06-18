# Orange Way Books — ZKA bridge plan (engineering tracks)

> **Pitch:** Orange Way Books: Open-source accounting where not even the developer can see your books. Self-host it, audit the code, own your data.  
> Tracks for ledger storage, ledger engine, encryption wiring, and user management.

**GitHub:** `The-Orange-Way/Orange-Way-Books`  
**License:** Open source (Apache 2.0)

---

## Goal

Move from “server could read books” to **full ZKA posture**: the browser validates and encrypts before data leaves the device; Supabase and legacy ledger backend hold ciphertext and structure; servers do not see readable financial data — only dates, UUIDs, and wrapped keys where applicable.

---

## Architecture principle

The **browser** is the authority: it validates balanced entries and valid amounts/currencies **before** encrypting. **Track A** lets legacy ledger backend store encrypted blobs for blind journals. **Track B** runs accounting math in the browser. **Track C** encrypts Supabase payloads. **Track D** (separate doc) adds multi-user key sharing and roles without breaking that model.

---

## Track A — vendored ledger fork: blind mode (**IN PROGRESS**)

### Context

Orange Way Books encrypts financial fields in the browser before they reach any server. **legacy ledger backend** (the upstream project’s Rust double-entry ledger) evaluates **CEL** in transaction templates and historically **coerced** `units` to `Decimal` and validated `currency` — which **rejects** ciphertext strings.

**Design principle:** The client validates everything **before** encrypting. **Blind mode** on a journal means: *the client already validated — store what it sends.*

### What was tested (conceptual — April 2026)

Against typical legacy ledger backend **0.3.x** GraphQL:

| Area | Plaintext / typed path | Blind path (when implemented) |
|------|-------------------------|-------------------------------|
| Account `name`, `code` | Strings accepted | Same |
| `metadata`, descriptions | JSON / strings | Same |
| Entry **`units`** (amount) | CEL → `Decimal` | Encrypted string must be accepted when `blind_mode` |
| Entry **`currency`** Known currency list | Encrypted string must be accepted when `blind_mode` |
| **`direction`**, **`layer`** GraphQL enums | Often stay **plaintext structural** (minimal leak vs full redesign) |

**CEL flow (simplified):** template says `units: "params.amount"` → runtime coerces param to `Decimal`. Posting `params.amount = "encrypted=="` fails unless blind branch skips coercion.

### Source & fork in this repo

- **Upstream:** [the-upstream-ledger](https://github.com/the-upstream-ledger) (Apache-2.0).  
- **Vendored fork:** `legacy/` in this repository — see **`legacy/BLIND-MODE.md`** and **`legacy/legacy-server-minimal/`** (minimal GraphQL server for Vault).

### What to change (engineering checklist)

1. **Journal model** — `blind_mode: bool` (default `false`); expose `blindMode` on journal create/update in GraphQL.  
2. **CEL / template path** — When `blind_mode`: accept **string** `units` / `currency` (store ciphertext); skip **debit = credit** validation that needs numeric sums.  
3. **Balance queries** — For blind journals, **do not** treat server-side `balance()` as meaningful; document **client-computed** balances via `ledger-engine.ts`.  
4. **Direction / layer** — **Recommendation:** keep enums plaintext initially (Option C); optional later: parallel encrypted fields if product requires it.  
5. **Tests** — Blind ON: encrypted amount/currency posts succeed; blind OFF: legacy Decimal rules unchanged.

### Build & deploy (operators)

- Build fork / `legacy-server-minimal` per **`legacy/DEPLOYMENT.md`**.  
- Set Edge secrets: `LEDGER_GRAPHQL_URL`, `LEDGER_API_KEY`.  
- **CI:** `the-ledger` may need `DATABASE_URL` or `SQLX_OFFLINE=true` — document in CI README.

### Strategic value

Backward-compatible fork (`blind_mode` default **false**). Upstream PR story: *zero-knowledge accounting — client validates, server stores opaque ledger lines.*

### Still needed (short)

1. Documented CI for `the-ledger` (live Postgres vs offline sqlx).  
2. Production E2E: blind journal + `transactionPost` with encrypted template params.  
3. Confirm deployed `serverVersion` matches app expectations.

---

## Track B — Ledger engine (browser-side math) (**DONE**)

### Context

In Level-2-style ZKA, **reports and balances are computed in the browser** after decrypt. legacy ledger backend (when blind) does not return meaningful numeric balances for ciphertext. The ledger module must be **pure math**: no `fetch`, no React, no crypto — only typed inputs → report outputs.

### Repository (this codebase)

| File | Role |
|------|------|
| `src/lib/ledger-engine.ts` | Pure functions: balances, KPIs, P&amp;L, balance sheet, trial balance, GL, cash flow |
| `src/context/VaultContext.tsx` | MEK, `encryptText` / `decryptText` |
| `src/pages/Dashboard.tsx`, `src/pages/Reports.tsx` | Consume decrypted + engine outputs |

Implemented exports include (names may differ from older specs): `computeAccountBalances`, `computeKPIs`, `computeWorkingCapital`, `computeWalletBalances`, `computePnL`, `computeBalanceSheet`, `computeTrialBalance`, `computeGeneralLedger`, `computeCashFlow`, helpers like `journalLineInDateRange`.

### Performance mindset

Filter by **date** at the server where possible; decrypt **only** the page or window of entries needed; then run the engine — target sub-second feel for typical SMB volumes (see architecture doc for checkpoint story).

### Encrypted checkpoints (**future / optional**)

Periodic **encrypted snapshots** of balance maps (`period_end_date` plaintext for query; blob ciphertext) so balance sheet can merge “checkpoint + entries since” without scanning all history. Schema and product approval TBD — align with **`docs/OWB-ARCHITECTURE.md`** and migrations when added.

### ZKA proof / demo page (**future**)

Split view: “server sees” (ciphertext / UUIDs) vs “you see” (decrypted) — education and sales demo; not required for core ledger.

### Do not

- Do not call legacy ledger backend **`balance()`** for blind journals and treat the result as truth.  
- Do not put encryption or network I/O inside `ledger-engine.ts`.

---

## Track C — Encryption wiring (**IN PROGRESS — core done**)

### Context

Crypto primitives (`vault.ts`, `VaultContext`) must wrap **every** sensitive Supabase read/write. **`src/lib/crypto-fields.ts`** is the central per-table encrypt/decrypt layer; remaining work is **systematic audit** of all `supabase.from(...)` calls and `key_version` discipline.

### Schema direction

**Authoritative:** `supabase/migrations/*.sql` in this repo. Migrations added encrypted columns, **`legacy_account_map`**, RLS, etc. Older prompts referenced `chart_of_accounts` / `account_metadata` consolidation — **today’s schema may differ**; always implement against **actual** migrations + regenerated `src/integrations/supabase/types.ts`.

Typical patterns:

- **Encrypt before insert/update** — sensitive strings → ciphertext + `key_version` (e.g. 2).  
- **Decrypt after select** — use `crypto-fields` helpers; handle legacy `key_version` 0/1.  
- **Do not encrypt** — primary keys, `org_id`, dates used for filtering, structural enums where product keeps them plaintext.

### CSV / import deduplication

Encrypted fields get a **new IV per encryption** — two encryptions of the same name are **different strings**. Dedup must **decrypt then compare** (or compare deterministic business keys), not compare raw ciphertext.

### Edge functions

**`legacy-proxy`** is the supported path for legacy ledger backend GraphQL from the browser. Any legacy `legacy-create-account` / `legacy-create-transaction` ideas: **do not send human-readable names or memos** to legacy ledger backend; use opaque IDs; amounts/currency follow blind template contract when blind mode is on.

### Key rules

- `key_version` consistent per table policy.  
- Dates stay plaintext for server-side filters where required.  
- Regenerate TypeScript DB types after migration changes.

---

## Track D — User management & role-scoped keys (**PLANNED**)

**Canonical spec:** **`docs/OWB-USER-MANAGEMENT-ZKA.md`** (includes appendix DDL sketches).

Multi-user ZKA: per-org DEK, RSA-OAEP wrapping for invites, additive roles, soft vs hard revoke, optional custody / support sessions.

---

## Research (not committed to roadmap dates)

| Doc | Topic |
|-----|--------|
| **`docs/OWB-RESEARCH-NOSTR-AUTH.md`** Optional Nostr login (parked → v3.1+); `auth.uid()` / RLS; phased link-then-sign-in. |

---

## References

- `docs/DOCUMENTATION-INDEX.md` — full doc map  
- `docs/OWB-ARCHITECTURE.md` — Level 2 narrative  
- `docs/OWB-USER-MANAGEMENT-ZKA.md` — Track D  
- `legacy/BLIND-MODE.md` — blind journal semantics  
- `legacy/DEPLOYMENT.md` — operator deploy
