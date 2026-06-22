/**
 * RevaluationWizard — three-step FX revaluation entry point.
 *
 * Step 1: Period selector
 * Step 2: Preview table (monetary accounts + deltas)
 * Step 3: Confirm → post JE + schedule auto-reversal
 */

import { useState, useCallback, useEffect } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { supabase } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import { useOrgSettings, useFormatCurrency } from '@/hooks/useOrgSettings';
import {
  decryptChartOfAccount,
  decryptJournalEntryLine,
  encryptJournalEntry,
} from '@/lib/crypto-fields';
import { computeAccountBalances } from '@/lib/ledger-engine';
import { buildJournalEntryLineInsert } from '@/lib/exchange/build-je-line-insert';
import {
  previewRevaluation,
  postRevaluation,
  confirmRevaluation,
  scheduleReversal,
  fetchRevaluationHistory,
  type RevaluationPreview,
  type RevaluationRunResult,
} from '@/lib/fx-revaluation/run';
import type { AccountInfo, JournalLine } from '@/lib/ledger-engine';

type WizardStep = 'period' | 'preview' | 'confirm' | 'done';

interface RevaluationHistoryRow {
  id: string;
  period_end: string;
  run_at: string;
  framework: string;
  method: string;
  status: string;
  reverse_on: string;
  notes: string | null;
  created_at: string;
}

interface RevaluationWizardProps {
  orgId: string | null;
}

export function RevaluationWizard({ orgId }: RevaluationWizardProps) {
  const { encryptText, decryptText } = useVault();
  const { settings } = useOrgSettings();
  const [userId, setUserId] = useState<string | null>(null);
  const { formatAmount } = useFormatCurrency();

  useEffect(() => {
    let active = true;
    (async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (active) setUserId(user?.id ?? null);
    })();
    return () => {
      active = false;
    };
  }, []);

  const primaryCurrency = settings.primaryCurrency;
  const framework = (settings as any).accounting_framework || 'IFRS';

  const [step, setStep] = useState<WizardStep>('period');
  const [periodEnd, setPeriodEnd] = useState(() => {
    // Default to last day of previous month
    const d = new Date();
    d.setDate(0);
    return d.toISOString().slice(0, 10);
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [preview, setPreview] = useState<RevaluationPreview | null>(null);
  const [runResult, setRunResult] = useState<RevaluationRunResult | null>(null);
  const [history, setHistory] = useState<RevaluationHistoryRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadHistory = useCallback(async () => {
    if (!orgId) return;
    setHistoryLoading(true);
    const rows = await fetchRevaluationHistory(orgId);
    setHistory(rows);
    setHistoryLoading(false);
  }, [orgId]);

  // Fetch and decrypt all data needed for the preview
  const handleComputePreview = useCallback(async () => {
    if (!orgId || !decryptText || !primaryCurrency) return;
    setLoading(true);
    setError(null);
    try {
      // Fetch accounts, JE lines (up to period end), and wallets
      const [acctRes, jeRes, walletRes] = await Promise.all([
        supabase
          .from('chart_of_accounts' as any)
          .select('*')
          .eq('org_id', orgId),
        supabase
          .from('journal_entry_lines')
          .select('*, journal_entries!inner(date, org_id)')
          .eq('journal_entries.org_id', orgId)
          .lte('journal_entries.date', periodEnd),
        supabase.from('accounts').select('id, asset, external_account_id').eq('org_id', orgId),
      ]);

      const rawAccounts = (acctRes.data as any[]) ?? [];
      const accounts: AccountInfo[] = await Promise.all(
        rawAccounts.map(async (a: any) => {
          const fields = await decryptChartOfAccount(a, decryptText);
          return {
            id: a.id,
            name: fields.account_name,
            code: fields.account_code,
            accountType: fields.account_type,
            accountGroup: fields.account_group || '',
            accountCategory: fields.account_category || null,
          };
        }),
      );

      const rawLines = (jeRes.data as any[]) ?? [];
      const journalLines: JournalLine[] = await Promise.all(
        rawLines.map(async (l: any) => {
          const fields = await decryptJournalEntryLine(l, decryptText);
          return {
            date: l.journal_entries?.date ?? '',
            accountId: l.account_id,
            accountName: fields.account_name,
            accountCode: fields.account_code,
            debit: fields.debit,
            credit: fields.credit,
            description: fields.description,
            journalEntryId: l.journal_entry_id,
            amountNative: fields.amount_native ?? null,
            amountPrimary: fields.amount_primary ?? null,
            walletCurrency: fields.wallet_currency ?? null,
            primaryCurrencyAtPosting: l.primary_currency_at_posting ?? null,
            ratePending: l.rate_pending ?? false,
          };
        }),
      );

      const balances = computeAccountBalances(journalLines, accounts);

      // Build walletCurrencies map: accountId → asset
      const wallets = (walletRes.data as any[]) ?? [];
      const walletCurrencies = new Map<string, string>();
      for (const w of wallets) {
        if (w.external_account_id && w.asset) {
          walletCurrencies.set(w.external_account_id, w.asset);
        }
      }

      const result = await previewRevaluation({
        orgId,
        periodEnd,
        primaryCurrency,
        framework,
        method: 'closing-rate',
        accounts,
        balances,
        walletCurrencies,
      });

      setPreview(result);
      setStep('preview');
    } catch (e: any) {
      setError(e.message ?? 'Failed to compute preview');
    } finally {
      setLoading(false);
    }
  }, [orgId, periodEnd, primaryCurrency, framework, decryptText]);

  // Post the revaluation run and create JEs
  const handleConfirm = useCallback(async () => {
    if (!preview || !orgId || !userId || !encryptText || !decryptText) return;
    setLoading(true);
    setError(null);
    try {
      // Insert the run record (draft status)
      const result = await postRevaluation(preview, orgId, userId, notes | undefined);

      // Create the main revaluation JE
      const jeDate = preview.periodEnd;
      const encEntry = await encryptJournalEntry(
        {
          memo: `FX Revaluation — period end ${jeDate}`,
          ref_number: null,
          currency: primaryCurrency,
          exchange_rate: null,
          status: 'POSTED',
          source_type: 'fx_revaluation',
          period_locked: false,
        },
        encryptText,
      );

      const { data: je, error: jeErr } = await supabase
        .from('journal_entries')
        .insert({ org_id: orgId, date: jeDate, ...encEntry } as any)
        .select()
        .single();
      if (jeErr || !je) throw new Error(`Failed to create JE: ${jeErr?.message}`);

      const jeId = (je as any).id;

      // Build one line per monetary account (delta line) + offset FX gain/loss line
      const encLines: any[] = [];
      let fxGainLossAccountId: string | null = null;

      // Find or use a placeholder for the FX Gain/Loss account
      const fxAcctRes = await supabase
        .from('chart_of_accounts' as any)
        .select('external_account_id')
        .eq('org_id', orgId)
        .ilike('account_group' as any, '%fx%')
        .limit(1)
        .maybeSingle();
      fxGainLossAccountId = (fxAcctRes.data as any)?.external_account_id ?? null;

      for (const line of preview.lines) {
        const debit = line.delta > 0 ? 0 : Math.abs(line.delta);
        const credit = line.delta > 0 ? line.delta : 0;
        const enc = await buildJournalEntryLineInsert({
          wallet_currency: primaryCurrency,
          primary_currency: primaryCurrency,
          date: jeDate,
          account_name: line.accountName,
          account_code: null,
          description: `FX reval: ${line.currency} closing rate ${line.closingRate}`,
          debit,
          credit,
          encrypt: encryptText,
        });
        encLines.push({ journal_entry_id: jeId, account_id: line.accountId, ...enc });
      }

      // Offset line: FX Gain/Loss
      if (encLines.length > 0 && fxGainLossAccountId) {
        const netDebit = preview.netDelta < 0 ? Math.abs(preview.netDelta) : 0;
        const netCredit = preview.netDelta > 0 ? preview.netDelta : 0;
        const enc = await buildJournalEntryLineInsert({
          wallet_currency: primaryCurrency,
          primary_currency: primaryCurrency,
          date: jeDate,
          account_name: preview.netDelta >= 0 ? 'Unrealized FX Gain' : 'Unrealized FX Loss',
          account_code: null,
          description: `FX revaluation offset — net delta ${preview.netDelta.toFixed(8)} ${primaryCurrency}`,
          debit: netDebit,
          credit: netCredit,
          encrypt: encryptText,
        });
        encLines.push({ journal_entry_id: jeId, account_id: fxGainLossAccountId, ...enc });
      }

      if (encLines.length > 0) {
        await supabase.from('journal_entry_lines').insert(encLines as any);
      }

      // Mark run as posted
      await confirmRevaluation(result.runId, jeId);

      // Create the auto-reversal JE (future-dated)
      const reverseDate = preview.reverseOn;
      const encReverseEntry = await encryptJournalEntry(
        {
          memo: `Auto-reversal: FX Revaluation ${jeDate}`,
          ref_number: null,
          currency: primaryCurrency,
          exchange_rate: null,
          status: 'POSTED',
          source_type: 'fx_revaluation_reversal',
          period_locked: false,
        },
        encryptText,
      );

      const { data: reverseJe, error: revErr } = await supabase
        .from('journal_entries')
        .insert({ org_id: orgId, date: reverseDate, ...encReverseEntry } as any)
        .select()
        .single();
      if (revErr || !reverseJe) throw new Error(`Failed to create reversal JE: ${revErr?.message}`);

      const reverseJeId = (reverseJe as any).id;

      // Reversal lines are the mirror of the original
      const reverseLines = encLines.map((l: any) => ({
        ...l,
        journal_entry_id: reverseJeId,
        // swap debit ↔ credit fields (re-encrypt not needed — we flip the amounts)
      }));
      // Re-build reversed lines properly
      const encReverseLines: any[] = [];
      for (const line of preview.lines) {
        const debit = line.delta > 0 ? line.delta : 0; // reversed
        const credit = line.delta > 0 ? 0 : Math.abs(line.delta);
        const enc = await buildJournalEntryLineInsert({
          wallet_currency: primaryCurrency,
          primary_currency: primaryCurrency,
          date: reverseDate,
          account_name: line.accountName,
          account_code: null,
          description: `Reversal of FX reval: ${line.currency}`,
          debit,
          credit,
          encrypt: encryptText,
        });
        encReverseLines.push({ journal_entry_id: reverseJeId, account_id: line.accountId, ...enc });
      }
      if (fxGainLossAccountId) {
        const netDebit = preview.netDelta >= 0 ? 0 : Math.abs(preview.netDelta);
        const netCredit = preview.netDelta >= 0 ? preview.netDelta : 0;
        const enc = await buildJournalEntryLineInsert({
          wallet_currency: primaryCurrency,
          primary_currency: primaryCurrency,
          date: reverseDate,
          account_name: preview.netDelta >= 0 ? 'Unrealized FX Gain' : 'Unrealized FX Loss',
          account_code: null,
          description: `Reversal of FX revaluation offset`,
          debit: netDebit,
          credit: netCredit,
          encrypt: encryptText,
        });
        encReverseLines.push({
          journal_entry_id: reverseJeId,
          account_id: fxGainLossAccountId,
          ...enc,
        });
      }
      if (encReverseLines.length > 0) {
        await supabase.from('journal_entry_lines').insert(encReverseLines as any);
      }

      await scheduleReversal(result.runId, reverseJeId);

      setRunResult({ ...result, jeId, reverseJeId });
      setStep('done');
      await loadHistory();
    } catch (e: any) {
      setError(e.message ?? 'Failed to post revaluation');
    } finally {
      setLoading(false);
    }
  }, [preview, orgId, userId, notes, primaryCurrency, encryptText, decryptText, loadHistory]);

  const handleReset = () => {
    setStep('period');
    setPreview(null);
    setRunResult(null);
    setError(null);
    setNotes('');
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold">FX Revaluation</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-xl">
          Remeasure monetary balance-sheet items at the closing rate per IAS 21 / ASC 830. A journal
          entry posts to P&L as Unrealized FX Gain/Loss and auto-reverses on the next period open.
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {(['period', 'preview', 'confirm', 'done'] as WizardStep[]).map((s, i) => (
          <span key={s} className="flex items-center gap-1">
            {i > 0 && <span className="text-muted-foreground/40">›</span>}
            <span className={step === s ? 'text-foreground font-medium' : ''}>
              {s === 'period'
                ? '1. Period'
                : s === 'preview'
                  ? '2. Preview'
                  : s === 'confirm'
                    ? '3. Confirm'
                    : '4. Done'}
            </span>
          </span>
        ))}
      </div>

      {error && (
        <div
          className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg"
          style={{ background: '#FEF2F2', border: '1px solid #FECACA', color: '#B91C1C' }}
        >
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* ── Step 1: Period selector ── */}
      {step === 'period' && (
        <div className="space-y-4 max-w-sm">
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Period End Date</Label>
            <Input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} />
            <p className="text-xs text-muted-foreground">
              Closing rates on this date are used to remeasure monetary items. The reversal entry
              will post on {periodEnd ? addOneDay(periodEnd) : '—'}.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Framework</Label>
            <p className="text-xs text-muted-foreground font-mono">{framework}</p>
          </div>
          <Button
            onClick={handleComputePreview}
            disabled={loading || !periodEnd || !orgId}
            style={{ background: 'var(--color-brand-orange)', color: 'white' }}
          >
            {loading ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Computing…
              </>
            ) : (
              <>
                Compute Preview <ArrowRight className="w-4 h-4 ml-2" />
              </>
            )}
          </Button>
        </div>
      )}

      {/* ── Step 2: Preview table ── */}
      {step === 'preview' && preview && (
        <div className="space-y-4">
          {preview.lines.length === 0 ? (
            <div
              className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg"
              style={{ background: '#F0FDF4', border: '1px solid #86EFAC', color: '#166534' }}
            >
              <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
              No revaluation adjustments needed — all monetary items are already at closing rate.
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-xs text-muted-foreground">
                      <th className="text-left py-2 pr-4 font-medium">Account</th>
                      <th className="text-right py-2 pr-4 font-medium">Currency</th>
                      <th className="text-right py-2 pr-4 font-medium">Balance (native)</th>
                      <th className="text-right py-2 pr-4 font-medium">
                        Pinned ({primaryCurrency})
                      </th>
                      <th className="text-right py-2 pr-4 font-medium">
                        Closing ({primaryCurrency})
                      </th>
                      <th className="text-right py-2 font-medium">Delta</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.lines.map((l) => (
                      <tr key={l.accountId} className="border-b border-border/50 hover:bg-muted/30">
                        <td className="py-2 pr-4 font-medium text-foreground">{l.accountName}</td>
                        <td className="text-right py-2 pr-4 font-mono text-xs text-muted-foreground">
                          {l.currency}
                        </td>
                        <td className="text-right py-2 pr-4 font-mono text-xs">
                          {l.balanceNative.toLocaleString()}
                        </td>
                        <td className="text-right py-2 pr-4 font-mono text-xs">
                          {formatAmount(l.pinnedPrimary, primaryCurrency)}
                        </td>
                        <td className="text-right py-2 pr-4 font-mono text-xs">
                          {formatAmount(l.currentPrimary, primaryCurrency)}
                        </td>
                        <td
                          className={`text-right py-2 font-mono text-xs font-semibold ${l.delta > 0 ? 'text-green-600' : 'text-red-600'}`}
                        >
                          <span className="flex items-center justify-end gap-0.5">
                            {l.delta > 0 ? (
                              <TrendingUp className="w-3 h-3" />
                            ) : (
                              <TrendingDown className="w-3 h-3" />
                            )}
                            {formatAmount(Math.abs(l.delta), primaryCurrency)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Summary */}
              <div className="grid grid-cols-3 gap-3">
                {[
                  { label: 'Total Gain', value: preview.totalGain, color: 'text-green-600' },
                  { label: 'Total Loss', value: preview.totalLoss, color: 'text-red-600' },
                  {
                    label: 'Net Delta',
                    value: preview.netDelta,
                    color: preview.netDelta >= 0 ? 'text-green-600' : 'text-red-600',
                  },
                ].map((s) => (
                  <div
                    key={s.label}
                    className="border rounded-lg px-4 py-3"
                    style={{ borderColor: 'var(--color-border)' }}
                  >
                    <p className="text-xs text-muted-foreground mb-1">{s.label}</p>
                    <p className={`text-lg font-bold font-mono ${s.color}`}>
                      {formatAmount(s.value, primaryCurrency)}
                    </p>
                  </div>
                ))}
              </div>

              <div className="text-xs text-muted-foreground px-1">
                Period end: <strong>{preview.periodEnd}</strong> · Auto-reversal:{' '}
                <strong>{preview.reverseOn}</strong> · Framework:{' '}
                <strong>{preview.framework}</strong>
              </div>
            </>
          )}

          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={handleReset}>
              ← Back
            </Button>
            {preview.lines.length > 0 && (
              <Button
                onClick={() => setStep('confirm')}
                style={{ background: 'var(--color-brand-orange)', color: 'white' }}
              >
                Review & Confirm <ArrowRight className="w-4 h-4 ml-2" />
              </Button>
            )}
          </div>
        </div>
      )}

      {/* ── Step 3: Confirm ── */}
      {step === 'confirm' && preview && (
        <div className="space-y-4 max-w-lg">
          <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 space-y-1">
            <p className="font-semibold">You are about to post:</p>
            <ul className="list-disc list-inside text-xs space-y-0.5 mt-1">
              <li>
                A revaluation JE dated <strong>{preview.periodEnd}</strong> with{' '}
                {preview.lines.length} monetary account adjustment
                {preview.lines.length !== 1 ? 's' : ''}
              </li>
              <li>
                Net P&L impact:{' '}
                <strong>
                  {preview.netDelta >= 0 ? '+' : ''}
                  {formatAmount(preview.netDelta, primaryCurrency)}
                </strong>{' '}
                ({preview.netDelta >= 0 ? 'Unrealized FX Gain' : 'Unrealized FX Loss'})
              </li>
              <li>
                An auto-reversal JE will post on <strong>{preview.reverseOn}</strong>
              </li>
            </ul>
          </div>

          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Notes (optional)</Label>
            <Input
              placeholder="e.g. Q1 2026 period-end revaluation"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-3">
            <Button variant="outline" onClick={() => setStep('preview')}>
              ← Back
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={loading}
              style={{ background: 'var(--color-brand-orange)', color: 'white' }}
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Posting…
                </>
              ) : (
                'Confirm & Post'
              )}
            </Button>
          </div>
        </div>
      )}

      {/* ── Step 4: Done ── */}
      {step === 'done' && runResult && (
        <div className="space-y-4">
          <div
            className="flex items-center gap-2 text-sm px-4 py-3 rounded-lg"
            style={{ background: '#DCFCE7', border: '1px solid #86EFAC', color: '#166534' }}
          >
            <CheckCircle2 className="w-4 h-4 flex-shrink-0" />
            <div>
              <p className="font-semibold">Revaluation posted successfully.</p>
              <p className="text-xs mt-0.5">
                JE created for {preview!.periodEnd}. Auto-reversal scheduled for{' '}
                {preview!.reverseOn}.
              </p>
            </div>
          </div>
          <Button variant="outline" onClick={handleReset}>
            <RefreshCw className="w-4 h-4 mr-2" />
            Run another revaluation
          </Button>
        </div>
      )}

      {/* ── History ── */}
      <div className="border-t border-border pt-6 mt-4">
        <div className="flex items-center justify-between mb-3">
          <h4 className="text-sm font-semibold">Revaluation History</h4>
          <Button variant="ghost" size="sm" onClick={loadHistory} disabled={historyLoading}>
            <RefreshCw className={`w-3.5 h-3.5 ${historyLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
        {history.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            No revaluations run yet.{' '}
            {step === 'period' && (
              <button className="underline" onClick={loadHistory}>
                Load history
              </button>
            )}
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="text-left py-1.5 pr-4 font-medium">Period End</th>
                <th className="text-left py-1.5 pr-4 font-medium">Framework</th>
                <th className="text-left py-1.5 pr-4 font-medium">Status</th>
                <th className="text-left py-1.5 pr-4 font-medium">Reversal Date</th>
                <th className="text-left py-1.5 font-medium">Notes</th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr key={h.id} className="border-b border-border/50">
                  <td className="py-1.5 pr-4 font-mono">{h.period_end}</td>
                  <td className="py-1.5 pr-4">{h.framework}</td>
                  <td className="py-1.5 pr-4">
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        h.status === 'posted'
                          ? 'bg-green-100 text-green-700'
                          : h.status === 'reversed'
                            ? 'bg-gray-100 text-gray-600'
                            : 'bg-amber-100 text-amber-700'
                      }`}
                    >
                      {h.status}
                    </span>
                  </td>
                  <td className="py-1.5 pr-4 font-mono">{h.reverse_on}</td>
                  <td className="py-1.5 text-muted-foreground">{h.notes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function addOneDay(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
