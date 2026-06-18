# Orange Way Books — Architecture (Level 2 ZKA)

> **Pitch:** Orange Way Books: Open-source accounting where not even the developer can see your books. Self-host it, audit the code, own your data.
> This replaces the previous architecture document.

---

## What Is Orange Way Books?

Zero-knowledge accounting software. The server stores your financial data but CANNOT read it. Amounts, account names, descriptions, contacts, receipts — everything is encrypted in your browser before it leaves your device. The server stores encrypted blobs. Only your browser, with your vault password, can decrypt and display the real data.

**GitHub:** `The-Orange-Way/Orange-Way-Books`
**License:** Open source (Apache 2.0)

---

## Core Principle: The Browser Is the Brain

The browser does ALL the work:
- Encrypts data before sending to any server
- Decrypts data after fetching from any server
- Calculates all balances, P&L, Balance Sheet, trial balance
- The servers are blind filing cabinets

> **⚠️ Partially obsolete.** This doc was written when legacy ledger backend was the ledger
> backend. Phase 1 replaced `legacy_account_map` with
> `chart_of_accounts`. Phase 3 physically removed the vendored ledger fork
> + legacy-proxy edge function. renamed
> `wallets.legacy_account_id` → `external_account_id` and
> `organizations.legacy_journal_id` → `external_journal_id`. The schema and
> data-flow sections below reflect the pre-Phase-3 shape; ledger math now
> runs in `src/lib/ledger-engine.ts`, not in legacy ledger backend. The migrations in
> `supabase/migrations/` are the authoritative shape.

No server — not Supabase, not the developer — can read, calculate, or understand the financial data.

---

## Architecture Overview

```
YOUR BROWSER (the only place with readable data)
  ├── VaultContext: MEK (Master Encryption Key) in memory
  ├── CryptoService: AES-256-GCM encrypt/decrypt
  ├── LedgerEngine: calculateBalance, generatePnL, generateBalanceSheet
  └── UI: React + Vite + shadcn/ui
         │                              │
         ▼                              ▼
   SUPABASE (Cloud)              CALA (Umbrel-Box)
   Stores:                       Stores:
   - encrypted account names     - encrypted amounts
   - encrypted contacts          - encrypted currency codes
   - encrypted receipts          - random UUID account codes
   - encrypted checkpoints       - dates (plaintext, for filtering)
   - org settings                - debit/credit direction (structural)
   - user auth                   
                                 
   Cannot read anything.         Cannot read amounts or names.
   Cannot calculate.             Cannot calculate.
```

---

## What's Encrypted vs Plaintext

### Encrypted (server sees gibberish)
- Transaction amounts → `encrypted_blob`
- Account names → `encrypted_blob`
- Transaction descriptions/memos → `encrypted_blob`
- Contact names → `encrypted_blob`
- Currency codes → `encrypted_blob`
- Exchange rates → `encrypted_blob`
- Receipt files → `encrypted_blob`
- Balance checkpoints → `encrypted_blob`

### Plaintext (server can see)
- Dates → enables server-side date filtering
- Random UUID account codes → visible but meaningless (no pattern)
- Debit/Credit direction → structural, tells legacy ledger backend which side of the entry
- User email (Supabase Auth) → needed for login; stored by the auth provider, not the vault MEK

### Encrypted at rest but shown in the UI after unlock
- **Organization display name** — stored as ciphertext in `organizations.name` with `key_version >= 2`. The sidebar decrypts in the browser (`decryptOrganization` in `Sidebar.tsx`). The server sees only the ciphertext unless an admin reads the database directly.

### Why Dates Stay Plaintext
If dates were encrypted, the server couldn't filter by date range. You'd have to download ALL entries every time. With plaintext dates, the server returns only "March 2026 entries" — the browser decrypts just those 200 entries instead of 50,000.

Someone analyzing the database can see "this org had 50 transactions in March" but NOT what they were for, how much, or to whom. Transaction timing is not the sensitive part — amounts and business context are.

---

## Two-Password Authentication

### Password 1: Login (Supabase Auth)
- Email + password
- Proves identity
- Standard JWT session
- Can be reset via email

### Password 2: Vault Unlock (Client-Side Only)
- Entered after login on the "Unlock Your Vault" screen
- NEVER sent to server — not even as a hash
- Derives the Master Encryption Key (MEK) via PBKDF2 (310K iterations)
- MEK stored as non-extractable CryptoKey in browser memory
- Closing the tab destroys the MEK

---

## Data Flow: Saving a Transaction

User enters: "Bitcoin Cold Storage, $5,000, Purchased Antminer S21, Compass Mining, rate: 67,000 USD/BTC"

### Step 1: Browser Encrypts Everything
```
"Bitcoin Cold Storage"      → AES-256-GCM → "2wC1VhK9aMW..."
5000                        → AES-256-GCM → "kL9pQm3xR7..."
"Purchased Antminer S21"   → AES-256-GCM → "lCKkyCVj54V..."
"Compass Mining"            → AES-256-GCM → "Xk9pQmR3sT..."
"USD"                       → AES-256-GCM → "m8nBvCx2qW..."
67000                       → AES-256-GCM → "pR4sT7uVwX..."
```

### Step 2: Browser Sends to Two Servers

**To Supabase (encrypted context):**
```json
{
  "org_id": "7817aeb9-...",
  "legacy_tx_id": "ref-to-legacy-entry",
  "encrypted_description": "lCKkyCVj54V...",
  "encrypted_contact": "Xk9pQmR3sT...",
  "key_version": 2
}
```

**To legacy ledger backend via legacy-proxy (encrypted amounts):**
```graphql
mutation {
  postTransaction(input: {
    journalId: "00000000-...",
    effective: "2026-04-15",
    entries: [{
      accountId: "550e8400-...",
      units: "kL9pQm3xR7...",
      currency: "m8nBvCx2qW...",
      direction: "DEBIT",
      layer: "SETTLED",
      entryType: "'DR'"
    }, {
      accountId: "661f9500-...",
      units: "kL9pQm3xR7...",
      currency: "m8nBvCx2qW...",
      direction: "CREDIT",
      layer: "SETTLED",
      entryType: "'CR'"
    }]
  })
}
```

### Step 3: Exchange Rates Stored at Transaction Level
Each transaction can store 2-3 exchange rates as encrypted fields in Supabase:

```json
{
  "encrypted_rate_transactional": "pR4sT7uVwX...",
  "encrypted_rate_functional": "qS5tU8vWxY...",
  "encrypted_rate_reporting": "rT6uV9wXyZ...",
  "rate_date": "2026-04-15"
}
```

The three-currency model:
- **Transactional rate:** The actual rate at the moment of the transaction (e.g., 67,000 USD/BTC)
- **Functional rate:** Conversion to the org's base currency for tax purposes
- **Reporting rate:** Conversion to secondary reporting currency

All rates encrypted. The server cannot see any exchange rate values.

---

## Data Flow: Loading a Report

### P&L (March 2026)
```
Browser → legacy ledger backend: "entries where date BETWEEN 2026-03-01 AND 2026-03-31"
legacy ledger backend → Browser: 200 encrypted entries
Browser → Supabase: "account_metadata for these account UUIDs"
Supabase → Browser: encrypted account names

Browser decrypts 200 entries → gets real amounts
Browser decrypts account names → gets real names
Browser runs ledger-engine.ts → calculatePnL()
Browser displays: "Revenue: $85,000 | Expenses: $50,000 | Net Profit: $35,000"

Time: < 0.5 seconds
```

### Balance Sheet (Today) — Using Checkpoints
```
Browser → Supabase: "latest encrypted checkpoint"
Supabase → Browser: 1 encrypted blob (March 31 snapshot)
Browser → legacy ledger backend: "entries where date > 2026-03-31"
legacy ledger backend → Browser: 150 encrypted entries (April only)

Browser decrypts checkpoint → all balances as of March 31
Browser decrypts 150 entries → April transactions
Browser adds April to March → current balances
Browser displays Balance Sheet

Time: < 0.5 seconds regardless of company age
```

### Transaction List (Paginated)
```
Browser → legacy ledger backend: "entries page 1, 25 per page, newest first"
legacy ledger backend → Browser: 25 encrypted entries
Browser decrypts 25 → displays table
User clicks Next → same with page 2

Time: instant (25 entries per request)
```

### Single Receipt
```
User clicks "View Receipt"
Browser → Supabase Storage: download 1 encrypted file (2 MB)
Browser decrypts → displays PDF/image

Time: 0.5-1 second
Never bulk downloaded.
```

---

## legacy ledger backend's Role: Blind Storage

legacy ledger backend does NOT calculate anything. It provides:

1. **Immutable event log** — entries cannot be modified after posting (audit trail)
2. **Double-entry structure** — every entry has a debit and credit side
3. **Date-based querying** — server filters by plaintext dates
4. **Pagination** — server returns pages of encrypted entries
5. **Storage** — encrypted blobs stored reliably in PostgreSQL

legacy ledger backend sees: random UUIDs + encrypted blobs + dates + debit/credit direction
legacy ledger backend cannot: add balances, generate reports, understand any data

**Why keep legacy ledger backend?**
- the upstream project relationship (funding + co-marketing)
- Immutable audit trail (entries can't be modified)
- Double-entry structure enforced at storage level
- Future: if legacy ledger backend adds homomorphic encryption, we upgrade without rewriting

---

## The Ledger Engine (Browser-Side Math)

File: `src/lib/ledger-engine.ts`

Pure functions — no API calls, no encryption, no React. Just accounting math.

```typescript
interface DecryptedEntry {
  accountId: string;
  accountName: string;
  accountType: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  debit: number;
  credit: number;
  date: string;
  currency: string;
  memo: string;
  exchangeRates: {
    transactional?: number;
    functional?: number;
    reporting?: number;
  };
}

// Core functions:
calculateBalance(entries, accountId, accountType) → number
calculateAllBalances(entries, accounts) → Map<id, balance>
generatePnL(entries, accounts, startDate, endDate) → PnLReport
generateBalanceSheet(entries, accounts, asOfDate) → BalanceSheetReport
generateTrialBalance(entries, accounts) → TrialBalanceReport
generateGeneralLedger(entries, accountId, dateRange) → LedgerReport
```

Each function: loop through entries → filter by date/account → sum debits and credits.
200-300 lines of TypeScript. Unit tested with known inputs and expected outputs.

---

## The Checkpoint System

Solves: "Balance Sheet needs all history, but we don't want to download everything."

At the end of each month (or when the user clicks "Close Period"):
1. Browser downloads all entries for that month
2. Decrypts and calculates final balances for every account
3. Encrypts the balance snapshot as a single blob
4. Stores in Supabase (`encrypted_checkpoints` table)

Next time the Balance Sheet loads:
1. Fetch latest checkpoint (1 blob)
2. Fetch only entries AFTER the checkpoint date
3. Combine → instant Balance Sheet

Even a 10-year-old company with 500K entries loads in under 1 second.

---

## Database Schema

### Supabase Tables

```sql
-- Organizations
organizations (id, name, created_at)

-- Members
org_members (id, user_id, org_id, role, joined_at)

-- Settings (includes vault verifier)
org_settings (org_id, primary_currency, secondary_currency, bitcoin_display,
              date_format, vault_verifier, key_version)

-- Account metadata (encrypted names mapped to legacy ledger backend UUIDs)
account_metadata (id, org_id, legacy_account_id, encrypted_name,
                  encrypted_type, encrypted_description, key_version)

-- Transaction metadata (encrypted context)
transaction_metadata (id, org_id, legacy_tx_id, encrypted_description,
                      encrypted_contact, encrypted_rate_transactional,
                      encrypted_rate_functional, encrypted_rate_reporting,
                      rate_date, receipt_url, key_version)

-- Accounts (UI label since ;
-- DB column name remains `wallets` for backward compat)
wallets (id, org_id, legacy_account_id, encrypted_name, encrypted_asset,
         encrypted_wallet_type, key_version)

-- Contacts (encrypted)
contacts (id, org_id, encrypted_name, encrypted_address, key_version)

-- Encrypted checkpoints (monthly balance snapshots)
encrypted_checkpoints (id, org_id, period_end_date, encrypted_balances,
                       key_version, created_at)

-- Journal entries + lines (local reference)
journal_entries (id, org_id, date, legacy_tx_id, encrypted_memo,
                 encrypted_currency, encrypted_total, ref_num, key_version)
journal_entry_lines (id, journal_entry_id, legacy_account_id,
                     encrypted_debit, encrypted_credit,
                     encrypted_description, sort_order)

-- Chart of accounts
chart_of_accounts (id, org_id, legacy_account_id, encrypted_name,
                   encrypted_type, encrypted_group, encrypted_category,
                   is_archived, sort_order, key_version)

-- Receipts stored in Supabase Storage as encrypted blobs
```

### legacy ledger backend (on Umbrel-Box)

legacy ledger backend stores journal entries with:
- Random UUID account IDs
- Encrypted amount strings (where numbers would normally be)
- Encrypted currency strings
- Plaintext dates (for filtering)
- Debit/Credit direction (structural)

legacy ledger backend's own PostgreSQL at `/home/BB-Vault/`, port 5433.

---

## Encryption Reference

| Property | Value |
|----------|-------|
| Key derivation | PBKDF2, SHA-256, 310,000 iterations |
| Encryption | AES-256-GCM |
| IV | 96-bit, random per operation |
| Output format | base64(IV[12] + ciphertext + auth_tag[16]) |
| MEK storage | Non-extractable CryptoKey in browser memory |
| Key version | `key_version = 2` for all Level 2 data |
| Dependencies | Zero — Web Crypto API only |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React + Vite + TypeScript + shadcn/ui |
| Auth | Supabase Auth (email + password) |
| Cloud database | Supabase (PostgreSQL) |
| Ledger storage | legacy ledger backend (Rust, GraphQL) on Umbrel-Box |
| legacy ledger backend database | PostgreSQL 15 (Docker) on Umbrel-Box |
| Proxy | Supabase Edge Function (legacy-proxy) → Caddy reverse proxy (API key auth + TLS) → legacy ledger backend |
| Encryption | Web Crypto API (AES-256-GCM + PBKDF2) |
| Client computation | ledger-engine.ts (pure TypeScript) |
| Hosting | Static frontend host + self-hosted ledger backend |

---

## File Structure (Key Files)

```
src/
  lib/
    vault.ts              ← AES-256-GCM encrypt/decrypt + PBKDF2 key derivation
    ledger-engine.ts      ← Pure accounting math (P&L, Balance Sheet, etc.)
    legacy.ts               ← GraphQL helper for legacy-proxy Edge Function
    formatters.ts         ← BTC display modes, currency formatting
    supabase.ts           ← Supabase client
  context/
    VaultContext.tsx       ← MEK management, encrypt/decrypt hooks
  pages/
    Dashboard.tsx         ← KPIs from ledger engine
    Accounts.tsx           ← Accounts page (UI label; component filename + URL still wallets-named for backward compat)
    Transactions.tsx      ← Encrypted transaction CRUD
    JournalEntries.tsx    ← Encrypted JE with balanced validation
    Reports.tsx           ← P&L, BS, CF, GL, TB from ledger engine
    Admin.tsx             ← Settings, users, CoA, contacts, connectors
  components/
    layout/
      Sidebar.tsx         ← Branded sidebar shell
      VaultUnlockScreen.tsx
    onboarding/
      StepVaultPassword.tsx

supabase/
  functions/
    legacy-proxy/
      index.ts            ← Blind GraphQL proxy to legacy ledger backend

docs/
  OWB-ARCHITECTURE.md      ← This file
  OWB-LEVEL2-PATH.md
  OWB-ZKA-BRIDGE.md
  OWB-USER-MANAGEMENT-ZKA.md
```

---

## Naming Conventions

| Name | Meaning |
|------|---------|
| **Umbrel-Box** The self-hosted server. Used in all docs, code, and public references. |
| **legacy ledger backend** Rust-based ledger engine by the upstream project. Runs on Umbrel-Box as blind storage. |
| **Supabase** Cloud database. Stores encrypted metadata. |
| **Orange Way Books** This product. |
| **MEK** Master Encryption Key. Derived from vault password. Lives in browser only. |
| **Checkpoint** Encrypted monthly balance snapshot. Stored in Supabase. |

---

## Agent Instructions

If you are an AI agent working on this codebase:

### What you MUST know:
1. ALL data saved to Supabase or legacy ledger backend must be encrypted FIRST using `vaultContext.encryptText()`
2. ALL data fetched from Supabase or legacy ledger backend must be decrypted AFTER using `vaultContext.decryptText()`
3. Amounts are strings in legacy ledger backend (encrypted blobs), NOT numbers
4. Account IDs are random UUIDs, NOT sequential codes
5. The browser calculates all balances and reports — never ask legacy ledger backend for balances
6. Dates stay plaintext — this is intentional for server-side filtering
7. Exchange rates are stored encrypted at the transaction level (up to 3 rates per transaction)

### What you MUST NOT do:
- Send plaintext amounts to legacy ledger backend
- Send plaintext names to Supabase
- Use sequential account codes (A1001) — use crypto.randomUUID()
- Ask legacy ledger backend to calculate balances or generate reports
- Store the MEK anywhere (not localStorage, not cookies, not Supabase)
- Use `key_version = 1` — all new data is `key_version = 2`

### Encryption pattern for every write:
```typescript
const { encryptText } = useVault();

// Before saving to Supabase:
const encryptedName = await encryptText("Bitcoin Cold Storage");
await supabase.from('account_metadata').insert({
  encrypted_name: encryptedName,
  key_version: 2,
});

// Before saving to legacy ledger backend:
const encryptedAmount = await encryptText(String(5000));
const encryptedCurrency = await encryptText("USD");
await legacyQuery(`mutation { ... units: "${encryptedAmount}", currency: "${encryptedCurrency}" ... }`);
```

### Decryption pattern for every read:
```typescript
const { decryptText } = useVault();

// After fetching from Supabase:
const { data } = await supabase.from('account_metadata').select('encrypted_name');
const realName = await decryptText(data.encrypted_name);

// After fetching from legacy ledger backend:
const legacyEntry = await legacyQuery(`{ ... }`);
const realAmount = parseFloat(await decryptText(legacyEntry.units));
```

### For reports (P&L, Balance Sheet, etc.):
```typescript
import { generatePnL, generateBalanceSheet } from '@/lib/ledger-engine';

// 1. Fetch encrypted entries from legacy ledger backend (date-filtered)
// 2. Fetch encrypted account names from Supabase
// 3. Decrypt everything
// 4. Pass to ledger engine
const pnl = generatePnL(decryptedEntries, decryptedAccounts, startDate, endDate);
// 5. Render the report
```

---

## Decisions Log

| ID | Decision | Rationale |
|----|----------|-----------|
| D-002 | legacy ledger backend required (as blind storage) | Immutable audit trail at the storage layer |
| D-003 | Static host + Supabase Cloud for frontend | Fastest path, native integration |
| D-004 | Supabase is swappable (adapter pattern) | Removes "but you use Supabase" objection |
| D-005 | Level 2 ZKA from day one | Server sees nothing readable. This IS the product. |
| D-006 | Two-password authentication | Login (identity) + Vault (encryption key) |
| D-007 | legacy ledger backend-proxy via Caddy reverse proxy | Caddy on Umbrel-Box proxies `/legacy/*` to localhost:2252 with API key auth (`X-legacy ledger backend-Api-Key`), rate limiting, and TLS via Let's Encrypt. Better than Tailscale Funnel or Cloudflare Tunnel — permanent URL, auth built in. |
| D-008 | Bitcoin Connector is separate repo | Independent product, separate release cycle |
| D-009 | Dates stay plaintext | Enables server-side filtering without loading all data |
| D-010 | Random UUIDs for account codes | No sequential pattern that leaks account type |
| D-011 | Browser does all computation | ledger-engine.ts replaces legacy ledger backend calculations |
| D-012 | Encrypted checkpoints | Monthly snapshots solve Balance Sheet performance |
| D-013 | Exchange rates at transaction level | Up to 3 encrypted rates per transaction |

---


*This is the authoritative architecture document. All agents and developers must follow this.*
