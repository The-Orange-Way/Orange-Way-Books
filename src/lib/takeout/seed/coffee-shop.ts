/**
 * Coffee-shop sample dataset generator — Common Grounds Coffee Co.
 *
 * Produces a TakeoutFile with ~6 months of retail activity for a
 * circular-economy coffee shop:
 *   - Daily aggregate sales (weekdays vs weekends, small Lightning-BTC tail)
 *   - Weekly inventory purchases (beans, dairy)
 *   - Monthly rent, utilities, internet, payroll
 *   - Quarterly insurance premium
 *   - Quarterly circular-economy INCOME:
 *       · Spent coffee grounds sold to compost partner
 *       · Used burlap sacks sold to local artisan market
 *   - Initial equity + one-time espresso-machine purchase
 *
 * Primary currency USD, secondary BTC. JE lines are in USD. Sizing is
 * tuned to stay well under 400 transactions so QA iterations are fast.
 */

import {
  TAKEOUT_VERSION,
  type TakeoutFile,
  type TakeoutData,
  type Takeoutlegacy ledger backendAccount,
  type TakeoutContact,
  type TakeoutWallet,
  type TakeoutTransaction,
  type TakeoutJournalEntry,
  type TakeoutJournalEntryLine,
  type TakeoutPaymentRequest,
} from '../schema';

// ── Deterministic PRNG so runs are repeatable ────────────────────────
function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(base: Date, n: number): Date {
  const x = new Date(base);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8;
}

// Deterministic BTC/USD rate seed for any date — used to translate
// USD-denominated seed journal lines into BTC (primary) amounts.
function btcRateForDate(date: Date): number {
  const epoch = Date.UTC(2025, 0, 1);
  const days = Math.max(0, Math.floor((date.getTime() - epoch) / 86400000));
  const base = 60000 + days * 80;
  const noise = Math.sin(days * 0.137) * 2500;
  return Math.max(30000, Math.round(base + noise));
}

const U = () => crypto.randomUUID();

// ── Canonical chart of accounts (matches OnboardingWizard) ───────────
interface AccountDef {
  code: string; name: string; type: string; group: string;
  normal: 'DEBIT' | 'CREDIT';
}
// accountType uses PascalCase — the Insights Expenses card does a
// case-sensitive === 'Expense' match, and the ledger engine
// lowercases for its 'revenue'/'expense'/'asset' checks, so PascalCase
// satisfies both. account group labels are specific enough to feed
// the working-capital filter (`includes('cash'|'bank'|'receivable'|
// 'payable'|'credit card')`) without overlap.
const ACCOUNTS: AccountDef[] = [
  { code: '1000', name: 'Accounts',                 type: 'Asset',     group: 'Cash',                    normal: 'DEBIT' },
  { code: '1100', name: 'Cash & Bank',             type: 'Asset',     group: 'Bank',                    normal: 'DEBIT' },
  { code: '1110', name: 'Fiat Cash Accounts',       type: 'Asset',     group: 'Cash',                    normal: 'DEBIT' },
  { code: '1120', name: 'Digital Asset Accounts',   type: 'Asset',     group: 'Cash',                    normal: 'DEBIT' },
  { code: '1200', name: 'Accounts Receivable',     type: 'Asset',     group: 'Accounts Receivable',     normal: 'DEBIT' },
  { code: '1300', name: 'Prepaid Expenses',        type: 'Asset',     group: 'Prepaid Expenses',        normal: 'DEBIT' },
  { code: '1305', name: 'Inventory',               type: 'Asset',     group: 'Inventory',               normal: 'DEBIT' },
  { code: '1500', name: 'Transfer Clearing',       type: 'Asset',     group: 'Cash',                    normal: 'DEBIT' },
  { code: '1600', name: 'Equipment',               type: 'Asset',     group: 'Equipment',               normal: 'DEBIT' },
  { code: '1700', name: 'Other Assets',            type: 'Asset',     group: 'Other Assets',            normal: 'DEBIT' },
  { code: '2000', name: 'Liabilities',             type: 'Liability', group: 'Current Liabilities',     normal: 'CREDIT' },
  { code: '2100', name: 'Current Liabilities',     type: 'Liability', group: 'Current Liabilities',     normal: 'CREDIT' },
  { code: '2110', name: 'Accounts Payable',        type: 'Liability', group: 'Accounts Payable',        normal: 'CREDIT' },
  { code: '2120', name: 'Credit Cards',            type: 'Liability', group: 'Credit Cards',            normal: 'CREDIT' },
  { code: '2130', name: 'Sales Tax Payable',       type: 'Liability', group: 'Current Liabilities',     normal: 'CREDIT' },
  { code: '2140', name: 'Payroll Liabilities',     type: 'Liability', group: 'Current Liabilities',     normal: 'CREDIT' },
  { code: '2200', name: 'Long-Term Liabilities',   type: 'Liability', group: 'Long-Term Liabilities',   normal: 'CREDIT' },
  { code: '2210', name: 'Notes Payable',           type: 'Liability', group: 'Long-Term Liabilities',   normal: 'CREDIT' },
  { code: '2220', name: 'Mortgage Payable',        type: 'Liability', group: 'Long-Term Liabilities',   normal: 'CREDIT' },
  { code: '3000', name: "Owner's Equity",          type: 'Equity',    group: 'Equity',                  normal: 'CREDIT' },
  { code: '3100', name: 'Starting Balance',        type: 'Equity',    group: 'Equity',                  normal: 'CREDIT' },
  { code: '3200', name: 'Retained Earnings',       type: 'Equity',    group: 'Equity',                  normal: 'CREDIT' },
  { code: '3300', name: 'Dividends Paid',          type: 'Equity',    group: 'Equity',                  normal: 'DEBIT' },
  { code: '4000', name: 'Sales',                   type: 'Income',    group: 'Revenue',                 normal: 'CREDIT' },
  { code: '4100', name: 'Sales Revenue',           type: 'Income',    group: 'Revenue',                 normal: 'CREDIT' },
  { code: '4200', name: 'Service Revenue',         type: 'Income',    group: 'Revenue',                 normal: 'CREDIT' },
  { code: '4300', name: 'Interest Income',         type: 'Income',    group: 'Other Income',            normal: 'CREDIT' },
  { code: '4400', name: 'Other Income',            type: 'Income',    group: 'Other Income',            normal: 'CREDIT' },
  { code: '4500', name: 'Gain on Sale of Assets',  type: 'Income',    group: 'Other Income',            normal: 'CREDIT' },
  { code: '4600', name: 'Unrealized Gains',        type: 'Income',    group: 'Other Income',            normal: 'CREDIT' },
  { code: '5000', name: 'Cost of Goods Sold',      type: 'Expense',   group: 'Cost of Sales',           normal: 'DEBIT' },
  { code: '5200', name: 'Salaries & Wages',        type: 'Expense',   group: 'Payroll',                 normal: 'DEBIT' },
  { code: '5300', name: 'Rent Expense',            type: 'Expense',   group: 'Rent',                    normal: 'DEBIT' },
  { code: '5400', name: 'Utilities',               type: 'Expense',   group: 'Utilities',               normal: 'DEBIT' },
  { code: '5500', name: 'Insurance',               type: 'Expense',   group: 'Insurance',               normal: 'DEBIT' },
  { code: '5600', name: 'Depreciation',            type: 'Expense',   group: 'Depreciation',            normal: 'DEBIT' },
  { code: '5700', name: 'Marketing & Advertising', type: 'Expense',   group: 'Marketing',               normal: 'DEBIT' },
  { code: '5800', name: 'Professional Services',   type: 'Expense',   group: 'Professional Services',   normal: 'DEBIT' },
  { code: '5900', name: 'Travel & Entertainment',  type: 'Expense',   group: 'Travel',                  normal: 'DEBIT' },
  { code: '5950', name: 'Bank & Transaction Fees', type: 'Expense',   group: 'Bank Fees',               normal: 'DEBIT' },
  { code: '5960', name: 'Loss on Sale of Assets',  type: 'Expense',   group: 'Other Expenses',          normal: 'DEBIT' },
  { code: '5970', name: 'Unrealized Losses',       type: 'Expense',   group: 'Other Expenses',          normal: 'DEBIT' },
  { code: '5980', name: 'Other Expenses',          type: 'Expense',   group: 'Other Expenses',          normal: 'DEBIT' },
];

export function generateCoffeeShop(now: Date = new Date()): TakeoutFile {
  const rand = mulberry32(0xc0ffee00);
  const orgId = U();

  // ── Chart of accounts ────────────────────────────────────────────────
  const accountMap = new Map<string, Takeoutlegacy ledger backendAccount>();
  const chart_of_accounts: Takeoutlegacy ledger backendAccount[] = ACCOUNTS.map((a) => {
    const row: Takeoutlegacy ledger backendAccount = {
      id: U(),
      legacy_account_id: U(),
      account_name: a.name,
      account_code: a.code,
      account_type: a.type,
      account_group: a.group,
      account_category: null,
      is_archived: false,
      normal_balance: a.normal,
    };
    accountMap.set(a.code, row);
    return row;
  });
  const acct = (code: string): string => accountMap.get(code)!.legacy_account_id;
  const acctName = (code: string): string => accountMap.get(code)!.account_name;

  // ── Accounts ──────────────────────────────────────────────────────────
  const walletOperatingId = U();
  const walletRegisterId = U();
  const walletLightningId = U();
  const walletReservesId = U();
  const wallets: TakeoutWallet[] = [
    {
      id: walletOperatingId,
      name: 'Operating Account',
      asset: 'USD',
      account_type: 'Bank',
      initial_balance: 0,
      legacy_account_id: acct('1100'),
      connection_type: null,
      legacy_account_code: '1100',
    },
    {
      id: walletRegisterId,
      name: 'Register Cash Drawer',
      asset: 'USD',
      account_type: 'Hot Wallet',
      initial_balance: 400,
      legacy_account_id: acct('1110'),
      connection_type: null,
      legacy_account_code: '1110',
    },
    {
      id: walletLightningId,
      name: 'Lightning Node',
      asset: 'BTC',
      account_type: 'Lightning',
      initial_balance: 0,
      legacy_account_id: acct('1120'),
      connection_type: null,
      legacy_account_code: '1120',
    },
    {
      id: walletReservesId,
      name: 'Reserve Savings',
      asset: 'USD',
      account_type: 'Savings',
      initial_balance: 0,
      legacy_account_id: acct('1100'),
      connection_type: null,
      legacy_account_code: '1100',
    },
  ];

  // ── Contacts ─────────────────────────────────────────────────────────
  const c = (name: string, type: string, email?: string | null): TakeoutContact => ({
    id: U(), name, type, email: email ?? null, phone: null,
    street: null, city: null, state: null, zip: null, country: 'US',
  });
  const contactBeanfield = c('Beanfield Co-op', 'Vendor', 'orders@beanfield.example');
  const contactHappyCow = c('Happy Cow Dairy', 'Vendor', 'deliveries@happycow.example');
  const contactPacPower = c('Pacific Power Co.', 'Vendor', 'billing@pacpower.example');
  const contactFibreNet = c('FibreNet Internet', 'Vendor', 'billing@fibrenet.example');
  const contactDowntownHoldings = c('Downtown Holdings', 'Vendor', 'leases@downtownholdings.example');
  const contactSafeTech = c('SafeTech Insurance', 'Vendor', 'policies@safetech.example');
  const contactBrewEquipment = c('Brew Equipment Co.', 'Vendor', 'sales@brewequipment.example');

  const contactReGround = c('ReGround Compost Co.', 'Customer', 'pickups@reground.example');
  const contactArtisanMarket = c('Local Artisan Market', 'Customer', 'buying@artisanmarket.example');

  const contacts: TakeoutContact[] = [
    contactBeanfield, contactHappyCow, contactPacPower, contactFibreNet,
    contactDowntownHoldings, contactSafeTech, contactBrewEquipment,
    contactReGround, contactArtisanMarket,
  ];

  // ── Transactions + JEs ───────────────────────────────────────────────
  const transactions: TakeoutTransaction[] = [];
  const journal_entries: TakeoutJournalEntry[] = [];
  const journal_entry_lines: TakeoutJournalEntryLine[] = [];

  // Start Jan 1 of the current year so every seeded JE lands inside a
  // standard YTD filter — the default period on Insights — for a dense
  // demo narrative. Early in the year this produces a thinner seed; we
  // accept that trade-off over pre-YTD activity that gets hidden.
  const startDate = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const totalDays = Math.max(1, Math.floor((now.getTime() - startDate.getTime()) / 86400000));

  // Source amounts are USD (the wallet currency for this seed); we
  // translate to BTC at the date's seeded rate so each line carries
  // full dual-currency metadata and lands as dual_amounts_backfilled=true
  // under the primary=BTC org setting.
  function postJE(args: {
    date: string;
    memo: string;
    ref: string | null;
    drCode: string;
    crCode: string;
    amountUsd: number;
  }): string {
    const jeId = U();
    const jeDate = new Date(args.date + 'T00:00:00Z');
    const btcRate = btcRateForDate(jeDate);         // USD per BTC
    const amountUsd = round2(args.amountUsd);
    const amountBtc = round8(amountUsd / btcRate);  // BTC equivalent
    const postedRate = round8(1 / btcRate);         // BTC per USD
    journal_entries.push({
      id: jeId,
      date: args.date,
      memo: args.memo,
      ref_number: args.ref,
      currency: 'USD',
      exchange_rate: 1,
      status: 'POSTED',
      source_type: 'seed',
      period_locked: false,
    });
    journal_entry_lines.push({
      id: U(),
      journal_entry_id: jeId,
      account_id: acct(args.drCode),
      account_name: acctName(args.drCode),
      account_code: args.drCode,
      debit: amountUsd,
      credit: 0,
      description: args.memo,
      amount_native: amountUsd,
      amount_primary: amountBtc,
      posted_rate: postedRate,
      wallet_currency: 'USD',
      primary_currency_at_posting: 'BTC',
    });
    journal_entry_lines.push({
      id: U(),
      journal_entry_id: jeId,
      account_id: acct(args.crCode),
      account_name: acctName(args.crCode),
      account_code: args.crCode,
      debit: 0,
      credit: amountUsd,
      description: args.memo,
      amount_native: -amountUsd,
      amount_primary: -amountBtc,
      posted_rate: postedRate,
      wallet_currency: 'USD',
      primary_currency_at_posting: 'BTC',
    });
    return jeId;
  }

  // Transactions table is UI-level. Account linkage is on journal_entry_lines
  // + accounts.legacy_account_id. Contact linkage lives in the contacts table.
  function pushTx(args: {
    date: string;
    walletId: string | null;
    type: string;
    asset: string;
    amount: number;
    usd_value: number | null;
    memo: string;
  }) {
    transactions.push({
      id: U(),
      account_id: args.walletId,
      date: args.date,
      type: args.type,
      asset: args.asset,
      amount: round2(args.amount),
      usd_value: args.usd_value == null ? null : round2(args.usd_value),
      exchange_rate: null,
      memo: args.memo,
      status: 'POSTED',
      cleared_status: 'CLEARED',
    });
  }

  // ── Opening equity injection ─────────────────────────────────────────
  postJE({
    date: iso(startDate),
    memo: 'Initial capital contribution',
    ref: 'SEED-EQUITY-1',
    drCode: '1100', // Cash & Bank
    crCode: '3000', // Owner's Equity
    amountUsd: 35000,
  });

  // ── Espresso machine purchase (one-time, early) ──────────────────────
  postJE({
    date: iso(addDays(startDate, 4)),
    memo: 'La Marzocco espresso machine — Linea Mini',
    ref: 'HW-LM-001',
    drCode: '1600', // Equipment
    crCode: '1100', // Cash & Bank
    amountUsd: 18000,
  });
  pushTx({
    date: iso(addDays(startDate, 4)),
    walletId: walletOperatingId,
    type: 'EXPENSE',
    asset: 'USD',
    amount: -18000,
    usd_value: 18000,
    memo: 'Espresso machine — La Marzocco Linea Mini',
  });

  // ── Daily sales (aggregate per day) ──────────────────────────────────
  // Weekdays avg ~$850, weekends ~$1,200; small tail of BTC/Lightning.
  for (let d = 0; d < totalDays; d++) {
    const date = addDays(startDate, d);
    const dow = date.getUTCDay(); // 0 = Sun, 6 = Sat
    const isWeekend = dow === 0 || dow === 6;
    const base = isWeekend ? 1200 : 850;
    const usd = Math.max(200, base + (rand() - 0.5) * 300);

    // ~1 in 8 days see a noticeable Bitcoin payment burst via Lightning.
    const btcDay = rand() < 0.13;
    if (btcDay) {
      const btcUsdPortion = 40 + rand() * 120;
      const cashUsd = usd - btcUsdPortion;
      pushTx({
        date: iso(date),
        walletId: walletRegisterId,
        type: 'INCOME',
        asset: 'USD',
        amount: cashUsd,
        usd_value: cashUsd,
        memo: 'Daily sales — cash & card',
      });
      // BTC price model: $60k → $95k drift.
      const btcPrice = 60000 + d * 90 + (rand() - 0.5) * 4000;
      const btcAmount = btcUsdPortion / btcPrice;
      pushTx({
        date: iso(date),
        walletId: walletLightningId,
        type: 'INCOME',
        asset: 'BTC',
        amount: btcAmount,
        usd_value: btcUsdPortion,
        memo: 'Lightning sales — BTC received',
      });
      postJE({
        date: iso(date),
        memo: 'Daily sales',
        ref: null,
        drCode: '1110', // Fiat Cash Accounts
        crCode: '4100', // Sales Revenue
        amountUsd: cashUsd,
      });
      postJE({
        date: iso(date),
        memo: 'Lightning sales',
        ref: null,
        drCode: '1120', // Digital Asset Accounts
        crCode: '4100', // Sales Revenue
        amountUsd: btcUsdPortion,
      });
    } else {
      pushTx({
        date: iso(date),
        walletId: walletRegisterId,
        type: 'INCOME',
        asset: 'USD',
        amount: usd,
        usd_value: usd,
        memo: 'Daily sales — cash & card',
      });
      postJE({
        date: iso(date),
        memo: 'Daily sales',
        ref: null,
        drCode: '1110', // Fiat Cash Accounts
        crCode: '4100', // Sales Revenue
        amountUsd: usd,
      });
    }
  }

  // ── Weekly bean purchases (Wednesdays) ───────────────────────────────
  for (let d = 0; d < totalDays; d++) {
    const date = addDays(startDate, d);
    if (date.getUTCDay() !== 3) continue; // Wed
    const usd = 500 + (rand() - 0.5) * 180;
    pushTx({
      date: iso(date),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -usd,
      usd_value: usd,
      memo: 'Coffee beans — Beanfield Co-op',
    });
    postJE({
      date: iso(date),
      memo: 'COGS — beans',
      ref: null,
      drCode: '5100', // Cost of Goods Sold
      crCode: '1100', // Cash & Bank
      amountUsd: usd,
    });
  }

  // ── Weekly dairy purchases (Mondays) ─────────────────────────────────
  for (let d = 0; d < totalDays; d++) {
    const date = addDays(startDate, d);
    if (date.getUTCDay() !== 1) continue; // Mon
    const usd = 210 + (rand() - 0.5) * 60;
    pushTx({
      date: iso(date),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -usd,
      usd_value: usd,
      memo: 'Dairy delivery — Happy Cow',
    });
    postJE({
      date: iso(date),
      memo: 'COGS — dairy',
      ref: null,
      drCode: '5100',
      crCode: '1100',
      amountUsd: usd,
    });
  }

  // ── Monthly opex ─────────────────────────────────────────────────────
  function eachMonthOfDay(dayOfMonth: number, fn: (date: Date) => void) {
    const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), dayOfMonth));
    while (cursor <= now) {
      if (cursor >= startDate) fn(new Date(cursor));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  // Rent — day 1 of each month
  eachMonthOfDay(1, (date) => {
    const usd = 4800;
    pushTx({
      date: iso(date),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -usd,
      usd_value: usd,
      memo: 'Storefront rent — Downtown Holdings',
    });
    postJE({
      date: iso(date),
      memo: 'Rent',
      ref: null,
      drCode: '5300', // Rent Expense
      crCode: '1100',
      amountUsd: usd,
    });
  });

  // Utilities — day 5
  eachMonthOfDay(5, (date) => {
    const usd = 400 + (rand() - 0.5) * 120;
    pushTx({
      date: iso(date),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -usd,
      usd_value: usd,
      memo: 'Electricity & water — Pacific Power',
    });
    postJE({
      date: iso(date),
      memo: 'Utilities',
      ref: null,
      drCode: '5400',
      crCode: '1100',
      amountUsd: usd,
    });
  });

  // Internet — day 8
  eachMonthOfDay(8, (date) => {
    const usd = 120;
    pushTx({
      date: iso(date),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -usd,
      usd_value: usd,
      memo: 'Storefront internet — FibreNet',
    });
    postJE({
      date: iso(date),
      memo: 'Internet',
      ref: null,
      drCode: '5980', // Other Expenses
      crCode: '1100',
      amountUsd: usd,
    });
  });

  // Payroll — day 15 (2 baristas)
  eachMonthOfDay(15, (date) => {
    const usd = 8800 + (rand() - 0.5) * 400;
    pushTx({
      date: iso(date),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -usd,
      usd_value: usd,
      memo: 'Monthly payroll — 2 baristas',
    });
    postJE({
      date: iso(date),
      memo: 'Salaries & wages',
      ref: null,
      drCode: '5200',
      crCode: '1100',
      amountUsd: usd,
    });
  });

  // ── Quarterly items ──────────────────────────────────────────────────
  let quarterCount = 0;
  for (let m = 1; m < 6; m += 3) {
    const qDate = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth() + m, 20));
    if (qDate > now) break;
    quarterCount++;

    // Insurance premium — expense
    const insUsd = 600;
    pushTx({
      date: iso(qDate),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -insUsd,
      usd_value: insUsd,
      memo: 'Business insurance premium — SafeTech',
    });
    postJE({
      date: iso(qDate),
      memo: 'Insurance premium',
      ref: `INS-Q${quarterCount}`,
      drCode: '5500',
      crCode: '1100',
      amountUsd: insUsd,
    });

    // Circular-economy income #1: spent coffee grounds → compost partner
    const groundsUsd = 150 + rand() * 60;
    pushTx({
      date: iso(addDays(qDate, 3)),
      walletId: walletOperatingId,
      type: 'INCOME',
      asset: 'USD',
      amount: groundsUsd,
      usd_value: groundsUsd,
      memo: 'Spent grounds sold — ReGround Compost Co.',
    });
    postJE({
      date: iso(addDays(qDate, 3)),
      memo: 'Circular revenue — coffee grounds',
      ref: `CIRC-GROUNDS-Q${quarterCount}`,
      drCode: '1100',
      crCode: '4400', // Other Income
      amountUsd: groundsUsd,
    });

    // Circular-economy income #2: used burlap sacks → local artisan market
    const sacksUsd = 90 + rand() * 40;
    pushTx({
      date: iso(addDays(qDate, 6)),
      walletId: walletOperatingId,
      type: 'INCOME',
      asset: 'USD',
      amount: sacksUsd,
      usd_value: sacksUsd,
      memo: 'Used burlap sacks sold — Local Artisan Market',
    });
    postJE({
      date: iso(addDays(qDate, 6)),
      memo: 'Circular revenue — burlap upcycle',
      ref: `CIRC-SACKS-Q${quarterCount}`,
      drCode: '1100',
      crCode: '4400',
      amountUsd: sacksUsd,
    });
  }

  // ── Open receivables at "today" (wholesale invoices) ─────────────────
  const openInvoices: Array<{ contact: TakeoutContact; usd: number; daysAgo: number; ref: string }> = [
    { contact: contactArtisanMarket, usd: 320, daysAgo: 11, ref: 'INV-WS-042' },
    { contact: contactReGround, usd: 180, daysAgo: 18, ref: 'INV-GR-029' },
  ];
  for (const inv of openInvoices) {
    const date = iso(addDays(now, -inv.daysAgo));
    postJE({
      date,
      memo: `Open invoice — ${inv.contact.name}`,
      ref: inv.ref,
      drCode: '1200', // Accounts Receivable
      crCode: '4400', // Other Income (circular revenue yet to be paid)
      amountUsd: inv.usd,
    });
  }

  // ── Payment requests — full lifecycle for demo ──────────────────────
  // Mix of statuses to showcase the approvals + payments-made flow:
  // 2 PENDING (awaiting approval), 2 APPROVED (ready to pay),
  // 3 PAID (historical), 1 REJECTED (with reason).
  const payment_requests: TakeoutPaymentRequest[] = [
    // ── PENDING (awaiting approval) ──────────────────────────────────
    {
      id: U(),
      payee: contactBeanfield.name,
      description: 'Beans — current week restock',
      rejection_reason: null,
      amount: 520,
      currency: 'USD',
      status: 'PENDING',
      request_type: 'BILL',
      vendor_ref: 'BEAN-2026-15',
      payment_address: null,
      document_date: iso(addDays(now, -3)),
      due_date: iso(addDays(now, 11)),
      paid_at: null,
    },
    {
      id: U(),
      payee: contactBrewEquipment.name,
      description: 'Grinder replacement burrs',
      rejection_reason: null,
      amount: 240,
      currency: 'USD',
      status: 'PENDING',
      request_type: 'BILL',
      vendor_ref: 'BREW-BURRS-01',
      payment_address: null,
      document_date: iso(addDays(now, -5)),
      due_date: iso(addDays(now, 25)),
      paid_at: null,
    },
    // ── APPROVED (cleared to pay, not yet sent) ──────────────────────
    {
      id: U(),
      payee: contactHappyCow.name,
      description: 'Oat & dairy delivery — next week',
      rejection_reason: null,
      amount: 215,
      currency: 'USD',
      status: 'APPROVED',
      request_type: 'BILL',
      vendor_ref: 'COW-2026-16',
      payment_address: null,
      document_date: iso(addDays(now, -1)),
      due_date: iso(addDays(now, 6)),
      paid_at: null,
    },
    {
      id: U(),
      payee: contactPacPower.name,
      description: 'Electricity — current billing cycle',
      rejection_reason: null,
      amount: 385,
      currency: 'USD',
      status: 'APPROVED',
      request_type: 'BILL',
      vendor_ref: 'PAC-2026-04',
      payment_address: null,
      document_date: iso(addDays(now, -7)),
      due_date: iso(addDays(now, 8)),
      paid_at: null,
    },
    // ── PAID (historical, settled) ───────────────────────────────────
    {
      id: U(),
      payee: contactDowntownHoldings.name,
      description: 'Storefront rent — last month',
      rejection_reason: null,
      amount: 4800,
      currency: 'USD',
      status: 'PAID',
      request_type: 'BILL',
      vendor_ref: 'RENT-2026-03',
      payment_address: null,
      document_date: iso(addDays(now, -35)),
      due_date: iso(addDays(now, -31)),
      paid_at: iso(addDays(now, -30)) + 'T14:00:00Z',
    },
    {
      id: U(),
      payee: contactSafeTech.name,
      description: 'Quarterly insurance premium',
      rejection_reason: null,
      amount: 600,
      currency: 'USD',
      status: 'PAID',
      request_type: 'BILL',
      vendor_ref: 'INS-Q-LAST',
      payment_address: null,
      document_date: iso(addDays(now, -20)),
      due_date: iso(addDays(now, -13)),
      paid_at: iso(addDays(now, -13)) + 'T09:30:00Z',
    },
    {
      id: U(),
      payee: contactBeanfield.name,
      description: 'Bulk single-origin order (Colombia)',
      rejection_reason: null,
      amount: 1450,
      currency: 'USD',
      status: 'PAID',
      request_type: 'BILL',
      vendor_ref: 'BEAN-BULK-Q1',
      payment_address: null,
      document_date: iso(addDays(now, -10)),
      due_date: iso(addDays(now, -3)),
      paid_at: iso(addDays(now, -4)) + 'T11:15:00Z',
    },
    // ── REJECTED (with reason) ───────────────────────────────────────
    {
      id: U(),
      payee: 'Fitness Studio Downtown',
      description: 'Staff wellness membership — 12 months',
      rejection_reason: 'Outside Q2 training budget; revisit in Q3 planning cycle.',
      amount: 2880,
      currency: 'USD',
      status: 'REJECTED',
      request_type: 'BILL',
      vendor_ref: 'WELL-STAFF-12',
      payment_address: null,
      document_date: iso(addDays(now, -12)),
      due_date: iso(addDays(now, 18)),
      paid_at: null,
    },
  ];

  const data: TakeoutData = {
    organizations: [{
      id: orgId,
      name: 'Common Grounds Coffee Co.',
      external_journal_id: null,
    }],
    org_settings: [{
      bitcoin_display: 'sats',
      primary_currency: 'BTC',
      secondary_currency: 'USD',
    }],
    wallets,
    chart_of_accounts,
    contacts,
    transactions,
    journal_entries,
    journal_entry_lines,
    payment_requests,
    attachments: [],
  };

  return {
    _meta: {
      version: TAKEOUT_VERSION,
      exportedAt: now.toISOString(),
      encryption: 'none',
      sourceOrgName: 'Common Grounds Coffee Co. (seed)',
      sourceOrgId: orgId,
      tables: Object.keys(data),
    },
    data,
  };
}
