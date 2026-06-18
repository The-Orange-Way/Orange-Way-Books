import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Download, Loader2 } from 'lucide-react';
import { format, startOfMonth, endOfMonth, addMonths, subMonths, isSameMonth } from 'date-fns';
import { exportToCsv } from '@/lib/exports/csv';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useFormatCurrency } from '@/hooks/useOrgSettings';
import { useVault } from '@/context/VaultContext';
import { decryptJournalEntryLine, decryptChartOfAccount } from '@/lib/crypto-fields';
import {
  computeAccountBalances,
  type JournalLine,
  type AccountInfo,
} from '@/lib/ledger-engine';
import { Button } from '@/components/ui/button';

interface MonthSummary {
  monthStart: Date;
  revenue: number;
  expenses: number;
  net: number;
}

function summarizeMonth(
  lines: JournalLine[],
  accounts: AccountInfo[],
  monthStart: Date,
): MonthSummary {
  const from = format(monthStart, 'yyyy-MM-dd');
  const to = format(endOfMonth(monthStart), 'yyyy-MM-dd');
  const balances = computeAccountBalances(lines, accounts, { from, to });

  let revenue = 0;
  let expenses = 0;
  for (const b of balances) {
    const t = b.accountType.toLowerCase();
    if (t === 'revenue' | t === 'income') revenue += b.balance;
    else if (t === 'expense') expenses += b.balance;
  }
  return {
    monthStart,
    revenue,
    expenses,
    net: revenue - expenses,
  };
}

export default function CashFlowPage() {
  const { orgId, loading: orgLoading } = useUserOrg();
  const { decryptText } = useVault();
  const [journalLines, setJournalLines] = useState<JournalLine[]>([]);
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [anchor, setAnchor] = useState<Date>(startOfMonth(new Date()));
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!orgId) {
      if (!orgLoading) setLoading(false);
      return;
    }
    let active = true;
    (async () => {
      const [jeRes, acctRes] = await Promise.all([
        supabase
          .from('journal_entry_lines')
          .select('*, journal_entries!inner(date, memo, org_id)')
          .eq('journal_entries.org_id', orgId),
        supabase.from('chart_of_accounts' as any).select('*').eq('org_id', orgId),
      ]);
      if (!active) return;

      const rawLines = (jeRes.data as any[]) ?? [];
      const decryptedLines = await Promise.all(
        rawLines.map(async (l: any) => {
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
            amountNative: fields.amount_native ?? null,
            amountPrimary: fields.amount_primary ?? null,
            walletCurrency: fields.wallet_currency ?? null,
            primaryCurrencyAtPosting: l.primary_currency_at_posting ?? null,
            ratePending: l.rate_pending ?? false,
          };
        }),
      );

      const rawAccounts = (acctRes.data as any[]) ?? [];
      const decryptedAccounts = await Promise.all(
        rawAccounts.map(async (a: any) => {
          const fields = await decryptChartOfAccount(a, decryptText);
          return {
            id: a.id,
            name: fields.account_name,
            code: fields.account_code,
            accountType: fields.account_type,
            accountGroup: fields.account_group | '',
            accountCategory: fields.account_category | null,
          };
        }),
      );

      if (!active) return;
      setJournalLines(decryptedLines);
      setAccounts(decryptedAccounts);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [orgId, orgLoading, decryptText]);

  const current = useMemo(
    () => summarizeMonth(journalLines, accounts, anchor),
    [journalLines, accounts, anchor],
  );

  // Trailing six months including the anchor month, oldest first.
  const trailing6 = useMemo<MonthSummary[]>(() => {
    const months: MonthSummary[] = [];
    for (let i = 5; i >= 0; i--) {
      months.push(summarizeMonth(journalLines, accounts, subMonths(anchor, i)));
    }
    return months;
  }, [journalLines, accounts, anchor]);

  const { formatAmount } = useFormatCurrency();
  const fmtMoney = (amount: number) => formatAmount(amount);

  // Bar-chart bounds across the 6-month window. Pad symmetrically so a
  // single dominant month doesn't squash the others.
  const yMax = useMemo(() => {
    const m = Math.max(
      1,
      ...trailing6.map((s) => Math.max(Math.abs(s.revenue), Math.abs(s.expenses), Math.abs(s.net))),
    );
    return m;
  }, [trailing6]);

  const isFutureMonth = anchor > startOfMonth(new Date());

  return (
    <div className="space-y-5 p-4 md:p-6">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Cash flow</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Did the business make money this month? A quick monthly view of revenue, expenses, and net.
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setAnchor((d) => subMonths(d, 1))}
            aria-label="Previous month"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <div className="px-3 text-sm font-medium tabular-nums min-w-[8rem] text-center" data-testid="cashflow-month-label">
            {format(anchor, 'MMMM yyyy')}
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setAnchor((d) => addMonths(d, 1))}
            disabled={isFutureMonth}
            aria-label="Next month"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
          {!isSameMonth(anchor, new Date()) && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-2"
              onClick={() => setAnchor(startOfMonth(new Date()))}
            >
              This month
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="ml-2"
            disabled={loading | trailing6.length === 0}
            onClick={() => {
              const headers = ['Month', 'Revenue', 'Expenses', 'Net'];
              const rows = trailing6.map((m) => [
                format(m.monthStart, 'yyyy-MM'),
                m.revenue,
                m.expenses,
                m.net,
              ]);
              exportToCsv(
                `owb-cash-flow-${format(trailing6[0].monthStart, 'yyyy-MM')}-to-${format(anchor, 'yyyy-MM')}.csv`,
                headers,
                rows,
              );
              toast.success('Exported trailing six months.');
            }}
            data-testid="cashflow-export-csv"
          >
            <Download className="w-4 h-4 mr-1.5" />
            Export
          </Button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading cash-flow data…
        </div>
      ) : (
        <>
          {/* KPI tiles */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <KpiTile
              label="Revenue"
              value={current.revenue}
              format={fmtMoney}
              tone="positive"
              link={{ to: '/app/reports?report=pnl', label: 'View P&L' }}
            />
            <KpiTile
              label="Expenses"
              value={current.expenses}
              format={fmtMoney}
              tone="negative"
              link={{ to: '/app/reports?report=pnl', label: 'View P&L' }}
            />
            <KpiTile
              label="Net"
              value={current.net}
              format={fmtMoney}
              tone={current.net >= 0 ? 'positive' : 'negative'}
              highlight
            />
          </div>

          {/* 6-month bars */}
          <div
            className="bg-card border border-border rounded-lg p-4"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                Trailing six months
              </h2>
              <span className="text-xs text-muted-foreground">Net per month</span>
            </div>
            <div className="grid grid-cols-6 gap-2 items-end" style={{ height: 140 }}>
              {trailing6.map((m) => {
                const heightPct = yMax === 0 ? 0 : Math.abs(m.net) / yMax;
                const isCurrent = isSameMonth(m.monthStart, anchor);
                const isPositive = m.net >= 0;
                return (
                  <div key={m.monthStart.toISOString()} className="flex flex-col items-center justify-end h-full gap-1">
                    <div
                      className="w-full rounded-t-sm transition-all"
                      style={{
                        height: `${Math.max(4, heightPct * 100)}%`,
                        background: isPositive
                          ? (isCurrent ? 'var(--color-brand-orange)' : '#86efac')
                          : (isCurrent ? '#dc2626' : '#fca5a5'),
                      }}
                      title={`${format(m.monthStart, 'MMM yyyy')}: ${fmtMoney(m.net)}`}
                    />
                  </div>
                );
              })}
            </div>
            <div className="grid grid-cols-6 gap-2 mt-2 text-[10px] text-center text-muted-foreground tabular-nums">
              {trailing6.map((m) => (
                <span key={m.monthStart.toISOString()}>{format(m.monthStart, 'MMM')}</span>
              ))}
            </div>
            <div className="grid grid-cols-6 gap-2 text-[11px] text-center font-mono">
              {trailing6.map((m) => (
                <span
                  key={m.monthStart.toISOString()}
                  className={m.net >= 0 ? 'text-green-700' : 'text-red-700'}
                >
                  {fmtMoney(m.net)}
                </span>
              ))}
            </div>
          </div>

          {/* Empty-data nudge */}
          {journalLines.length === 0 && (
            <div className="bg-card border border-border rounded-lg p-8 text-center text-sm text-muted-foreground">
              No journal entries yet — create one or import to see your cash flow take shape.
              <div className="mt-2">
                <Link to="/app/journal" className="text-primary hover:underline">Go to Journal Entries →</Link>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function KpiTile({
  label,
  value,
  format,
  tone,
  highlight,
  link,
}: {
  label: string;
  value: number;
  format: (n: number) => string;
  tone: 'positive' | 'negative';
  highlight?: boolean;
  link?: { to: string; label: string };
}) {
  const content = (
    <div
      className="bg-card border rounded-lg px-5 py-4 hover:shadow-md transition-shadow h-full"
      style={{
        borderColor: 'var(--color-border)',
        borderRadius: 'var(--radius-md)',
        background: highlight ? '#EBEBEB' : 'white',
      }}
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground">
          {label}
        </span>
      </div>
      <p
        className="text-xl font-bold font-mono"
        style={{
          color: tone === 'positive' ? 'var(--color-green-700, #15803d)' : 'var(--color-red-700, #b91c1c)',
        }}
      >
        {format(value)}
      </p>
      {link && (
        <p className="text-[11px] text-muted-foreground mt-1">
          {link.label}
        </p>
      )}
    </div>
  );
  if (link) {
    return <Link to={link.to}>{content}</Link>;
  }
  return content;
}
