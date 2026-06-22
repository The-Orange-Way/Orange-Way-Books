/**
 * Miner-company sample dataset generator.
 *
 * Produces a TakeoutFile with ~18 months of realistic activity for a
 * small bitcoin mining operation:
 *   - Daily mining rewards (ramping up over time)
 *   - Weekly hosting-fee revenue from 3 clients
 *   - Monthly opex (electricity, internet, insurance, salaries, pro services)
 *   - Quarterly maintenance, BTC-to-USD sales, hardware upgrades
 *   - A handful of open receivables at the current date
 *
 * Primary currency USD, secondary BTC. All JE lines are in USD so KPI
 * and working-capital aggregates sum correctly under the current
 * single-currency-per-line model.
 *
 * Numbers are shaped to make the Insights dashboard interesting:
 * revenue trends up YoY, expenses have a clear leader (electricity),
 * net profit is positive most quarters but dips on hardware purchases.
 */

import {
  TAKEOUT_VERSION,
  type TakeoutFile,
  type TakeoutData,
  type TakeoutLegacyAccount,
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
// Pure function of the date so every call with the same date returns
// the same rate, keeping seed round-trips reproducible.
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
  code: string;
  name: string;
  type: string;
  group: string;
  normal: 'DEBIT' | 'CREDIT';
}
// accountType uses PascalCase — the Insights Expenses card does a
// case-sensitive === 'Expense' match, and the ledger engine
// lowercases for its 'revenue'/'expense'/'asset' checks, so PascalCase
// satisfies both. account group labels are specific enough to feed
// the working-capital filter (`includes('cash'|'bank'|'receivable'|
// 'payable'|'credit card')`) without overlap.
const ACCOUNTS: AccountDef[] = [
  { code: '1000', name: 'Accounts', type: 'Asset', group: 'Cash', normal: 'DEBIT' },
  { code: '1100', name: 'Cash & Bank', type: 'Asset', group: 'Bank', normal: 'DEBIT' },
  { code: '1110', name: 'Fiat Cash Accounts', type: 'Asset', group: 'Cash', normal: 'DEBIT' },
  { code: '1120', name: 'Digital Asset Accounts', type: 'Asset', group: 'Cash', normal: 'DEBIT' },
  {
    code: '1200',
    name: 'Accounts Receivable',
    type: 'Asset',
    group: 'Accounts Receivable',
    normal: 'DEBIT',
  },
  {
    code: '1300',
    name: 'Prepaid Expenses',
    type: 'Asset',
    group: 'Prepaid Expenses',
    normal: 'DEBIT',
  },
  { code: '1305', name: 'Inventory', type: 'Asset', group: 'Inventory', normal: 'DEBIT' },
  { code: '1500', name: 'Transfer Clearing', type: 'Asset', group: 'Cash', normal: 'DEBIT' },
  { code: '1600', name: 'Equipment', type: 'Asset', group: 'Equipment', normal: 'DEBIT' },
  { code: '1700', name: 'Other Assets', type: 'Asset', group: 'Other Assets', normal: 'DEBIT' },
  {
    code: '2000',
    name: 'Liabilities',
    type: 'Liability',
    group: 'Current Liabilities',
    normal: 'CREDIT',
  },
  {
    code: '2100',
    name: 'Current Liabilities',
    type: 'Liability',
    group: 'Current Liabilities',
    normal: 'CREDIT',
  },
  {
    code: '2110',
    name: 'Accounts Payable',
    type: 'Liability',
    group: 'Accounts Payable',
    normal: 'CREDIT',
  },
  {
    code: '2120',
    name: 'Credit Cards',
    type: 'Liability',
    group: 'Credit Cards',
    normal: 'CREDIT',
  },
  {
    code: '2130',
    name: 'Sales Tax Payable',
    type: 'Liability',
    group: 'Current Liabilities',
    normal: 'CREDIT',
  },
  {
    code: '2140',
    name: 'Payroll Liabilities',
    type: 'Liability',
    group: 'Current Liabilities',
    normal: 'CREDIT',
  },
  {
    code: '2200',
    name: 'Long-Term Liabilities',
    type: 'Liability',
    group: 'Long-Term Liabilities',
    normal: 'CREDIT',
  },
  {
    code: '2210',
    name: 'Notes Payable',
    type: 'Liability',
    group: 'Long-Term Liabilities',
    normal: 'CREDIT',
  },
  {
    code: '2220',
    name: 'Mortgage Payable',
    type: 'Liability',
    group: 'Long-Term Liabilities',
    normal: 'CREDIT',
  },
  { code: '3000', name: "Owner's Equity", type: 'Equity', group: 'Equity', normal: 'CREDIT' },
  { code: '3100', name: 'Starting Balance', type: 'Equity', group: 'Equity', normal: 'CREDIT' },
  { code: '3200', name: 'Retained Earnings', type: 'Equity', group: 'Equity', normal: 'CREDIT' },
  { code: '3300', name: 'Dividends Paid', type: 'Equity', group: 'Equity', normal: 'DEBIT' },
  { code: '4000', name: 'Sales', type: 'Income', group: 'Revenue', normal: 'CREDIT' },
  { code: '4100', name: 'Sales Revenue', type: 'Income', group: 'Revenue', normal: 'CREDIT' },
  { code: '4200', name: 'Service Revenue', type: 'Income', group: 'Revenue', normal: 'CREDIT' },
  {
    code: '4300',
    name: 'Interest Income',
    type: 'Income',
    group: 'Other Income',
    normal: 'CREDIT',
  },
  { code: '4400', name: 'Other Income', type: 'Income', group: 'Other Income', normal: 'CREDIT' },
  {
    code: '4500',
    name: 'Gain on Sale of Assets',
    type: 'Income',
    group: 'Other Income',
    normal: 'CREDIT',
  },
  {
    code: '4600',
    name: 'Unrealized Gains',
    type: 'Income',
    group: 'Other Income',
    normal: 'CREDIT',
  },
  {
    code: '5000',
    name: 'Cost of Goods Sold',
    type: 'Expense',
    group: 'Cost of Sales',
    normal: 'DEBIT',
  },
  { code: '5200', name: 'Salaries & Wages', type: 'Expense', group: 'Payroll', normal: 'DEBIT' },
  { code: '5300', name: 'Rent Expense', type: 'Expense', group: 'Rent', normal: 'DEBIT' },
  { code: '5400', name: 'Utilities', type: 'Expense', group: 'Utilities', normal: 'DEBIT' },
  { code: '5500', name: 'Insurance', type: 'Expense', group: 'Insurance', normal: 'DEBIT' },
  { code: '5600', name: 'Depreciation', type: 'Expense', group: 'Depreciation', normal: 'DEBIT' },
  {
    code: '5700',
    name: 'Marketing & Advertising',
    type: 'Expense',
    group: 'Marketing',
    normal: 'DEBIT',
  },
  {
    code: '5800',
    name: 'Professional Services',
    type: 'Expense',
    group: 'Professional Services',
    normal: 'DEBIT',
  },
  {
    code: '5900',
    name: 'Travel & Entertainment',
    type: 'Expense',
    group: 'Travel',
    normal: 'DEBIT',
  },
  {
    code: '5950',
    name: 'Bank & Transaction Fees',
    type: 'Expense',
    group: 'Bank Fees',
    normal: 'DEBIT',
  },
  {
    code: '5960',
    name: 'Loss on Sale of Assets',
    type: 'Expense',
    group: 'Other Expenses',
    normal: 'DEBIT',
  },
  {
    code: '5970',
    name: 'Unrealized Losses',
    type: 'Expense',
    group: 'Other Expenses',
    normal: 'DEBIT',
  },
  {
    code: '5980',
    name: 'Other Expenses',
    type: 'Expense',
    group: 'Other Expenses',
    normal: 'DEBIT',
  },
];

export function generateMinerCompany(now: Date = new Date()): TakeoutFile {
  const rand = mulberry32(0xdeadbeef);
  const orgId = U();

  // ── Chart of accounts ────────────────────────────────────────────────
  const accountMap = new Map<string, TakeoutLegacyAccount>(); // code -> row
  const chart_of_accounts: TakeoutLegacyAccount[] = ACCOUNTS.map((a) => {
    const row: TakeoutLegacyAccount = {
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
  const walletMiningPayoutId = U();
  const walletColdStorageId = U();
  const walletOperatingId = U();
  const walletLightningId = U();
  const wallets: TakeoutWallet[] = [
    {
      id: walletMiningPayoutId,
      name: 'Mining Payout Wallet',
      asset: 'BTC',
      account_type: 'Hot Wallet',
      initial_balance: 0,
      legacy_account_id: acct('1120'),
      connection_type: null,
      legacy_account_code: '1120',
    },
    {
      id: walletColdStorageId,
      name: 'Cold Storage Vault',
      asset: 'BTC',
      account_type: 'Cold Storage',
      initial_balance: 0,
      legacy_account_id: acct('1120'),
      connection_type: null,
      legacy_account_code: '1120',
    },
    {
      id: walletOperatingId,
      name: 'Operating Account',
      asset: 'USD',
      account_type: 'Bank',
      initial_balance: 50000,
      legacy_account_id: acct('1100'),
      connection_type: null,
      legacy_account_code: '1100',
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
  ];

  // ── Contacts ─────────────────────────────────────────────────────────
  const c = (name: string, type: string, email?: string | null): TakeoutContact => ({
    id: U(),
    name,
    type,
    email: email ?? null,
    phone: null,
    street: null,
    city: null,
    state: null,
    zip: null,
    country: 'US',
  });
  const contactPacPower = c('Pacific Power Co.', 'Vendor', 'billing@pacpower.example');
  const contactFoundry = c('Foundry USA Pool', 'Vendor', 'payouts@foundry.example');
  const contactCryptoHost = c('CryptoHost Inc.', 'Vendor', 'ops@cryptohost.example');
  const contactBitmain = c('Bitmain Reseller', 'Vendor', 'sales@bitmain.example');
  const contactMesaMining = c('Mesa Mining Services', 'Vendor', 'dispatch@mesamining.example');
  const contactSafeTech = c('SafeTech Insurance', 'Vendor', 'policies@safetech.example');
  const contactProfServ = c('Ledger & Sons CPAs', 'Vendor', 'billing@ledgerandsons.example');

  const contactTechStartup = c('TechStartup LLC', 'Customer', 'ap@techstartup.example');
  const contactDataCenter = c('DataCenter Co.', 'Customer', 'finance@datacenter.example');
  const contactMiningCorp = c('MiningCorp Holdings', 'Customer', 'ar@miningcorp.example');

  const contacts: TakeoutContact[] = [
    contactPacPower,
    contactFoundry,
    contactCryptoHost,
    contactBitmain,
    contactMesaMining,
    contactSafeTech,
    contactProfServ,
    contactTechStartup,
    contactDataCenter,
    contactMiningCorp,
  ];

  // ── Transactions + JEs ───────────────────────────────────────────────
  const transactions: TakeoutTransaction[] = [];
  const journal_entries: TakeoutJournalEntry[] = [];
  const journal_entry_lines: TakeoutJournalEntryLine[] = [];

  const startDate = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth() - 4, 1));
  const totalDays = Math.max(1, Math.floor((now.getTime() - startDate.getTime()) / 86400000));

  // Helpers to push a JE with two balanced lines. Source amounts are USD
  // (the wallet currency for this seed); we translate to BTC at the date's
  // seeded rate so each line carries full dual-currency metadata and lands
  // as `dual_amounts_backfilled=true` under the primary=BTC org setting.
  function postJE(args: {
    date: string;
    memo: string;
    ref: string | null;
    drCode: string;
    crCode: string;
    amountUsd: number;
    drDescription?: string;
    crDescription?: string;
  }): string {
    const jeId = U();
    const jeDate = new Date(args.date + 'T00:00:00Z');
    const btcRate = btcRateForDate(jeDate); // USD per BTC
    const amountUsd = round2(args.amountUsd);
    const amountBtc = round8(amountUsd / btcRate); // BTC equivalent
    const postedRate = round8(1 / btcRate); // BTC per USD
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
      description: args.drDescription ?? args.memo,
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
      description: args.crDescription ?? args.memo,
      amount_native: -amountUsd,
      amount_primary: -amountBtc,
      posted_rate: postedRate,
      wallet_currency: 'USD',
      primary_currency_at_posting: 'BTC',
    });
    return jeId;
  }

  // Transactions table is a UI-level wallet-movement record. Account
  // linkage travels through journal_entry_lines + accounts.legacy_account_id,
  // not a column on this row. Contact linkage lives in the contacts table
  // and (once the takeout format supports encrypted_metadata round-trip)
  // will flow via the encrypted_metadata JSONB column — dropped here for now.
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
    amountUsd: 250000,
  });

  // ── Initial ASIC fleet purchase via credit card ──────────────────────
  postJE({
    date: iso(addDays(startDate, 3)),
    memo: 'ASIC fleet purchase — 40 miners',
    ref: 'HW-2025-001',
    drCode: '1600', // Equipment
    crCode: '2120', // Credit Cards
    amountUsd: 210000,
  });
  pushTx({
    date: iso(addDays(startDate, 3)),
    walletId: null,
    type: 'EXPENSE',
    asset: 'USD',
    amount: -210000,
    usd_value: 210000,
    memo: 'ASIC fleet purchase — 40 miners',
  });

  // ── Daily mining rewards ─────────────────────────────────────────────
  // BTC price model: starts around $60k, drifts up with noise.
  function btcPrice(dayIndex: number): number {
    const ramp = 60000 + dayIndex * 45;
    const noise = (rand() - 0.5) * 6000;
    return Math.max(30000, ramp + noise);
  }
  // Hashrate / reward ramps up: first 3 months at small size, then growth.
  function dailyReward(dayIndex: number): number {
    const base = 0.025 + Math.min(dayIndex, 180) * 0.00012 + dayIndex * 0.00005;
    const noise = (rand() - 0.5) * 0.012;
    return Math.max(0.01, base + noise);
  }

  for (let d = 0; d < totalDays; d++) {
    const date = addDays(startDate, d);
    const reward = dailyReward(d);
    const price = btcPrice(d);
    const usd = reward * price;
    pushTx({
      date: iso(date),
      walletId: walletMiningPayoutId,
      type: 'INCOME',
      asset: 'BTC',
      amount: reward,
      usd_value: usd,
      memo: 'Daily mining payout',
    });
    postJE({
      date: iso(date),
      memo: 'Mining payout',
      ref: null,
      drCode: '1120', // Digital Asset Accounts
      crCode: '4300', // Interest Income
      amountUsd: usd,
    });
  }

  // ── Weekly hosting fee revenue (3 clients, different volumes) ────────
  const hostingClients = [
    { contact: contactTechStartup, weeklyUsd: 4800 },
    { contact: contactDataCenter, weeklyUsd: 3200 },
    { contact: contactMiningCorp, weeklyUsd: 2500 },
  ];
  for (let w = 1; w * 7 < totalDays; w++) {
    const date = addDays(startDate, w * 7);
    for (const hc of hostingClients) {
      const usd = hc.weeklyUsd + (rand() - 0.5) * 300;
      pushTx({
        date: iso(date),
        walletId: walletOperatingId,
        type: 'INCOME',
        asset: 'USD',
        amount: usd,
        usd_value: usd,
        memo: `Hosting fee — ${hc.contact.name}`,
      });
      postJE({
        date: iso(date),
        memo: `Hosting revenue — ${hc.contact.name}`,
        ref: null,
        drCode: '1100',
        crCode: '4200',
        amountUsd: usd,
      });
    }
  }

  // ── Monthly opex ─────────────────────────────────────────────────────
  function eachMonthOfFirst(dayOfMonth: number, fn: (date: Date) => void) {
    const cursor = new Date(
      Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), dayOfMonth),
    );
    while (cursor <= now) {
      if (cursor >= startDate) fn(new Date(cursor));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
  }

  // Electricity — biggest expense, with seasonal noise
  eachMonthOfFirst(5, (date) => {
    const base = 19000 + (date.getUTCMonth() >= 5 && date.getUTCMonth() <= 8 ? 4200 : 0);
    const usd = base + (rand() - 0.5) * 1600;
    pushTx({
      date: iso(date),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -usd,
      usd_value: usd,
      memo: 'Electricity — Pacific Power',
    });
    postJE({
      date: iso(date),
      memo: 'Electricity bill',
      ref: null,
      drCode: '5400',
      crCode: '1100',
      amountUsd: usd,
    });
  });

  // Internet + colo hosting infrastructure
  eachMonthOfFirst(8, (date) => {
    const usd = 2800 + (rand() - 0.5) * 120;
    pushTx({
      date: iso(date),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -usd,
      usd_value: usd,
      memo: 'Colo hosting — CryptoHost',
    });
    postJE({
      date: iso(date),
      memo: 'Colo hosting',
      ref: null,
      drCode: '5980',
      crCode: '1100',
      amountUsd: usd,
    });
  });

  // Insurance
  eachMonthOfFirst(10, (date) => {
    const usd = 1200;
    pushTx({
      date: iso(date),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -usd,
      usd_value: usd,
      memo: 'Equipment insurance',
    });
    postJE({
      date: iso(date),
      memo: 'Equipment insurance',
      ref: null,
      drCode: '5500',
      crCode: '1100',
      amountUsd: usd,
    });
  });

  // Payroll (simulated — 2 employees)
  eachMonthOfFirst(15, (date) => {
    const usd = 15000 + (rand() - 0.5) * 500;
    pushTx({
      date: iso(date),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -usd,
      usd_value: usd,
      memo: 'Monthly payroll',
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

  // Professional services — monthly bookkeeping
  eachMonthOfFirst(20, (date) => {
    const usd = 800;
    pushTx({
      date: iso(date),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -usd,
      usd_value: usd,
      memo: 'Bookkeeping services',
    });
    postJE({
      date: iso(date),
      memo: 'Professional services',
      ref: null,
      drCode: '5800',
      crCode: '1100',
      amountUsd: usd,
    });
  });

  // Marketing — sporadic
  eachMonthOfFirst(22, (date) => {
    if (rand() > 0.4) return;
    const usd = 450 + rand() * 800;
    pushTx({
      date: iso(date),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -usd,
      usd_value: usd,
      memo: 'Digital ad spend',
    });
    postJE({
      date: iso(date),
      memo: 'Marketing',
      ref: null,
      drCode: '5700',
      crCode: '1100',
      amountUsd: usd,
    });
  });

  // ── Quarterly items ──────────────────────────────────────────────────
  let quarterCount = 0;
  for (let m = 2; m < 18; m += 3) {
    const qDate = addDays(startDate, m * 30);
    if (qDate > now) break;
    quarterCount++;

    // Maintenance
    const maintUsd = 7500 + (rand() - 0.5) * 900;
    pushTx({
      date: iso(qDate),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -maintUsd,
      usd_value: maintUsd,
      memo: 'Quarterly preventive maintenance',
    });
    postJE({
      date: iso(qDate),
      memo: 'Quarterly maintenance',
      ref: `MAINT-Q${quarterCount}`,
      drCode: '5980',
      crCode: '1100',
      amountUsd: maintUsd,
    });

    // BTC sale to USD to cover cash needs
    const btcSold = 0.9 + rand() * 0.8;
    const price = btcPrice(m * 30);
    const saleUsd = btcSold * price;
    pushTx({
      date: iso(qDate),
      walletId: walletColdStorageId,
      type: 'TRANSFER',
      asset: 'BTC',
      amount: -btcSold,
      usd_value: saleUsd,
      memo: 'BTC sale to cover opex',
    });
    pushTx({
      date: iso(qDate),
      walletId: walletOperatingId,
      type: 'TRANSFER',
      asset: 'USD',
      amount: saleUsd,
      usd_value: saleUsd,
      memo: 'USD proceeds from BTC sale',
    });
    postJE({
      date: iso(qDate),
      memo: 'BTC to USD conversion',
      ref: `BTC-SALE-Q${quarterCount}`,
      drCode: '1100',
      crCode: '1120',
      amountUsd: saleUsd,
    });

    // Hardware upgrade — only in quarters 2 and 4
    if (quarterCount === 2 || quarterCount === 4) {
      const hwUsd = 45000 + rand() * 18000;
      pushTx({
        date: iso(addDays(qDate, 2)),
        walletId: null,
        type: 'EXPENSE',
        asset: 'USD',
        amount: -hwUsd,
        usd_value: hwUsd,
        memo: 'ASIC expansion — hardware upgrade',
      });
      postJE({
        date: iso(addDays(qDate, 2)),
        memo: 'Hardware upgrade',
        ref: `HW-Q${quarterCount}`,
        drCode: '1600',
        crCode: '2120',
        amountUsd: hwUsd,
      });
    }

    // Quarterly depreciation JE
    postJE({
      date: iso(addDays(qDate, 30)),
      memo: 'Quarterly depreciation — ASIC fleet',
      ref: `DEPR-Q${quarterCount}`,
      drCode: '5600',
      crCode: '1600',
      amountUsd: 18000,
    });

    // Credit card pay-down (monthly-ish, grouped here)
    const ccPayment = 35000 + rand() * 10000;
    pushTx({
      date: iso(addDays(qDate, 10)),
      walletId: walletOperatingId,
      type: 'EXPENSE',
      asset: 'USD',
      amount: -ccPayment,
      usd_value: ccPayment,
      memo: 'Credit card payment',
    });
    postJE({
      date: iso(addDays(qDate, 10)),
      memo: 'Credit card payment',
      ref: null,
      drCode: '2120',
      crCode: '1100',
      amountUsd: ccPayment,
    });
  }

  // ── Open receivables at "today" (hosting invoices not yet paid) ──────
  // Makes Working Capital > cash-on-hand and Receivables > 0.
  const openInvoices: Array<{
    contact: TakeoutContact;
    usd: number;
    daysAgo: number;
    ref: string;
  }> = [
    { contact: contactTechStartup, usd: 9600, daysAgo: 8, ref: 'INV-2026-041' },
    { contact: contactDataCenter, usd: 3200, daysAgo: 14, ref: 'INV-2026-038' },
    { contact: contactMiningCorp, usd: 5200, daysAgo: 21, ref: 'INV-2026-034' },
  ];
  for (const inv of openInvoices) {
    const date = iso(addDays(now, -inv.daysAgo));
    postJE({
      date,
      memo: `Open invoice — ${inv.contact.name}`,
      ref: inv.ref,
      drCode: '1200', // Accounts Receivable
      crCode: '4200', // Service Revenue
      amountUsd: inv.usd,
    });
  }

  // ── Payment requests (a couple of unpaid bills) ──────────────────────
  // Full payment lifecycle for demo — mix of statuses to showcase the
  // approvals + payments-made flow.
  const payment_requests: TakeoutPaymentRequest[] = [
    // ── PENDING (awaiting approval) ──────────────────────────────────
    {
      id: U(),
      payee: contactPacPower.name,
      description: 'Electricity — current period (est.)',
      rejection_reason: null,
      amount: 21500,
      currency: 'USD',
      status: 'PENDING',
      request_type: 'BILL',
      vendor_ref: 'PAC-2026-04',
      payment_address: null,
      document_date: iso(addDays(now, -4)),
      due_date: iso(addDays(now, 12)),
      paid_at: null,
    },
    {
      id: U(),
      payee: contactSafeTech.name,
      description: 'Insurance renewal quote',
      rejection_reason: null,
      amount: 14400,
      currency: 'USD',
      status: 'PENDING',
      request_type: 'BILL',
      vendor_ref: 'SAFE-2026-RENEW',
      payment_address: null,
      document_date: iso(addDays(now, -6)),
      due_date: iso(addDays(now, 24)),
      paid_at: null,
    },
    // ── APPROVED (cleared to pay, not yet sent) ──────────────────────
    {
      id: U(),
      payee: contactCryptoHost.name,
      description: 'Colo hosting — next month',
      rejection_reason: null,
      amount: 2800,
      currency: 'USD',
      status: 'APPROVED',
      request_type: 'BILL',
      vendor_ref: 'COLO-2026-NXT',
      payment_address: null,
      document_date: iso(addDays(now, -2)),
      due_date: iso(addDays(now, 6)),
      paid_at: null,
    },
    {
      id: U(),
      payee: contactMesaMining.name,
      description: 'ASIC repair parts — hashboard replacements',
      rejection_reason: null,
      amount: 3600,
      currency: 'USD',
      status: 'APPROVED',
      request_type: 'BILL',
      vendor_ref: 'MESA-PARTS-08',
      payment_address: null,
      document_date: iso(addDays(now, -5)),
      due_date: iso(addDays(now, 10)),
      paid_at: null,
    },
    // ── PAID (historical, settled) ───────────────────────────────────
    {
      id: U(),
      payee: contactPacPower.name,
      description: 'Electricity — last period',
      rejection_reason: null,
      amount: 20800,
      currency: 'USD',
      status: 'PAID',
      request_type: 'BILL',
      vendor_ref: 'PAC-2026-03',
      payment_address: null,
      document_date: iso(addDays(now, -40)),
      due_date: iso(addDays(now, -25)),
      paid_at: iso(addDays(now, -27)) + 'T10:00:00Z',
    },
    {
      id: U(),
      payee: contactProfServ.name,
      description: 'Monthly bookkeeping — last month',
      rejection_reason: null,
      amount: 800,
      currency: 'USD',
      status: 'PAID',
      request_type: 'BILL',
      vendor_ref: 'BOOK-MAR',
      payment_address: null,
      document_date: iso(addDays(now, -18)),
      due_date: iso(addDays(now, -11)),
      paid_at: iso(addDays(now, -12)) + 'T15:45:00Z',
    },
    {
      id: U(),
      payee: contactFoundry.name,
      description: 'Mining pool settlement — periodic true-up',
      rejection_reason: null,
      amount: 1250,
      currency: 'USD',
      status: 'PAID',
      request_type: 'BILL',
      vendor_ref: 'FOUNDRY-TRUEUP',
      payment_address: null,
      document_date: iso(addDays(now, -9)),
      due_date: iso(addDays(now, -2)),
      paid_at: iso(addDays(now, -3)) + 'T13:20:00Z',
    },
    // ── REJECTED (with reason) ───────────────────────────────────────
    {
      id: U(),
      payee: 'Bitcoin Miami 2026 — Sponsorship',
      description: 'Booth + branding package',
      rejection_reason:
        'Exceeds annual marketing budget; revisit at next board cycle with co-sponsor.',
      amount: 18500,
      currency: 'USD',
      status: 'REJECTED',
      request_type: 'BILL',
      vendor_ref: 'BTCMIAMI-2026-BOOTH',
      payment_address: null,
      document_date: iso(addDays(now, -14)),
      due_date: iso(addDays(now, 20)),
      paid_at: null,
    },
  ];

  const data: TakeoutData = {
    organizations: [
      {
        id: orgId,
        name: 'Sierra Bitcoin Mining Co.',
        external_journal_id: null,
      },
    ],
    org_settings: [
      {
        bitcoin_display: 'sats',
        primary_currency: 'BTC',
        secondary_currency: 'USD',
      },
    ],
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
      sourceOrgName: 'Sierra Bitcoin Mining Co. (seed)',
      sourceOrgId: orgId,
      tables: Object.keys(data),
    },
    data,
  };
}
