# Orange Way Books — The Path to Level 2 (Full ZKA)

> 

---

## Where We Are (Level 1)

Level 1 encrypts the CONTEXT (who, what, why) but leaves the NUMBERS visible to legacy ledger backend:

- **Encrypted:** Account names, transaction descriptions, contact names, receipts
- **Plaintext:** Amounts, account codes (sequential pattern A1XXX), balances
- **Who does the math:** legacy ledger backend (server-side)

This is enough for the MVP and the the upstream project pitch. But it's not the north star.

---

## Where We're Going (Level 2)

Level 2 encrypts EVERYTHING. The server stores only encrypted blobs. The browser does all the math.

- **Encrypted:** Everything — amounts, account codes, names, descriptions, receipts
- **Plaintext:** Dates, UUIDs, and **user email** (auth). **Org display name** is ciphertext in Postgres (L2); the app decrypts it in the sidebar after vault unlock — not readable by operators from the DB alone without the MEK.
- **Who does the math:** Your browser (client-side)

---

## What Needs to Be True for Level 2

There are 5 things that must be built or changed. Each one is independent — they can be done in any order. Level 2 is "done" when all 5 are complete.

---

### 1. Client-Side Computation Engine

**What it is:** A JavaScript module that runs in the browser and does all the accounting math that legacy ledger backend currently does.

**Why it's needed:** If amounts are encrypted, legacy ledger backend can't add them up. Someone has to — and the only place with the decryption key is the browser.

**What it does:**
- Downloads all encrypted journal entries from legacy ledger backend/Supabase
- Decrypts each entry in the browser (using the MEK)
- Calculates: account balances, P&L, Balance Sheet, trial balance, general ledger
- All computation happens in browser memory — results never sent to any server

**Technical challenge:** For a business with 10,000 transactions, the browser downloads and decrypts 10,000 entries. This takes maybe 2-3 seconds on a modern laptop. For 100,000 transactions, maybe 20-30 seconds. Beyond that, we'd need a Web Worker (background thread) to avoid freezing the UI.

**What needs to be built:**
- `src/lib/ledger-engine.ts` — pure functions: `calculateBalance()`, `generatePnL()`, `generateBalanceSheet()`, `generateTrialBalance()`
- These functions take decrypted entries as input and return report data
- They replace the current flow of "ask legacy ledger backend for balances"

**Estimated effort:** 2-3 weeks (including testing)

**Prerequisites:** None — can be built now alongside Level 1

---

### 2. Encrypted Amounts in Storage

**What it is:** Instead of storing `$5,000` as a number, store it as `encrypted_blob` alongside the other encrypted fields.

**Why it's needed:** Level 1 stores amounts in plaintext in legacy ledger backend. Level 2 encrypts them.

**What changes:**
- Browser encrypts the amount before sending to storage
- Storage format: `{ encrypted_amount: "base64...", encrypted_currency: "base64...", encrypted_date: "base64..." }`
- legacy ledger backend no longer receives amounts at all — it receives encrypted blobs
- Or: we stop using legacy ledger backend's journal entry API and store encrypted entries directly in Supabase

**The legacy ledger backend decision:**
Two options for Level 2:

**Option A: Keep legacy ledger backend as encrypted blob storage**
- legacy ledger backend stores entries where amount = encrypted string
- legacy ledger backend cannot calculate balances (amounts are gibberish to it)
- We use legacy ledger backend purely for its immutable event log and double-entry structure
- Pro: Keep the the upstream project relationship, use legacy ledger backend's infrastructure
- Con: Using legacy ledger backend for something it wasn't designed for

**Option B: Move everything to Supabase**
- Stop using legacy ledger backend entirely
- Store encrypted journal entries in Supabase tables
- Browser downloads, decrypts, and calculates
- Pro: Simpler architecture (one database, not two)
- Con: Lose legacy ledger backend's double-entry guarantees, lose the the upstream project connection

**Recommendation:** Option A. Keep legacy ledger backend. Use its data model for structure even if it can't do math. The the upstream project relationship has strategic value beyond the technology.

**Estimated effort:** 1 week

**Prerequisites:** Client-Side Computation Engine (#1) must exist first — you need something to replace legacy ledger backend's calculation role

---

### 3. Random UUIDs for Account Codes

**What it is:** Replace the sequential codes (A1001, A1002) with random UUIDs so the server can't even guess the account type.

**Why it's needed:** Level 1 codes leak account type (A1XXX = assets). Level 2 hides everything.

**What changes:**
- Account creation generates `crypto.randomUUID()` instead of `A1001`
- The mapping `UUID → account type` is encrypted and stored in Supabase's `account_metadata`
- legacy ledger backend sees: `550e8400-e29b-41d4-a716-446655440000` — no pattern to decode
- Account type (asset, liability, etc.) is needed for debit/credit rules — stored encrypted client-side

**Estimated effort:** 2-3 days

**Prerequisites:** None — can be done now, even at Level 1

---

### 4. Encrypted Date and Currency

**What it is:** Currently dates and currency codes are plaintext. Level 2 encrypts them too.

**Why it's needed:** Dates reveal transaction timing (someone analyzing the database could see "this org had 50 transactions in March" even without amounts). Currency codes reveal what currencies the org uses.

**What changes:**
- Dates encrypted before storage
- Currency codes encrypted before storage
- For sorting/filtering by date: store an encrypted "date bucket" (e.g., encrypted month-year) that allows rough ordering without revealing exact dates
- Or: download everything and sort client-side (simpler but slower)

**Technical challenge:** If dates are encrypted, you can't query "show me transactions from March 2026" on the server. You either:
- Download ALL transactions and filter in the browser (works for <100K entries)
- Use order-preserving encryption (OPE) — reveals ordering but not values
- Use encrypted date buckets — `encrypted("2026-03")` as a filterable field

**Recommendation:** For Level 2, start with "download all, filter client-side." Only optimize if performance is a problem.

**Estimated effort:** 1 week

**Prerequisites:** Client-Side Computation Engine (#1) — you need client-side filtering to replace server-side queries

---

### 5. Migration System (key_version Upgrade)

**What it is:** A system to re-encrypt existing data when upgrading from Level 1 to Level 2.

**Why it's needed:** Existing Level 1 users have amounts stored in plaintext. When they upgrade to Level 2, those amounts need to be encrypted.

**How it works:**
1. User opens the app after the Level 2 upgrade
2. Browser detects `key_version = 1` rows (Level 1 data)
3. Browser downloads all Level 1 entries
4. Browser encrypts the plaintext amounts with the MEK
5. Browser writes back encrypted entries with `key_version = 2`
6. Old plaintext amounts are deleted from legacy ledger backend
7. Migration progress bar shown to user ("Upgrading your vault security...")

**Important:** This is a one-way migration. Once data is re-encrypted at Level 2, there's no going back to Level 1 without the vault password.

**Estimated effort:** 1-2 weeks (including rollback safety)

**Prerequisites:** All of the above (#1-#4) must be complete first

---

## The Order of Operations

```
LEVEL 1 (NOW - MVP)
  ↓
#3: Random UUIDs (can do anytime, quick win)
  ↓
#1: Client-Side Computation Engine (biggest piece, start early)
  ↓
#2: Encrypted Amounts (needs #1 first)
  ↓
#4: Encrypted Dates + Currency (needs #1 first)
  ↓
#5: Migration System (needs all of the above)
  ↓
LEVEL 2 (FULL ZKA)
```

---

## Timeline Estimate

| Phase | What | Weeks | Depends On |
|-------|------|-------|-----------|
| **Now** MVP with Level 1 | ✅ Done | — |
| **Month 1** Random UUIDs (#3) | 0.5 weeks | Nothing |
| **Month 1-2** Client-Side Computation Engine (#1) | 2-3 weeks | Nothing |
| **Month 2** Encrypted Amounts (#2) | 1 week | #1 |
| **Month 2-3** Encrypted Dates + Currency (#4) | 1 week | #1 |
| **Month 3** Migration System (#5) | 1-2 weeks | #1-#4 |
| **Month 3** Testing + Security Audit | 2 weeks | #1-#5 |
| **Month 4** **Level 2 Launch** — | All |

**Total: ~3-4 months from Level 1 to Level 2**, working full-time. With funding and a second developer, potentially 2 months.

---

## What Level 2 Means for Customers

**For the Cypherpunk:**
> "Even if someone takes our server, all they get is encrypted noise. Not just the names — the amounts, dates, everything. The only place your financial data exists in readable form is your device."

**For the Business Owner:**
> "Level 2 means even we can't see your revenue numbers. We can't tell a judge how much money you make. We literally don't know."

**For the Enterprise CFO:**
> "Level 2 meets the highest standard of data privacy. Your financial data is encrypted end-to-end. We can provide a security architecture document for your compliance team."

**For the upstream project:**
> "legacy ledger backend is so well-architected that it works as encrypted storage for a zero-knowledge accounting system. That's a unique capability no other ledger engine can claim."

---

## What Level 2 Does NOT Solve (That's Level 3)

- **Proving your books balance without revealing numbers** → requires zero-knowledge proofs (ZKP)
- **Multi-party audits** → requires multi-party computation (MPC)
- **Hiding that transactions exist** → requires homomorphic encryption or oblivious storage

Level 3 is research-grade cryptography. Level 2 is practical and achievable with current technology.

---


*This is a technical roadmap, not a commitment. Timeline estimates assume dedicated development resources.*
