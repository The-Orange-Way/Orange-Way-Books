/**
 * FX revaluation engine, monetary-item remeasurement.
 *
 * IAS 21 / ASC 830: At period close, remeasure all monetary balance-sheet items
 * denominated in a foreign currency at the closing rate. The delta posts as
 * Unrealized FX Gain/Loss in P&L. On period open (next day), auto-reverse the
 * entry so the B/S is clean for the new period.
 */

import { supabase } from '@/lib/supabase';
import { resolvePinnedRate } from '@/lib/exchange/rate-resolver';
import { classifyMonetary } from './classify-monetary';
import type { AccountInfo, AccountBalance } from '@/lib/ledger-engine';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RevaluationLinePreview {
  accountId: string;
  accountName: string;
  currency: string;
  balanceNative: number; // in wallet currency
  pinnedPrimary: number; // sum of amount_primary from JE lines (existing)
  currentPrimary: number; // balanceNative × closingRate
  delta: number; // currentPrimary − pinnedPrimary
  closingRate: number;
  rateDate: string;
}

export interface RevaluationPreview {
  lines: RevaluationLinePreview[];
  totalGain: number; // sum of positive deltas
  totalLoss: number; // sum of negative deltas (absolute value)
  netDelta: number; // totalGain − totalLoss
  periodEnd: string;
  reverseOn: string; // periodEnd + 1 day
  framework: string;
}

export interface RevaluationRunParams {
  orgId: string;
  periodEnd: string; // ISO date YYYY-MM-DD
  primaryCurrency: string;
  framework: string; // 'IFRS' | 'US_GAAP' | 'IFRS_AND_GAAP'
  method: string; // 'closing-rate' | 'period-average' | 'historical-per-transaction'
  accounts: AccountInfo[];
  balances: AccountBalance[]; // from computeAccountBalances at period end
  /** walletCurrencies: accountId → native currency (from wallets joined to chart_of_accounts) */
  walletCurrencies: Map<string, string>;
  /** overrides: accountId → is_monetary (user-set) */
  monetaryOverrides?: Map<string, boolean>;
}

function addOneDay(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ── Preview (read-only) ────────────────────────────────────────────────────────

/**
 * Compute a revaluation preview without writing to the DB.
 * Called before the user confirms.
 */
export async function previewRevaluation(
  params: RevaluationRunParams,
): Promise<RevaluationPreview> {
  const {
    accounts,
    balances,
    walletCurrencies,
    monetaryOverrides,
    primaryCurrency,
    periodEnd,
    framework,
  } = params;

  const balanceByAccount = new Map(balances.map((b) => [b.accountId, b]));

  const lines: RevaluationLinePreview[] = [];

  for (const account of accounts) {
    const override = monetaryOverrides?.get(account.id) ?? null;
    if (classifyMonetary(account, override) !== 'monetary') continue;

    const walletCurrency = walletCurrencies.get(account.id);
    if (!walletCurrency || walletCurrency.toUpperCase() === primaryCurrency.toUpperCase()) continue;

    const balance = balanceByAccount.get(account.id);
    if (!balance) continue;

    // Native balance = debits − credits (asset convention; flip for liabilities if needed)
    const balanceNative = balance.totalDebits - balance.totalCredits;
    if (Math.abs(balanceNative) < 1e-10) continue;

    // Fetch closing rate at period end
    let closingRate = 0;
    let rateDate = periodEnd;
    try {
      const resolved = await resolvePinnedRate({
        source: walletCurrency,
        target: primaryCurrency,
        at: periodEnd,
      });
      if (resolved.pending) continue; // skip, rate not available
      closingRate = resolved.rate;
      rateDate = resolved.bucketTs.slice(0, 10);
    } catch {
      continue;
    }

    const currentPrimary = balanceNative * closingRate;
    // pinnedPrimary comes from the sum of amount_primary on JE lines.
    // For preview, we approximate using total debits/credits (which are
    // already in primary currency from the write path).
    const pinnedPrimary = balance.totalDebits - balance.totalCredits;
    const delta = currentPrimary - pinnedPrimary;

    if (Math.abs(delta) < 1e-10) continue;

    lines.push({
      accountId: account.id,
      accountName: account.name,
      currency: walletCurrency,
      balanceNative,
      pinnedPrimary,
      currentPrimary,
      delta,
      closingRate,
      rateDate,
    });
  }

  const gains = lines.filter((l) => l.delta > 0);
  const losses = lines.filter((l) => l.delta < 0);

  return {
    lines,
    totalGain: gains.reduce((s, l) => s + l.delta, 0),
    totalLoss: Math.abs(losses.reduce((s, l) => s + l.delta, 0)),
    netDelta: lines.reduce((s, l) => s + l.delta, 0),
    periodEnd,
    reverseOn: addOneDay(periodEnd),
    framework,
  };
}

// ── Post (writes to DB) ────────────────────────────────────────────────────────

export interface RevaluationRunResult {
  runId: string;
  jeId: string | null;
  reverseJeId: string | null;
  preview: RevaluationPreview;
}

/**
 * Post a revaluation run: insert fx_revaluation_runs row + linked JE stubs.
 *
 * The actual JE lines are recorded as a draft run. The UI shows them before
 * the user confirms. On confirm, status transitions to 'posted'.
 *
 * Note: Full encrypted JE creation requires the vault key (encryptText).
 * This function stores plaintext amounts as a draft only, the RevaluationWizard
 * handles the final encrypt+insert with the vault context.
 */
export async function postRevaluation(
  preview: RevaluationPreview,
  orgId: string,
  userId: string,
  notes?: string,
): Promise<RevaluationRunResult> {
  // Insert the revaluation run record
  const { data: run, error: runErr } = await supabase
    .from('fx_revaluation_runs' as any)
    .insert({
      org_id: orgId,
      period_start: null, // not tracked for MVP
      period_end: preview.periodEnd,
      run_by: userId,
      framework: preview.framework,
      method: 'closing-rate',
      status: 'draft',
      reverse_on: preview.reverseOn,
      notes: notes ?? null,
    })
    .select('id')
    .single();

  if (runErr || !run) {
    throw new Error(`Failed to create revaluation run: ${runErr?.message}`);
  }

  return {
    runId: (run as any).id,
    jeId: null, // set after JE is created in the wizard
    reverseJeId: null,
    preview,
  };
}

/**
 * Update a revaluation run to 'posted' status with its JE id.
 */
export async function confirmRevaluation(runId: string, jeId: string): Promise<void> {
  await supabase
    .from('fx_revaluation_runs' as any)
    .update({ status: 'posted', je_id: jeId })
    .eq('id', runId);
}

/**
 * Schedule the auto-reversal JE for period open.
 * In MVP, this creates the reversal immediately (with future effective date).
 */
export async function scheduleReversal(runId: string, reverseJeId: string): Promise<void> {
  await supabase
    .from('fx_revaluation_runs' as any)
    .update({ reverse_je_id: reverseJeId, status: 'reversed' })
    .eq('id', runId);
}

/**
 * Fetch all revaluation runs for an org, ordered newest first.
 */
export async function fetchRevaluationHistory(orgId: string) {
  const { data } = await supabase
    .from('fx_revaluation_runs' as any)
    .select('id, period_end, run_at, framework, method, status, reverse_on, notes, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(50);
  return (data as any[]) ?? [];
}
