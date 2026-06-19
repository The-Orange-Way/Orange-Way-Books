import { useEffect, useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { format } from 'date-fns';
import {
  resolvePeriod,
  computeTrend,
  availableYears,
  type PeriodPreset,
} from '@/lib/dashboard-trends';
import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useFormatCurrency } from '@/hooks/useOrgSettings';
import { useSecondaryDisplayRate } from '@/lib/exchange/hooks';
import { useVault } from '@/context/VaultContext';
import { decryptWallet, decryptTransaction, decryptOrgSettings, decryptJournalEntryLine, decryptChartOfAccount } from '@/lib/crypto-fields';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import type { BitcoinDisplay } from '@/types';
import {
  computeAccountBalances,
  computeKPIs,
  computeWorkingCapital,
  computeWalletBalances,
  computeTrialBalance,
  type JournalLine,
  type AccountInfo,
  type KPIs,
  type WorkingCapital,
  type WalletBalance,
  type TrialBalanceReport,
} from '@/lib/ledger-engine';
import { WalletsInsightsCard } from '@/components/dashboard/WalletsInsightsCard';
import { ExpensesInsightsCard } from '@/components/dashboard/ExpensesInsightsCard';
import { LedgerStatusIcon } from '@/components/dashboard/LedgerStatusIcon';
import { NotificationsBell } from '@/components/dashboard/NotificationsBell';
import { TrendChip } from '@/components/dashboard/TrendChip';
import '@/components/dashboard/insights.css';

interface WalletRow {
  id: string;
  encrypted_name: string;
  asset: string;
  account_type: string | null;
  initial_balance: number;
}

interface TxRow {
  id: string;
  account_id: string | null;
  type: string;
  asset: string;
  amount: number;
  usd_value: number | null;
  date: string;
  memo: string | null;
  status: string | null;
  cleared_status: string | null;
}

export default function Dashboard() {
  const { orgId, loading: orgLoading } = useUserOrg();
  const { decryptText } = useVault();
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [txs, setTxs] = useState<TxRow[]>([]);
  const [btcDisplay, setBtcDisplay] = useState<BitcoinDisplay>('sats');
  const [primaryCurrency, setPrimaryCurrency] = useState('USD');
  const [secondaryCurrency, setSecondaryCurrency] = useState<string | null>('BTC');
  const [loading, setLoading] = useState(true);
  const [journalLines, setJournalLines] = useState<JournalLine[]>([]);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  // Welcome-modal dismissal is tracked in two places: localStorage acts as
  // a synchronous first-paint cache so the modal doesn't flash, and Supabase
  // Auth user_metadata.owb_onboarding_completed_at is the source of truth so
  // the dismissal carries across devices and browsers. The effect below
  // reconciles the two.
  const [welcomeDismissed, setWelcomeDismissed] = useState(() => {
    return localStorage.getItem('orangewaybooks.welcome_dismissed') === 'true';
  });

  // Hydrate dismissal from the server on mount. If user_metadata has the
  // onboarding-completed marker, mirror it to localStorage so future loads
  // are instant. If the user previously dismissed in localStorage only
  // (older client builds), propagate that to user_metadata so other devices
  // pick it up.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (cancelled || !user) return;
      const serverMarker = (user.user_metadata as { owb_onboarding_completed_at?: string })?.owb_onboarding_completed_at;
      if (serverMarker) {
        localStorage.setItem('orangewaybooks.welcome_dismissed', 'true');
        setWelcomeDismissed(true);
        return;
      }
      if (localStorage.getItem('orangewaybooks.welcome_dismissed') === 'true') {
        await supabase.auth.updateUser({
          data: { owb_onboarding_completed_at: new Date().toISOString() },
        });
      }
    })();
    return () => { cancelled = true; };
  }, []);
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    if (!orgId) { if (!orgLoading) setLoading(false); return; }

    const fetch = async () => {
      const [wRes, tRes, sRes, jeRes, acctRes] = await Promise.all([
        supabase.from('accounts').select('*').eq('org_id', orgId),
        supabase.from('transactions').select('*').eq('org_id', orgId).order('date', { ascending: false }).limit(10),
        supabase.from('org_settings').select('*').eq('org_id', orgId).maybeSingle(),
        supabase.from('journal_entry_lines').select('*, journal_entries!inner(date, memo, org_id)').eq('journal_entries.org_id', orgId),
        supabase.from('chart_of_accounts' as any).select('*').eq('org_id', orgId),
      ]);
      const decryptedWallets = await Promise.all(
        ((wRes.data as any[]) ?? []).map(async (w) => {
          const fields = await decryptWallet(w, decryptText);
          return { ...w, ...fields };
        })
      );
      setWallets(decryptedWallets);
      const decryptedTxs = await Promise.all(
        ((tRes.data as any[]) ?? []).map(async (tx) => {
          const fields = await decryptTransaction(tx, decryptText);
          return { ...tx, ...fields };
        })
      );
      setTxs(decryptedTxs);
      if (sRes.data) {
        const dec = await decryptOrgSettings(sRes.data, decryptText);
        if (dec.bitcoin_display) setBtcDisplay(dec.bitcoin_display as BitcoinDisplay);
        if (dec.primary_currency) setPrimaryCurrency(dec.primary_currency);
        setSecondaryCurrency(dec.secondary_currency || null);
      }

      // Decrypt and map journal lines into engine format
      const rawLines = (jeRes.data as any[]) ?? [];
      const decryptedLines = await Promise.all(rawLines.map(async (l: any) => {
        const fields = await decryptJournalEntryLine(l, decryptText);
        return {
          date: l.journal_entries?.date ?? l.date ?? '',
          accountId: l.account_id,
          accountName: fields.account_name,
          accountCode: fields.account_code,
          debit: fields.debit,
          credit: fields.credit,
          description: fields.description,
          journalEntryId: l.journal_entry_id,
          // Dual-currency fields (null for pre-dual rows)
          amountNative: fields.amount_native ?? null,
          amountPrimary: fields.amount_primary ?? null,
          walletCurrency: fields.wallet_currency ?? null,
          primaryCurrencyAtPosting: l.primary_currency_at_posting ?? null,
          ratePending: l.rate_pending ?? false,
        };
      }));
      setJournalLines(decryptedLines);

      // Decrypt and map accounts into engine format
      const rawAccounts = (acctRes.data as any[]) ?? [];
      const decryptedAccounts = await Promise.all(rawAccounts.map(async (a: any) => {
        const fields = await decryptChartOfAccount(a, decryptText);
        return {
          id: a.id,
          name: fields.account_name,
          code: fields.account_code,
          accountType: fields.account_type,
          accountGroup: fields.account_group || '',
          accountCategory: fields.account_category || null,
        };
      }));
      setAccounts(decryptedAccounts);

      setLoading(false);
    };
    fetch();
  }, [orgId, orgLoading]);

  const [period, setPeriod] = useState<PeriodPreset>('ytd');
  const periodRange = useMemo(() => resolvePeriod(period), [period]);

  const currentBalances = useMemo(
    () => computeAccountBalances(journalLines, accounts, periodRange.current),
    [journalLines, accounts, periodRange.current],
  );
  const priorBalances = useMemo(
    () => computeAccountBalances(journalLines, accounts, periodRange.prior),
    [journalLines, accounts, periodRange.prior],
  );
  const kpis: KPIs = useMemo(() => computeKPIs(currentBalances), [currentBalances]);
  const priorKpis: KPIs = useMemo(() => computeKPIs(priorBalances), [priorBalances]);

  const allTimeBalances = useMemo(
    () => computeAccountBalances(journalLines, accounts),
    [journalLines, accounts],
  );

  // Working capital is a stock — balance as of the period's end date vs prior end date.
  const wcCurrentBalances = useMemo(
    () => computeAccountBalances(journalLines, accounts, { to: periodRange.current.to }),
    [journalLines, accounts, periodRange.current.to],
  );
  const wcPriorBalances = useMemo(
    () => computeAccountBalances(journalLines, accounts, { to: periodRange.prior.to }),
    [journalLines, accounts, periodRange.prior.to],
  );
  const workingCapital: WorkingCapital = useMemo(
    () => computeWorkingCapital(wcCurrentBalances),
    [wcCurrentBalances],
  );
  const priorWorkingCapital: WorkingCapital = useMemo(
    () => computeWorkingCapital(wcPriorBalances),
    [wcPriorBalances],
  );

  const yearOptions = useMemo(() => availableYears(journalLines), [journalLines]);

  const walletBalanceList: WalletBalance[] = useMemo(
    () => computeWalletBalances(wallets, txs, journalLines),
    [wallets, txs, journalLines],
  );

  const trialBalance: TrialBalanceReport = useMemo(
    () => computeTrialBalance(allTimeBalances),
    [allTimeBalances],
  );

  const dismissWelcome = () => {
    if (dontShowAgain) {
      localStorage.setItem('orangewaybooks.welcome_dismissed', 'true');
      // Fire-and-forget — failure here doesn't block the user. localStorage
      // already keeps the dismissal sticky on this device; the server write
      // is the cross-device sync layer.
      void supabase.auth.updateUser({
        data: { owb_onboarding_completed_at: new Date().toISOString() },
      });
    }
    setWelcomeDismissed(true);
  };

  const { formatAmount } = useFormatCurrency();

  const fmtPrimary = (amount: number | null, asset?: string) => {
    if (amount == null) return '—';
    return formatAmount(amount, asset | primaryCurrency);
  };

  // Closing-rate secondary display for KPI cards and working capital
  const { rate: secondaryDisplayRate } = useSecondaryDisplayRate(primaryCurrency, secondaryCurrency);
  const fmtSecondary = (primaryAmount: number | null): string | null => {
    if (primaryAmount == null || secondaryDisplayRate == null || !secondaryCurrency) return null;
    return `≈${formatAmount(primaryAmount * secondaryDisplayRate, secondaryCurrency)}`;
  };

  if (loading || orgLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  }

  const asOfToday = format(new Date(), 'yyyy-MM-dd');
  const useSampleFigures = walletBalanceList.length === 0 && journalLines.length === 0;

  return (
    <div className="space-y-8">
      <div className="owb-insights-page-head">
        <h1 className="owb-insights-page-title">Insights</h1>
        <div className="owb-insights-page-aside">
          <NotificationsBell orgId={orgId} />
          <LedgerStatusIcon
            trialBalance={trialBalance}
            asOfDate={asOfToday}
            primaryCurrency={primaryCurrency}
            formatAmount={formatAmount}
          />
          <span className="owb-insights-asof">As of {asOfToday}</span>
          <Link className="owb-insights-reports-link" to="/app/reports?report=pnl">
            View reports
          </Link>
        </div>
      </div>
      {useSampleFigures && welcomeDismissed && (
        <div className="owb-dashboard-sample-banner" role="status">
          <strong>Welcome to your Insights view</strong>
          <span className="owb-dashboard-sample-banner-detail">
            {' '}
            — Add accounts and post transactions to see your live KPIs, working capital and breakdowns.
          </span>
        </div>
      )}

      {/* Period selector — applies to KPIs + Working Capital */}
      <div className="owb-period-bar">
        <span className="owb-period-bar-label">
          Period: {periodRange.label} · {periodRange.comparisonLabel}
        </span>
        <select
          className="owb-period-bar-select"
          value={period}
          onChange={(e) => setPeriod(e.target.value as PeriodPreset)}
          aria-label="Choose comparison period"
        >
          <option value="7d">Last 7 days</option>
          <option value="30d">Last 30 days</option>
          <option value="90d">Last 90 days</option>
          <option value="ytd">Year to date</option>
          {yearOptions.map((y) => (
            <option key={y} value={`year:${y}`}>{y}</option>
          ))}
        </select>
      </div>

      {/* 1. KPI Row */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { title: 'Revenue', link: '/reports?report=pnl', value: kpis.revenue, prior: priorKpis.revenue, higherIsBetter: true as boolean | null },
          { title: 'Cost of Sales', link: '/reports?report=pnl', value: kpis.costOfSales, prior: priorKpis.costOfSales, higherIsBetter: false as boolean | null },
          { title: 'Gross Profit', link: '/reports?report=pnl', value: kpis.grossProfit, prior: priorKpis.grossProfit, higherIsBetter: true as boolean | null },
          { title: 'Net Profit', link: '/reports?report=pnl', value: kpis.netProfit, prior: priorKpis.netProfit, higherIsBetter: true as boolean | null },
        ].map(card => {
          const trend = computeTrend(card.value, card.prior, card.higherIsBetter);
          return (
            <Link
              key={card.title}
              to={card.link}
              className="bg-white border rounded-lg hover:shadow-md transition-shadow"
              style={{ borderColor: 'var(--color-border)', borderRadius: 'var(--radius-md)', padding: '18px 20px' }}
            >
              <div className="flex items-start justify-between mb-2">
                <span className="text-xs uppercase font-semibold" style={{ color: 'var(--color-gray-400)' }}>{card.title}</span>
                <TrendChip trend={trend} />
              </div>
              <p className="text-lg font-bold font-mono text-foreground">{fmtPrimary(card.value)}</p>
              {fmtSecondary(card.value) && (
                <p className="text-xs font-mono" style={{ color: 'var(--color-gray-400)' }}>
                  {fmtSecondary(card.value)}
                </p>
              )}
              <p className="owb-trend-prior">
                {fmtPrimary(card.prior)} {periodRange.comparisonLabel}
              </p>
            </Link>
          );
        })}
      </div>

      {/* 2. Working Capital Formula */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center gap-3">
        {[
          { label: 'Cash on Hand', highlight: false, value: workingCapital.cash, prior: priorWorkingCapital.cash, higherIsBetter: true as boolean | null },
          { op: '+' },
          { label: 'Receivables', highlight: false, value: workingCapital.receivables, prior: priorWorkingCapital.receivables, higherIsBetter: null as boolean | null },
          { op: '−' },
          { label: 'Current Liabilities', highlight: false, value: workingCapital.currentLiabilities, prior: priorWorkingCapital.currentLiabilities, higherIsBetter: false as boolean | null },
          { op: '=' },
          { label: 'Net Working Capital', highlight: true, value: workingCapital.netWorkingCapital, prior: priorWorkingCapital.netWorkingCapital, higherIsBetter: true as boolean | null },
        ].map((item, i) => {
          if ('op' in item) {
            return (
              <span key={i} className="text-xl font-bold self-center hidden md:block" style={{ color: 'var(--color-gray-400)' }}>
                {item.op}
              </span>
            );
          }
          const trend = computeTrend(item.value, item.prior, item.higherIsBetter);
          return (
            <Link
              key={i}
              to="/app/reports?report=balance-sheet"
              className="flex-1 min-w-[140px] rounded-lg border px-5 py-4 hover:shadow-md transition-shadow"
              style={{
                borderColor: 'var(--color-border)',
                borderRadius: 'var(--radius-md)',
                background: item.highlight ? '#EBEBEB' : 'white',
              }}
            >
              <div className="flex items-start justify-between">
                <span className="text-[10px] uppercase font-semibold tracking-wider" style={{ color: 'var(--color-gray-400)' }}>{item.label}</span>
                <TrendChip trend={trend} />
              </div>
              <p className="text-[15px] font-bold font-mono text-foreground mt-1">{fmtPrimary(item.value)}</p>
              {fmtSecondary(item.value) && (
                <p className="text-[11px] font-mono" style={{ color: 'var(--color-gray-400)' }}>
                  {fmtSecondary(item.value)}
                </p>
              )}
              <p className="owb-trend-prior">
                {fmtPrimary(item.prior)} {periodRange.comparisonLabel}
              </p>
            </Link>
          );
        })}
      </div>


      {/* 3. Insights donuts: Accounts + Expenses */}
      <div className="owb-insights-donuts-row">
        <WalletsInsightsCard
          wallets={walletBalanceList}
          primaryCurrency={primaryCurrency}
          secondaryCurrency={secondaryCurrency}
          walletsHref="/accounts"
          balanceSheetHref="/reports?report=balance-sheet"
        />
        <ExpensesInsightsCard
          journalLines={journalLines}
          accounts={accounts}
          primaryCurrency={primaryCurrency}
          profitLossHref="/reports?report=pnl"
        />
      </div>

      {/* 4. Recent Transactions teaser */}
      <div
        className="bg-white border rounded-lg overflow-hidden"
        style={{ borderColor: 'var(--color-border)', borderRadius: 'var(--radius-md)' }}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b" style={{ borderColor: 'var(--color-border)' }}>
          <h3 className="text-sm font-semibold uppercase tracking-wider" style={{ color: 'var(--color-gray-400)' }}>
            Recent Transactions
          </h3>
          <Link
            to="/app/transactions"
            className="text-xs font-medium hover:underline"
            style={{ color: 'var(--color-orange-600)' }}
          >
            View all →
          </Link>
        </div>
        {txs.length === 0 ? (
          <p className="px-5 py-6 text-sm text-center text-muted-foreground">
            No transactions yet. <Link to="/app/transactions" className="underline">Record your first one</Link>.
          </p>
        ) : (
          <ul className="divide-y" style={{ borderColor: 'var(--color-border)' }}>
            {txs.slice(0, 5).map((tx) => {
              const wallet = wallets.find((w) => w.id === tx.account_id);
              const walletName = (wallet as any)?.name ?? 'Unassigned';
              const isPositive = tx.type === 'income' | tx.type === 'deposit' | tx.amount > 0;
              return (
                <li key={tx.id} className="flex items-center justify-between px-5 py-3 hover:bg-gray-50">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate text-foreground">
                      {tx.memo?.trim() | 'Untitled transaction'}
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {format(new Date(tx.date), 'MMM d, yyyy')} · {walletName}
                    </p>
                  </div>
                  <p
                    className="ml-4 text-sm font-mono font-semibold whitespace-nowrap"
                    style={{ color: isPositive ? 'var(--color-green-600, #16a34a)' : 'var(--color-foreground)' }}
                  >
                    {fmtPrimary(Math.abs(tx.amount), tx.asset)}
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </div>


      {/* Welcome Modal */}
      <Dialog open={!welcomeDismissed} onOpenChange={(open) => { if (!open) dismissWelcome(); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Welcome to Orange Way Books!</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Get started with a few quick steps:
            </p>
            <ol className="list-decimal list-inside space-y-2 text-sm">
              <li><strong>Create your first account</strong> — Head to the Accounts page and click "+ Add Account" to set up a BTC or fiat account.</li>
              <li><strong>Enter a transaction</strong> — Record your first income or expense on the Transactions page.</li>
              <li><strong>Create a journal entry</strong> — Use the Journal page to record double-entry bookkeeping entries.</li>
              <li><strong>Run a report</strong> — Visit Reports to see your Profit & Loss, Balance Sheet, or Trial Balance.</li>
            </ol>
          </div>
          <div className="flex items-center gap-2 pt-2 border-t">
            <Checkbox
              id="welcome-dismiss"
              checked={dontShowAgain}
              onCheckedChange={(checked) => setDontShowAgain(!!checked)}
            />
            <label htmlFor="welcome-dismiss" className="text-sm text-muted-foreground cursor-pointer">
              Don't show again
            </label>
          </div>
          <DialogFooter>
            <Button onClick={dismissWelcome}>Get Started</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
