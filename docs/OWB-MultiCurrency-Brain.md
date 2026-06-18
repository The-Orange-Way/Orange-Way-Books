# Orange Way Books — Multi-Currency Brain

> **Living reference doc.** Engineers, auditors, and marketing use this as the source of truth for how Orange Way Books handles currencies, exchange rates, and IFRS/US GAAP compliance..

---

## Table of Contents

1. [The Three Currencies That Matter](#1-the-three-currencies-that-matter)
2. [Why Pinning Matters — Before vs. After](#2-why-pinning-matters--before-vs-after)
3. [Monetary-Item Remeasurement](#3-monetary-item-remeasurement)
4. [Changing Your Functional Currency Without Losing History](#4-changing-your-functional-currency-without-losing-history)
5. [Translation Methods — Side-by-Side Comparison](#5-translation-methods--side-by-side-comparison)
6. [What the Incumbents Get Wrong](#6-what-the-incumbents-get-wrong)
7. [How Orange Way Books Handles Each Concern](#7-how-orange-way-books-handles-each-concern)
8. [IFRS vs. US GAAP — Differences and Dual-Reporting](#8-ifrs-vs-us-gaap--differences-and-dual-reporting)
9. [Edge Cases](#9-edge-cases)
10. [Glossary](#10-glossary)

---

## 1. The Three Currencies That Matter

Most accounting software thinks in one currency. Orange Way Books thinks in three — because any real-world business operating across currencies needs to track three separate monetary concepts simultaneously.

### Plain-English Explanation

| Currency | IAS 21 Term | ASC 830 Term | What it is in plain English |
|---|---|---|---|
| **Wallet Currency** Transaction currency | Foreign currency | The actual money in the transaction — what you received or paid |
| **Primary Currency** Functional currency | Functional currency | Your reporting base — the currency your business "thinks in" |
| **Secondary Currency** Presentation currency | Reporting currency | A secondary view for partners, investors, or tax authorities |

### The Peso / Bitcoin / USD Worked Example

Imagine you run a business under **the Bitcoin Standard**:

- Your wallet holds **Mexican Pesos (MXN)** — a client paid you in their local currency
- Your primary accounting currency is **Bitcoin (BTC)** — that's how you measure value
- Your secondary reporting currency is **US Dollars (USD)** — what your accountant needs for year-end

When a client pays you **10,000 MXN**, three things happen simultaneously:

```
Transaction event: Client pays 10,000 MXN
                        │
                        ▼
Wallet currency:  10,000 MXN   ← the literal money received (pinned forever)
Primary currency: ₿0.00900000  ← 10,000 MXN ÷ 1,111,111 MXN/BTC (pinned at posting date)
Secondary currency: ~$540 USD  ← ₿0.009 × current BTC/USD rate (derived live, never stored)
```

The key insight: **the wallet currency and primary currency are both pinned the moment the transaction posts**. They never change. The secondary currency is always derived fresh from today's rates — it's a live view, not a stored fact.

### Why Three Currencies?

**One currency is not enough** for any business that operates cross-border. You need:

1. **Wallet currency**: Legal truth. The actual amount on the invoice. What the bank shows. What auditors verify.
2. **Primary currency**: Economic truth. The value your business actually captured. Used for P&L, Balance Sheet, tax returns.
3. **Secondary currency**: Reporting truth. What you show a partner, a bank, or a regulator who requires a specific currency for their systems.

Without all three, you end up with one of two bad outcomes:
- **Lose the transaction record** (can't reconcile with bank statements or invoices)
- **Distort the P&L** (show revenue in the wrong units, mix currencies in summations)

Orange Way Books stores all three. No other small-business accounting platform does this correctly.

---

## 2. Why Pinning Matters — Before vs. After

"Pinning" means locking the exchange rate at the moment a transaction posts, so the primary-currency value of that transaction never changes. This section shows concretely why not pinning produces incorrect financial statements.

### The Problem Without Pinning

Imagine you record a sale on January 1:

```
Jan 1:  Received 10,000 MXN
        Rate on Jan 1:  1 BTC = 1,100,000 MXN
        Primary value:  ₿0.009090...
```

Now you read your P&L on March 31, when the rate has changed:

```
Mar 31: Rate = 1 BTC = 900,000 MXN
        "Current value" of the Jan 1 sale: ₿0.011111...
```

Without pinning, your January revenue silently increased by 22% on your P&L — not because you earned more, but because your software is re-evaluating old transactions with today's rates. **Your P&L is wrong.**

More damaging: if BTC drops (1 BTC = 1,500,000 MXN), your January revenue looks lower than it actually was. A loan officer reviewing your P&L sees a different number than what you actually earned.

### Before Pinning: The Dangerous Pattern

| Report Date | Jan Revenue (MXN) | Rate Used | Jan Revenue (BTC) |
|---|---|---|---|
| Jan 31 | 10,000 | 1,100,000 | ₿0.009090 |
| Feb 28 | 10,000 | 950,000 | ₿0.010526 |
| Mar 31 | 10,000 | 900,000 | ₿0.011111 |

The same January transaction generates **three different P&L outcomes** depending on when you look at it. This is not just confusing — it is non-compliant with both IFRS and US GAAP, which both require transactions to be recorded at the exchange rate on the transaction date (IAS 21.21, ASC 830-10-30-3).

### After Pinning: The Correct Pattern

| Report Date | Jan Revenue (MXN) | Rate Pinned On | Jan Revenue (BTC) |
|---|---|---|---|
| Jan 31 | 10,000 | Jan 1 (pinned) | ₿0.009090 |
| Feb 28 | 10,000 | Jan 1 (pinned) | ₿0.009090 |
| Mar 31 | 10,000 | Jan 1 (pinned) | ₿0.009090 |

January revenue is **₿0.009090 forever**. The P&L is stable. Comparatives are reliable. Auditors can verify the rate against the source.

### The Pinned Rate Data Structure

Orange Way Books stores the following per journal entry line:

```typescript
// Encrypted at rest (ZKA Level 2)
encrypted_amount_native   // 10,000 (MXN)
encrypted_amount_primary  // 0.00909090... (BTC)
encrypted_posted_rate     // 1,100,000 (MXN per BTC)
encrypted_wallet_currency // "MXN"

// Plaintext (needed for server-side filtering, same privacy baseline as dates)
primary_currency_at_posting  // "BTC" — the primary currency at the moment of posting
pinned_rate_id               // FK to exchange_rates row
rate_pending                 // false (or true if rate not available at post time)
rate_asof                    // 2026-01-01T00:00:00Z
dual_amounts_backfilled      // true
```

This is the **immutable ledger of record**. Once a transaction posts, these fields never change.

---

## 3. Monetary-Item Remeasurement

Pinning handles new transactions correctly. But what about the balance sheet at period close? If you hold 10,000 MXN in a cash account, and the MXN/BTC rate has changed since you deposited it, your balance sheet is showing a stale value. This is where **monetary-item remeasurement** comes in.

### What Is a Monetary Item?

Under IAS 21.16 and ASC 830-10-45-3, a **monetary item** is an asset or liability you will settle in a fixed or determinable amount of cash:

| Monetary (remeasure) | Non-monetary (historical cost) |
|---|---|
| Cash, bank accounts | Property, plant & equipment |
| Accounts receivable | Inventory (at cost) |
| Accounts payable | Prepaid expenses |
| Short-term loans | Equity shares |
| Credit card balances | Intangible assets |

Orange Way Books classifies your accounts automatically using account type heuristics, with a manual override available per account.

### The Remeasurement Journal Entry

Scenario: You hold an MXN bank account.

```
Original deposit on Jan 1:
  Debit  MXN Cash         ₿0.009000  (10,000 MXN × 0.0000009 BTC/MXN)
  Credit Sales Revenue    ₿0.009000

Period close on Mar 31, MXN/BTC rate has changed:
  Current rate:   0.00000095 BTC/MXN  (MXN strengthened vs BTC)
  Current value:  10,000 × 0.00000095 = ₿0.009500

Gain on remeasurement: ₿0.009500 - ₿0.009000 = ₿0.000500 (unrealized)
```

**Revaluation journal entry (Mar 31):**
```
  Debit  MXN Cash Account          ₿0.000500
  Credit Unrealized FX Gain/Loss   ₿0.000500
  Memo: "FX Revaluation Mar 2026 — MXN position"
```

**Auto-reversal entry (Apr 1):**
```
  Debit  Unrealized FX Gain/Loss   ₿0.000500
  Credit MXN Cash Account          ₿0.000500
  Memo: "Auto-reversal of Mar 2026 FX Revaluation"
```

### Why Auto-Reversal Is Mandatory

The revaluation only reflects an **unrealized** gain or loss — the position hasn't been settled. IFRS (IAS 21.28) and GAAP (ASC 830-20-35-1) both require this gain/loss to appear in the income statement for the period. But if you don't reverse it on period open, you'll **double-count** the gain when the underlying transaction finally settles.

Auto-reversal on period open is the industry-standard solution. Orange Way Books schedules the reversal entry the moment you confirm the revaluation, so you can never forget it.

### What This Looks Like on Your P&L

```
Income Statement — Q1 2026
Revenue (pinned at transaction rates)    ₿0.540000
  Sales Revenue                          ₿0.540000

Other Income / (Loss)
  Unrealized FX Gain/Loss                ₿0.000500   ← appears here, not in Revenue

Net Income                               ₿0.540500
```

Realized FX gains/losses (when you actually convert MXN to BTC) appear in a separate "Realized FX Gain/Loss" line. This separation is required by both standards and is critical for auditors to distinguish economic performance from currency exposure.

---

## 4. Changing Your Functional Currency Without Losing History

The functional currency (primary currency in Orange Way Books) is the currency your business "thinks in" for accounting purposes. Changing it is rare — typically happens when a company shifts its primary market, raises funding in a new currency, or adopts the Bitcoin Standard.

### The Core Problem

Naive implementations do one of two things when you change primary currency:
1. **Convert everything historically** — destroys the original record, produces incorrect comparatives
2. **Block the change** — QuickBooks does this (you cannot change your home currency once set)

Both approaches are wrong under IAS 21.37 and ASC 830-10-45-7.

### The Correct Approach: Cutoff Migration

Orange Way Books uses a **cutoff** approach:

```
Timeline:
  Before cutoff: All JE lines retain primary_currency_at_posting = "USD"
                 Amounts denominated in USD — unchanged forever
  
  Cutoff date: Jan 1, 2027
  
  After cutoff:  New JE lines get primary_currency_at_posting = "BTC"
                 Amounts denominated in BTC — pinned as usual
```

No historical records are modified. Reports that span the boundary show a **Split View** (default) or a **Translated View** (user opt-in, with disclosure footer explaining the translation method used).

### The Three-Step Wizard

1. **Preview**: Shows all open items (unpaid A/R, unpaid A/P, outstanding loans) that will cross the boundary. These items remain pinned in the old primary until settled.
2. **Audit Reason**: Mandatory text field, minimum 40 characters. Examples: "Adopting Bitcoin Standard, all new activity in BTC effective 2027-01-01 per board resolution." This reason appears in audit reports.
3. **Type-to-Confirm**: You must type the old currency code to confirm. This is a destructive guard — the change is permanent.

### What Gets Stored

```sql
-- New row in org_primary_currency_history
INSERT INTO org_primary_currency_history (
  org_id, primary_currency, effective_from, effective_to,
  changed_by, reason
) VALUES (
  'org_123', 'BTC', '2027-01-01', NULL,
  'user_456', 'Adopting Bitcoin Standard per board resolution Q4 2026'
);

-- Previous row gets effective_to set
UPDATE org_primary_currency_history
SET effective_to = '2026-12-31'
WHERE org_id = 'org_123' AND effective_to IS NULL;
```

### Open Items at the Boundary

An open A/R invoice for $2,400 USD posted before the cutoff:

```
Invoice created Dec 15, 2026:
  Debit  Accounts Receivable  $2,400 USD (primary_currency_at_posting = 'USD')
  Credit Sales Revenue        $2,400 USD

Payment received Feb 1, 2027 (after cutoff, primary now BTC):
  Rate on Feb 1: 1 BTC = $95,000 USD
  
  Debit  Cash / BTC           ₿0.025263   (actual BTC received = $2,400 / $95,000)
  Credit Accounts Receivable  $2,400 USD  (closes at original USD amount)
  Credit Realized FX Gain     ₿0.000052   (delta, if any rate difference)
```

The open item is kept in the old primary until settlement. On settlement, a realized FX gain or loss posts automatically. This matches IAS 21.28 and ASC 830-20-35-2.

### Pros and Cons of This Approach

**Pros:**
- Historical records are never rewritten — full audit trail preserved
- No confusion between "old" and "new" comparatives
- IFRS and GAAP compliant
- Open items settle correctly without complex re-pinning

**Cons:**
- Reports spanning the cutoff require explanation (handled by Split View + disclosure)
- Tax treatment of the cutoff may require CPA guidance in some jurisdictions
- If you have many open items at the boundary, the settlement process generates more journal lines

**The alternative (re-translate everything):**
- Simpler appearance at first glance
- But: destroys the original transaction record
- Makes historical comparatives unreliable
- Violates both IFRS and GAAP requirements for transaction-date recording
- Not offered by Orange Way Books — by design

---

## 5. Translation Methods — Side-by-Side Comparison

When you view reports in the secondary currency, Orange Way Books translates your primary-currency amounts. There are three industry-standard methods.

### The Three Methods Explained

**Method 1: Closing Rate**
All amounts translated at today's spot rate (the rate at the report date).

- Simplest to compute
- Produces maximum currency volatility in reports (the same transaction looks different every day)
- Suitable for dashboards and quick views
- **NOT recommended for formal financial statements** under strict IFRS

**Method 2: Period Average Rate**
All income statement amounts translated at the average rate for the period. Balance sheet items at closing rate.

- Reduces volatility compared to closing-rate method
- Compliant with IAS 21.40(b) for income statement items
- "Good enough" for many smaller businesses
- Easier to explain to non-accountants

**Method 3: Historical Per Transaction (IFRS Strict)**
Each transaction translated at the exchange rate on the date of that specific transaction.

- Most accurate — preserves the economic reality of each individual transaction
- Required for audited financial statements under IAS 21
- More computationally intensive (one rate lookup per transaction per period)
- Produces results that cannot be contested by auditors

### Side-by-Side P&L Example

Setup:
- Primary currency: BTC
- Secondary: USD
- Two transactions in Q1: Jan sale ₿0.009, Mar sale ₿0.011

| Month | BTC Revenue | BTC→USD rate on trans. date | Historical USD | Avg Rate (Q1) | Closing Rate (Mar 31) |
|---|---|---|---|---|---|
| Jan sale | ₿0.009 | $90,000/BTC | $810.00 | — | — |
| Mar sale | ₿0.011 | $95,000/BTC | $1,045.00 | — | — |
| **Total Q1** **₿0.020** — | **$1,855.00** **$1,900.00** **$1,980.00** |

*(Avg rate Q1 = $95,000; Closing rate Mar 31 = $99,000)*

The three methods produce **$125 difference** on the same underlying business activity. None is "wrong" — but Method 3 is most defensible to auditors, and Method 1 is most useful for day-to-day dashboards.

### Orange Way Books Default Configuration

| Context | Default Method | Why |
|---|---|---|
| Dashboard KPI cards | Closing rate | Speed — one fetch, no per-transaction work |
| WalletsInsightsCard donut | Closing rate | Live, visual overview |
| P&L Report | Historical per transaction | IFRS accuracy |
| Balance Sheet | Closing rate | Standard for balance sheet items |
| CSV / PDF Export | Historical per transaction | Auditor-grade output |

Users can override the default per-report using the toolbar selector. The chosen method is recorded in the export's audit footer.

---

## 6. What the Incumbents Get Wrong

The multi-currency gap in small-business accounting software is not a minor oversight — it represents a fundamental architectural compromise that most incumbent products made years ago and cannot easily undo. Here is a detailed breakdown.

### QuickBooks Online (QBO)

**Critical gap: Home currency lock-in**

Once you set your home currency in QBO, you cannot change it. Ever. The QuickBooks support documentation explicitly states: "Once you set up your home currency, you can't change it." (Intuit Help article, "Multi-currency overview", 2024.)

This is a hard architectural constraint, not a policy choice. QBO was built on a single-currency ledger, and multi-currency was bolted on as a display feature rather than a first-class data model.

Additional QBO gaps:
- **Rate precision**: QBO stores exchange rates to 6 decimal places. For BTC/USD, rates often require 8-10 significant figures (e.g., 0.00000978). Truncation introduces rounding errors that compound across thousands of transactions.
- **No IFRS mode**: QBO does not offer a translation method selector. It uses an undocumented internal method that approximates period-average but is not auditor-verifiable.
- **No FX revaluation automation**: QBO requires manual revaluation journal entries. There is no built-in workflow, no auto-reversal, and no classification of monetary vs. non-monetary items.
- **Subsidiary consolidation**: Multi-entity consolidation requires QBO Advanced or third-party tools. Exchange rate differences between subsidiaries are not automatically eliminated on consolidation.

**Why this matters for Bitcoin-standard businesses**: A company that adopts BTC as its functional currency after years on QBO cannot migrate without a complete re-entry of all historical data or a very expensive custom migration project.

### Xero

**Critical gap: Manual period-end FX revaluation**

Xero performs FX revaluation for bank account balances only (cash/bank accounts). Accounts receivable, accounts payable, and loan accounts are not revalued — the user must post manual journal entries. This violates IAS 21.23, which requires remeasurement of ALL monetary items at the closing rate.

Additional Xero gaps:
- **Home currency change**: Like QBO, Xero does not support changing the base currency after org creation.
- **Rate sourcing**: Xero pulls from a single undisclosed rate provider. The rate used for each transaction is not stored per-line in the export — users cannot independently verify or reproduce exchange rate history.
- **Translation method**: Xero uses closing rate for all revaluations and does not offer historical-per-transaction for formal reports.
- **Manual monthly workflow**: A recurring complaint among Xero users is the manual overhead of period-end FX adjustments (Xero Community forums, "FX revaluation process", multiple threads 2023–2025). Users report spending 2–4 hours per period on manual revaluation entries that should be automated.
- **No audit trail for manual rates**: When users post manual FX JEs to compensate for gaps in Xero's auto-revaluation, there is no structured way to record the rate source or reason. Auditors must reconstruct this from memo text.

### Wave (by H&R Block)

**Critical gap: Home currency only for reports**

Wave's multi-currency support is limited to invoicing. While you can issue invoices in foreign currencies, all reports (P&L, Balance Sheet, Trial Balance) are displayed in the home currency only. There is no secondary reporting currency. There is no FX revaluation. Wave does not implement IAS 21 at all.

From Wave's own help documentation (2024): "Expenses and income recorded in a foreign currency will be automatically converted to your home currency at a fixed default rate you set."

This "fixed default rate you set" means users manually enter a single exchange rate for all transactions in a given currency — not a rate per transaction, not a rate per date, not a market rate. The resulting financial statements are technically valid only if exchange rates never change, which they always do.

Wave is suitable for very simple single-currency micro-businesses. For any business with material foreign-currency activity, Wave's multi-currency offering is not compliant with any accounting standard.

### FreshBooks

**Critical gap: No multi-currency journal entries**

FreshBooks allows invoices and expenses in foreign currencies, but the underlying ledger is single-currency. There are no multi-currency journal entries. There is no chart of accounts with per-account currency assignments. There is no P&L or Balance Sheet that handles multi-currency correctly.

FreshBooks' own help center (2024) states: "FreshBooks doesn't support reporting in a foreign currency. All reports are in your home currency."

For businesses that receive payments in multiple currencies — which includes virtually every e-commerce business, any business with international clients, and every Bitcoin-enabled business — FreshBooks cannot produce an accurate Balance Sheet. Foreign-currency receivables are converted at invoice date, foreign-currency bank accounts are not remeasured, and there is no mechanism to track unrealized FX gains and losses.

### The Pattern

All four incumbents share the same fundamental constraint: they were built as **invoice + expense managers** with a single-currency ledger, and multi-currency was added as a display feature. The result is software that looks like it handles multi-currency (it can print invoices in euros!) but fails at the accounting layer where it counts.

The gaps they share:
1. No functional currency change after setup
2. Incomplete FX revaluation (cash only, or manual, or none)
3. No translation method selector
4. No audit trail for exchange rates
5. No per-transaction rate pinning for reports
6. No support for crypto as functional currency

Orange Way Books is designed from the ledger up with multi-currency as a first-class concern. Every gap listed above is addressed by design, not as a future roadmap item.

---

## 7. How Orange Way Books Handles Each Concern

This section maps each incumbent gap to the specific Orange Way Books feature that addresses it.

### Functional Currency Change After Setup

**What we do**: Three-step wizard with preview, mandatory audit reason (≥40 chars), and type-to-confirm destructive guard. Old transactions retain `primary_currency_at_posting` forever. Reports spanning the cutoff show Split View by default.

**Standard compliance**: IAS 21.37–38, ASC 830-10-45-7

**User impact**: You can migrate to the Bitcoin Standard at any time. Your historical records are never rewritten. Your CPA can review the exact change history with timestamps and reasons.

### FX Revaluation — Full Monetary Item Coverage

**What we do**: At period close, Orange Way Books classifies ALL accounts as monetary or non-monetary using account type + account group heuristics (with manual override per account). The revaluation wizard previews every monetary account balance, computes the gain/loss at today's closing rate, posts a single JE covering all accounts, and automatically schedules the reversal entry for the next period's open.

**Standard compliance**: IAS 21.23–28, ASC 830-20-35-1

**User impact**: Period close takes minutes, not hours. You never accidentally omit an A/R or loan account from revaluation. Auditors see a clean, verifiable trail with auto-reversal dates.

### Per-Transaction Rate Pinning with Full Audit Trail

**What we do**: Every journal entry line stores the exchange rate used, the rate provider, the rate timestamp (bucketed to day for free tier, 5 minutes for pro), and the rate ID in the `exchange_rates` table. The rate is pinned at posting and immutable thereafter.

**Standard compliance**: IAS 21.21–22, ASC 830-10-30-3

**User impact**: You can pull any transaction, see exactly what rate was used, trace it back to the provider timestamp, and compare against historical rate data. This is auditor-grade.

### Manual Rate Entry with Audit-Grade Reason

**What we do**: When a rate is not available from a provider (historical gap, obscure pair, or provider outage), Orange Way Books prompts you for a manual rate entry. The dialog requires:
- The rate value
- The source (dropdown: OANDA.com, CPA-quoted, Spot rate from bank, Other)
- A reason in your own words (minimum 40 characters)

This creates a `manual_rate_reason` + `manual_rate_source` record on the journal line, surfaced in the Rate Transparency admin page.

**Standard compliance**: Both IFRS and GAAP require that manually estimated rates be disclosed. Orange Way Books makes this structurally unavoidable.

**User impact**: No more undocumented "I just typed a number" rates. Auditors can see every manual rate entry, its stated source, and the reason it was used.

### Translation Method Selector

**What we do**: Three methods available globally (set in Org Settings → Accounting Framework) and overridable per-report in the toolbar:
- Closing rate (default for dashboards)
- Period average
- Historical per transaction (default for formal reports and exports)

The method used is recorded in every exported report's audit footer.

**Standard compliance**: IAS 21.39–42 (IFRS), ASC 830-30-45 (GAAP)

**User impact**: You can use fast closing-rate for day-to-day work and switch to historical-per-transaction for month-end close and audit prep without re-running anything.

### Crypto as Functional Currency

**What we do**: Orange Way Books treats BTC, SATS, and other crypto assets as first-class functional currencies. Rate resolution handles four source types:
- Fiat → crypto (e.g., MXN → BTC): CoinGecko API
- Crypto → fiat (e.g., BTC → USD): CoinGecko API (direct or inverted)
- Fiat → fiat (e.g., MXN → EUR): OXR API via USD cross-rate
- Identity (e.g., BTC → BTC): fixed rate of 1.0
- SATS ↔ BTC: fixed rate of 100,000,000 SATS/BTC (never fetched from a provider)

**Standard compliance**: IAS 21 does not exclude crypto from functional currency status. IASB published agenda decision in 2019 (IAS 38, not IAS 21) but functional currency classification is entity-specific per IAS 21.9.

**User impact**: If you run a Bitcoin-native business, your books are denominated in Bitcoin from the start. No currency conversion gymnastics. No "you must pick a fiat base currency" requirement.

### Zero-Knowledge Architecture Compatibility

**What we do**: All sensitive amounts, currencies, and rates are encrypted client-side before storage. The server never sees plaintext financial data. Rate fetching requires sending `{base, quote, date}` to the edge function — this is treated as metadata (same privacy baseline as the transaction date, which is already plaintext for server-side filtering). This is documented as an acceptable ZKA Level 2 trade-off.

**User impact**: Your financial details remain private. The server knows you made a transaction on a given date involving a given currency pair — it does not know the amount, the account, or whether it was income or expense.

---

## 8. IFRS vs. US GAAP — Differences and Dual-Reporting

For most small businesses, IFRS and US GAAP produce nearly identical results in the multi-currency domain. The differences matter most for larger entities, entities with subsidiaries, or entities planning to raise institutional capital.

### Key Differences

| Topic | IFRS (IAS 21) | US GAAP (ASC 830) |
|---|---|---|
| **Functional currency definition** Entity-specific, determined by facts | Same — entity-specific |
| **Re-measurement method** Monetary/non-monetary classification | Temporal method (similar but not identical) |
| **Translation to presentation currency** Closing rate for assets/liabilities; average for income | Same, but "current rate method" vs. "temporal method" distinction matters for subsidiaries |
| **FX differences in equity** Cumulative translation adjustment (CTA) in OCI | Same — CTA in AOCI |
| **Hyperinflationary economies** IAS 29 applies (restate then translate) | ASC 830-10-45-11 (remeasure into functional) |
| **Crypto assets** IAS 38 (intangible asset) if held; IAS 21 for functional | No specific standard; SEC staff guidance |
| **Disclosure** More narrative required | Similar, with additional tabular disclosures |

### When the Difference Matters

**IFRS is stricter for translation disclosures.** Under IAS 21.52, you must disclose the translation method used, the rates applied, and the effect of rate changes on each line item in the financial statements. Orange Way Books' audit footer satisfies this requirement automatically.

**GAAP temporal method** applies when translating the financial statements of a subsidiary whose functional currency differs from the parent's reporting currency. The temporal method re-measures at historical rates for non-monetary items (PP&E, inventory) rather than closing rates. For small businesses without subsidiaries, this distinction rarely applies.

**The practical default for most Orange Way Books users:**
- Non-US businesses: use IFRS
- US businesses: use US GAAP
- Businesses with international investors or planning IPO: use IFRS_AND_GAAP dual mode

### Dual Reporting Mode (IFRS_AND_GAAP)

Orange Way Books offers a dual mode that generates two parallel sets of comparative figures in exports. The differences are small but noted:

```
P&L Export — Q1 2026 (Dual Mode)

                              IFRS        US GAAP      Difference
Revenue (primary)           ₿0.54000    ₿0.54000          —
FX Translation (secondary)  $51,840     $51,903         ($63)
                                         ← avg rate vs. closing rate applied differently
```

The audit footer documents which standard applies to which column, and links to the relevant standard paragraph.

---

## 9. Edge Cases

### Hyperinflationary Economies

A currency is considered hyperinflationary under IAS 29 when cumulative inflation over three years approaches or exceeds 100%. Examples have included Argentina (ARS), Venezuela (VES), and Zimbabwe (ZWL).

**The problem**: If your wallet currency is ARS and inflation is running at 200% annually, the pinned-rate approach produces enormous unrealized FX losses on your monetary items — even though the "real" purchasing power may be hedged.

**IAS 29 solution**: Restate financial statements in a measuring unit that is current at the balance sheet date before translating. This is complex and beyond the scope of the current Orange Way Books implementation.

**Orange Way Books v1 approach**: Flag the account as "hyperinflationary currency" (manual toggle), which suppresses the remeasurement P&L impact and shows a disclosure banner. Full IAS 29 restatement is a planned feature for a later release.

### Crypto as Functional Currency — Regulatory Status

As of 2026, no major tax authority explicitly endorses Bitcoin as a functional currency for tax reporting purposes. The IRS (US), HMRC (UK), and CRA (Canada) all require reporting in their respective fiat currencies for tax filings, even if your books are maintained in BTC.

**Orange Way Books approach**: Primary currency (BTC) drives your accounting. Secondary currency (USD, CAD, GBP, etc.) drives your tax export. This is the correct separation — your books are yours, your tax filing is the regulator's.

We recommend consulting a qualified tax professional when using BTC as your primary currency. The rate you use to translate BTC to fiat for tax purposes may differ from the market rate and may be subject to specific guidance from your tax authority.

### Stablecoins

USDC, USDT, and similar USD-pegged stablecoins are treated as USD-equivalent in Orange Way Books by default. Rate is set to 1.0000 (no external fetch).

This is appropriate for most scenarios. Edge cases:
- **USDT de-peg events** (May 2022: USDT briefly traded at $0.9956): Orange Way Books will not automatically detect a de-peg. Users operating with material USDT balances should monitor rate manually and use the Manual Rate Entry dialog during de-peg events.
- **Rebasing stablecoins** (AMPL, RAI): Not supported in v1. Contact support for a roadmap timeline.

### Month-End Cutoffs

When a journal entry is posted on the last day of the month and the fiscal period closes, the revaluation entry uses the closing rate for that date. The auto-reversal entry posts on the first day of the next period.

**Timing precision**: Orange Way Books uses UTC midnight as the bucket boundary for DAY-granularity rates. If your business operates in a timezone far from UTC (e.g., Pacific time, UTC-8), a "Dec 31 end of day" transaction at 11 PM Pacific is Jan 1 UTC. The rate used will be the Jan 1 UTC bucket rate, not the Dec 31 rate.

**Recommendation**: For period-end entries, post using UTC dates explicitly, or verify the date bucket shown in the pinned-rate chip before saving.

### Compound Cross-Currency Journal Entries

Orange Way Books supports journal entries with lines in different wallet currencies — for example, a JE that records receiving MXN cash and paying a BTC liability simultaneously. Each line carries its own `encrypted_wallet_currency`, and each line is independently resolved against the primary currency.

The JE must balance in the primary currency, not in any single wallet currency. The balance check sums all `amount_primary` values and verifies they net to zero within a tolerance of 0.000001 of the primary currency unit.

### Missing Historical Rates

Orange Way Books uses free-tier rate providers (OpenExchangeRates for fiat, CoinGecko for crypto). Free tiers provide:
- OXR: latest rates only (no historical for free tier). Historical rates for dates older than 30 days require OXR paid tier.
- CoinGecko: daily OHLC up to 365 days back for free tier. Beyond 365 days requires CoinGecko Pro.

For transactions posted with missing historical rates, Orange Way Books sets `rate_pending = true`. The Pending Rates Banner appears in the app. You can:
1. **Retry**: Once an hour automatically; "Retry now" button for immediate retry
2. **Resolve manually**: Enter the rate yourself with source and reason (minimum 40 characters)

Transactions with `rate_pending = true` are excluded from formal reports with a disclosure banner showing the count and total wallet-currency exposure.

---

## 10. Glossary

**Accounting Framework**: The standards-body rules your financial statements follow. Orange Way Books supports IFRS, US_GAAP, or IFRS_AND_GAAP dual mode. Set in Org Settings → Accounting Framework.

**Amount Native** (`encrypted_amount_native`): The signed transaction amount in the wallet currency, encrypted at rest. Negative for payments/credits, positive for receipts/debits. This is the immutable wallet-currency record.

**Amount Primary** (`encrypted_amount_primary`): The transaction amount translated to the primary (functional) currency at the posted rate. Stored encrypted at rest. Null if `rate_pending = true`.

**Auto-Reversal**: A journal entry automatically scheduled by Orange Way Books to reverse an FX revaluation entry at the start of the next accounting period. Required under IAS 21 / ASC 830 to prevent double-counting.

**Bucket / Bucket Granularity**: The time bucket used for rate storage. DAY = one rate per pair per day (free tier). FIVE_MINUTES = one rate per 5-minute window (pro tier). Two transactions in the same bucket use the same pinned rate.

**Closing Rate**: The exchange rate at the end of the reporting period (e.g., March 31). Used for balance sheet items in the translation method.

**CTA / AOCI**: Cumulative Translation Adjustment (IFRS) / Accumulated Other Comprehensive Income (GAAP). A balance sheet line that captures FX differences arising from translating subsidiaries' financial statements.

**Dual Amounts Backfilled** (`dual_amounts_backfilled`): A boolean flag indicating whether the `amount_native` and `amount_primary` encrypted fields have been populated for this line. `false` for rows created before the dual-currency system was implemented; the Backfill page processes these.

**Functional Currency**: The currency of the primary economic environment in which the entity operates. In Orange Way Books, this is the **primary currency**. Determined per IAS 21.9 / ASC 830-10-45-4 based on transaction patterns, not user preference.

**FX Exposure**: The total value at risk from exchange rate movements. Quantified as the sum of all monetary items denominated in a currency other than the functional currency. The FX Exposure Dashboard shows this per currency.

**FX Revaluation**: The process of translating monetary item balances from their wallet currency to the primary currency at the current closing rate, and posting the resulting gain or loss to the income statement.

**Historical Rate**: The exchange rate on the original transaction date. Used in the historical-per-transaction translation method.

**IAS 21**: International Accounting Standard 21 — "The Effects of Changes in Foreign Exchange Rates." The IFRS standard governing how foreign currency transactions and translation of financial statements are handled.

**ASC 830**: Accounting Standards Codification Topic 830 — "Foreign Currency Matters." The US GAAP equivalent of IAS 21.

**MEK (Master Encryption Key)**: The AES-256-GCM encryption key derived from the user's vault password via PBKDF2. Lives only in browser memory during an active session. Never sent to the server. All `encrypted_*` fields are encrypted with this key.

**Monetary Item**: An asset or liability that will be settled in a fixed or determinable amount of cash. Examples: cash, bank accounts, A/R, A/P, loans. Contrast with non-monetary items (PP&E, inventory, equity).

**Period Average Rate**: The arithmetic or weighted average of exchange rates over a reporting period. Used for income statement items in the period-average translation method.

**Pinned Rate** (`encrypted_posted_rate`): The exchange rate locked at the moment a journal entry line is posted. Immutable. Traceable to a specific entry in the `exchange_rates` table via `pinned_rate_id`.

**Posted Rate**: See Pinned Rate.

**Presentation Currency**: The currency in which financial statements are presented to external parties. In Orange Way Books, this is the **secondary currency**. May differ from the functional currency.

**Primary Currency**: Orange Way Books term for functional currency. The currency your accounting "thinks in." P&L, Balance Sheet, and Trial Balance are denominated in this currency.

**Primary Currency at Posting** (`primary_currency_at_posting`): The functional currency that was in effect when a journal entry line was posted. Stored as plaintext. Required to correctly handle historical records after a functional currency change.

**Rate Pending** (`rate_pending`): A boolean indicating that the exchange rate for this journal entry line could not be resolved at posting time. The Pending Rates Banner tracks these and provides resolution paths.

**Rate Transparency**: The admin page showing every exchange rate used by the org during a period, with source, timestamp, staleness indicator, and audit log per rate. Required for auditor review.

**Realized FX Gain/Loss**: The exchange rate gain or loss that crystallizes when a foreign-currency monetary item is settled (e.g., converting MXN to BTC, paying a foreign-currency invoice). Appears as a distinct P&L line item.

**Secondary Currency**: Orange Way Books term for presentation currency. A live view of your financials in a second reporting currency. Derived by applying a translation method to primary-currency amounts. Never stored per-line — always computed at read time.

**Source Kind**: The category of a rate pair: FIAT_FIAT (MXN/EUR), FIAT_CRYPTO (MXN/BTC), CRYPTO_FIAT (BTC/USD), CRYPTO_CRYPTO (BTC/ETH), IDENTITY (BTC/BTC), FIXED (SATS/BTC).

**Translation Method**: The algorithm used to convert primary-currency amounts to the secondary currency. Three options: closing-rate, period-average, historical-per-transaction. See Section 5.

**Unrealized FX Gain/Loss**: The exchange rate gain or loss on a monetary item that has not yet been settled. Appears in P&L as a separate line item. Auto-reversed at period open. Contrast with Realized FX Gain/Loss.

**Wallet Currency**: Orange Way Books term for transaction currency. The actual denomination of the transaction — the currency on the invoice, in the bank account, or in the crypto wallet. Stored encrypted per journal entry line. Immutable.

**ZKA Level 2**: Orange Way Books' zero-knowledge architecture tier where all sensitive business data (amounts, currencies, account names, memos, counterparty names, statuses) is encrypted client-side before storage. The server stores only ciphertext. Dates remain plaintext for server-side filtering. See `OWB-ARCHITECTURE.md` for full specification.

---

*Orange Way Books — built for the Bitcoin Standard. Questions? Open an issue in the repo or email hello@orangeway.app.*
