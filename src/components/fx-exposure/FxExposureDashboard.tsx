/**
 * FxExposureDashboard — FX risk exposure widget.
 *
 * Shows per-currency balance breakdown, days since last rate update,
 * and pending revaluation items. One-click rate refresh per currency.
 */

import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, RefreshCw, TrendingUp, TrendingDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import { useFormatCurrency } from '@/hooks/useOrgSettings';
import { decryptJournalEntryLine, decryptChartOfAccount } from '@/lib/crypto-fields';
import { computeAccountBalances } from '@/lib/ledger-engine';
import { resolvePinnedRate } from '@/lib/exchange/rate-resolver';
import type { AccountInfo, JournalLine } from '@/lib/ledger-engine';

interface CurrencyExposure {
  currency: string;
  totalNative: number;
  totalPrimary: number | null;
  accountCount: number;
  lastRateDate: string | null;
  daysSinceUpdate: number | null;
  pendingCount: number;
}

interface FxExposureDashboardProps {
  orgId: string | null;
  primaryCurrency: string;
}

export function FxExposureDashboard({ orgId, primaryCurrency }: FxExposureDashboardProps) {
  const { decryptText } = useVault();
  const { formatAmount } = useFormatCurrency();

  const [exposures, setExposures] = useState<CurrencyExposure[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set());
  const [pendingRevalCount, setPendingRevalCount] = useState(0);

  const load = useCallback(async () => {
    if (!orgId || !decryptText) return;
    setLoading(true);
    try {
      const [jeRes, acctRes, ratesRes, pendingRes] = await Promise.all([
        supabase
          .from('journal_entry_lines')
          .select('*, journal_entries!inner(date, org_id)')
          .eq('journal_entries.org_id', orgId),
        supabase
          .from('chart_of_accounts' as any)
          .select('*')
          .eq('org_id', orgId),
        supabase
          .from('exchange_rates' as any)
          .select('base, quote, bucket_ts, status')
          .order('bucket_ts', { ascending: false })
          .limit(500),
        supabase
          .from('journal_entry_lines')
          .select('id', { count: 'exact', head: true })
          .eq('rate_pending', true),
      ]);

      // Decrypt accounts
      const rawAccounts = (acctRes.data as any[]) ?? [];
      const accounts: AccountInfo[] = await Promise.all(
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

      // Decrypt JE lines
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

      // Group by wallet currency
      const byCurrency = new Map<
        string,
        { native: number; primary: number | null; accountIds: Set<string>; pending: number }
      >();

      for (const line of journalLines) {
        const cur = line.walletCurrency ?? primaryCurrency;
        if (cur.toUpperCase() === primaryCurrency.toUpperCase()) continue;
        if (!byCurrency.has(cur)) {
          byCurrency.set(cur, { native: 0, primary: null, accountIds: new Set(), pending: 0 });
        }
        const entry = byCurrency.get(cur)!;
        entry.accountIds.add(line.accountId);
        if (line.ratePending) entry.pending++;
      }

      // Sum balances per currency
      for (const balance of balances) {
        const acct = accounts.find((a) => a.id === balance.accountId);
        if (!acct) continue;
        const lines = journalLines.filter((l) => l.accountId === balance.accountId);
        const currencies = [...new Set(lines.map((l) => l.walletCurrency ?? primaryCurrency))];
        for (const cur of currencies) {
          if (cur.toUpperCase() === primaryCurrency.toUpperCase()) continue;
          if (!byCurrency.has(cur)) continue;
          const curLines = lines.filter((l) => (l.walletCurrency ?? primaryCurrency) === cur);
          const native = curLines.reduce((s, l) => s + l.debit - l.credit, 0);
          const primary = curLines.every((l) => l.amountPrimary != null)
            ? curLines.reduce((s, l) => s + (l.amountPrimary ?? 0), 0)
            : null;
          const entry = byCurrency.get(cur)!;
          entry.native += native;
          if (primary != null) {
            entry.primary = (entry.primary ?? 0) + primary;
          }
        }
      }

      // Build latest rate date per currency pair
      const rateRows = (ratesRes.data as any[]) ?? [];
      const latestRateDate = new Map<string, string>();
      for (const r of rateRows) {
        const key = `${r.base}/${r.quote}`;
        if (!latestRateDate.has(key)) latestRateDate.set(key, r.bucket_ts);
      }

      const today = new Date();
      const result: CurrencyExposure[] = [];
      for (const [cur, entry] of byCurrency) {
        const rateKey = `${cur}/${primaryCurrency}`;
        const rateAlt = `${primaryCurrency}/${cur}`;
        const lastDate = latestRateDate.get(rateKey) ?? latestRateDate.get(rateAlt) ?? null;
        let days: number | null = null;
        if (lastDate) {
          days = Math.floor((today.getTime() - new Date(lastDate).getTime()) / 86400000);
        }
        result.push({
          currency: cur,
          totalNative: entry.native,
          totalPrimary: entry.primary,
          accountCount: entry.accountIds.size,
          lastRateDate: lastDate,
          daysSinceUpdate: days,
          pendingCount: entry.pending,
        });
      }

      result.sort((a, b) => Math.abs(b.totalPrimary ?? 0) - Math.abs(a.totalPrimary ?? 0));
      setExposures(result);
      setPendingRevalCount((pendingRes as any).count ?? 0);
    } catch {
      // Non-critical widget — fail silently
    } finally {
      setLoading(false);
    }
  }, [orgId, primaryCurrency, decryptText]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRefreshRate = useCallback(
    async (currency: string) => {
      setRefreshing((prev) => new Set(prev).add(currency));
      try {
        await resolvePinnedRate({
          source: currency,
          target: primaryCurrency,
          at: new Date().toISOString().slice(0, 10),
        });
        await load();
      } catch {
        // Ignore — rate may be pending
      } finally {
        setRefreshing((prev) => {
          const s = new Set(prev);
          s.delete(currency);
          return s;
        });
      }
    },
    [primaryCurrency, load],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
        <RefreshCw className="w-4 h-4 animate-spin" />
        Loading FX exposure…
      </div>
    );
  }

  if (exposures.length === 0) {
    return (
      <div className="text-sm text-muted-foreground py-4">
        No foreign-currency exposure detected. All accounts appear to use the primary currency (
        {primaryCurrency}).
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {pendingRevalCount > 0 && (
        <div
          className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg"
          style={{ background: '#FFF7ED', border: '1px solid #FED7AA', color: '#92400E' }}
        >
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
          {pendingRevalCount} journal entry line{pendingRevalCount !== 1 ? 's' : ''} have pending
          exchange rates and are excluded from totals.
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="text-left py-2 pr-4 font-medium">Currency</th>
              <th className="text-right py-2 pr-4 font-medium">Balance (native)</th>
              <th className="text-right py-2 pr-4 font-medium">Balance ({primaryCurrency})</th>
              <th className="text-right py-2 pr-4 font-medium">Rate age</th>
              <th className="text-right py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {exposures.map((exp) => {
              const stale = (exp.daysSinceUpdate ?? 0) > 7;
              return (
                <tr key={exp.currency} className="border-b border-border/50 hover:bg-muted/30">
                  <td className="py-2.5 pr-4">
                    <span className="font-mono font-semibold">{exp.currency}</span>
                    <span className="text-xs text-muted-foreground ml-2">
                      {exp.accountCount} account{exp.accountCount !== 1 ? 's' : ''}
                    </span>
                    {exp.pendingCount > 0 && (
                      <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">
                        {exp.pendingCount} pending
                      </span>
                    )}
                  </td>
                  <td className="text-right py-2.5 pr-4 font-mono text-xs">
                    <span className={exp.totalNative >= 0 ? 'text-green-700' : 'text-red-700'}>
                      {exp.totalNative >= 0 ? (
                        <TrendingUp className="w-3 h-3 inline mr-0.5" />
                      ) : (
                        <TrendingDown className="w-3 h-3 inline mr-0.5" />
                      )}
                      {exp.totalNative.toLocaleString(undefined, { maximumFractionDigits: 8 })}
                    </span>
                  </td>
                  <td className="text-right py-2.5 pr-4 font-mono text-xs">
                    {exp.totalPrimary != null ? (
                      formatAmount(exp.totalPrimary, primaryCurrency)
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="text-right py-2.5 pr-4">
                    {exp.daysSinceUpdate != null ? (
                      <span
                        className={`text-xs px-1.5 py-0.5 rounded font-medium ${stale ? 'bg-red-100 text-red-700' : 'bg-green-100 text-green-700'}`}
                      >
                        {exp.daysSinceUpdate}d ago
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">no rate</span>
                    )}
                  </td>
                  <td className="text-right py-2.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-xs"
                      disabled={refreshing.has(exp.currency)}
                      onClick={() => handleRefreshRate(exp.currency)}
                    >
                      <RefreshCw
                        className={`w-3 h-3 mr-1 ${refreshing.has(exp.currency) ? 'animate-spin' : ''}`}
                      />
                      Refresh
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Button variant="outline" size="sm" onClick={load} className="text-xs">
        <RefreshCw className="w-3.5 h-3.5 mr-1.5" />
        Reload
      </Button>
    </div>
  );
}
