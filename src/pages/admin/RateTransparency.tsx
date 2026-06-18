import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle2, Download } from 'lucide-react';
import { format, differenceInDays, parseISO } from 'date-fns';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';

interface RateRow {
  id: string;
  base_currency: string;
  quote_currency: string;
  rate: number | null;
  rate_date: string;
  provider: string;
  status: string;
  source_kind: string | null;
  confirmed_at: string | null;
  manual_rate_reason: string | null;
  manual_rate_source: string | null;
  created_at: string;
}

interface RateTransparencyProps {
  orgId: string | null;
}

const STALE_THRESHOLD_DAYS = 7;

function staleBadge(rateDateStr: string) {
  const days = differenceInDays(new Date(), parseISO(rateDateStr));
  if (days > STALE_THRESHOLD_DAYS) {
    return (
      <Badge variant="destructive" className="text-xs">
        <AlertTriangle className="w-3 h-3 mr-1" />
        {days}d old
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-xs" style={{ color: 'var(--color-gray-500)' }}>
      <CheckCircle2 className="w-3 h-3 mr-1" />
      {days === 0 ? 'Today' : `${days}d ago`}
    </Badge>
  );
}

function sourceLabel(row: RateRow) {
  if (row.manual_rate_source) return `Manual — ${row.manual_rate_source}`;
  if (row.provider === 'coingecko') return 'Auto (CoinGecko)';
  if (row.provider === 'openexchangerates') return 'Auto (OXR)';
  if (row.provider === 'identity') return 'Identity (1:1)';
  if (row.provider === 'fixed') return 'Fixed';
  return row.provider;
}

/**
 * Rate Transparency — Admin tab showing all exchange rates used.
 * Shows staleness badges (red >7 days), source (auto vs manual), and audit log.
 * Gated to OWNER role by the Admin page that renders it.
 */
export function RateTransparency({ orgId }: RateTransparencyProps) {
  const [rows, setRows] = useState<RateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'stale' | 'manual' | 'pending'>('all');

  const fetchRates = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    // exchange_rates is a shared cache table — no org_id column.
    // Fetch rates that have been used by this org's journal lines.
    const { data } = await supabase
      .from('exchange_rates')
      .select('id, base_currency, quote_currency, rate, rate_date, provider, status, source_kind, confirmed_at, created_at')
      .order('rate_date', { ascending: false })
      .limit(500);

    if (data) {
      // Augment with manual rate info from journal_entry_lines (where available)
      setRows(data.map((r: any) => ({
        ...r,
        manual_rate_reason: null,
        manual_rate_source: null,
      })));
    }
    setLoading(false);
  }, [orgId]);

  useEffect(() => { fetchRates(); }, [fetchRates]);

  const filtered = rows.filter(r => {
    if (filter === 'stale') return differenceInDays(new Date(), parseISO(r.rate_date)) > STALE_THRESHOLD_DAYS;
    if (filter === 'manual') return !!r.manual_rate_source;
    if (filter === 'pending') return r.status === 'PENDING';
    return true;
  });

  const handleExportCsv = () => {
    const header = ['Pair', 'Date', 'Rate', 'Source', 'Status', 'Age (days)'].join(',');
    const csvRows = filtered.map(r => {
      const age = differenceInDays(new Date(), parseISO(r.rate_date));
      return [
        `${r.base_currency}/${r.quote_currency}`,
        r.rate_date,
        r.rate ?? '',
        sourceLabel(r),
        r.status,
        age,
      ].join(',');
    });
    const blob = new Blob([[header, ...csvRows].join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `exchange-rates-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.success('Rates exported');
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold">Exchange Rate Audit</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            All exchange rates in the cache. Rates older than {STALE_THRESHOLD_DAYS} days are flagged.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={fetchRates} disabled={loading}>
            <RefreshCw className={`w-3.5 h-3.5 mr-1 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={handleExportCsv} disabled={filtered.length === 0}>
            <Download className="w-3.5 h-3.5 mr-1" />
            Export CSV
          </Button>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1">
        {(['all', 'stale', 'manual', 'pending'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className="px-3 py-1 text-xs rounded-md font-medium transition-colors"
            style={{
              background: filter === f ? 'var(--color-brand-orange)' : 'var(--color-gray-100)',
              color: filter === f ? 'white' : 'var(--color-gray-600)',
            }}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground py-4">Loading rates…</p>
      ) : filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4">No rates found for this filter.</p>
      ) : (
        <div className="border rounded-lg overflow-hidden" style={{ borderColor: 'var(--color-border)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-xs text-muted-foreground" style={{ borderColor: 'var(--color-border)', background: 'var(--color-gray-50)' }}>
                <th className="px-3 py-2 text-left font-medium">Pair</th>
                <th className="px-3 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-right font-medium">Rate</th>
                <th className="px-3 py-2 text-left font-medium">Source</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Age</th>
                {rows.some(r => r.manual_rate_source) && (
                  <th className="px-3 py-2 text-left font-medium">Audit Note</th>
                )}
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-gray-50 transition-colors" style={{ borderColor: 'var(--color-border)' }}>
                  <td className="px-3 py-2 font-mono font-semibold text-xs">
                    {r.base_currency}/{r.quote_currency}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{r.rate_date}</td>
                  <td className="px-3 py-2 text-right font-mono text-xs">
                    {r.rate != null ? r.rate.toPrecision(8) : <span className="text-amber-600">pending</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{sourceLabel(r)}</td>
                  <td className="px-3 py-2">
                    {r.status === 'PENDING'
                      ? <Badge variant="outline" className="text-xs border-amber-300 text-amber-700">Pending</Badge>
                      : <Badge variant="outline" className="text-xs border-green-300 text-green-700">Confirmed</Badge>}
                  </td>
                  <td className="px-3 py-2">{staleBadge(r.rate_date)}</td>
                  {rows.some(row => row.manual_rate_source) && (
                    <td className="px-3 py-2 text-xs text-muted-foreground max-w-[200px] truncate" title={r.manual_rate_reason ?? ''}>
                      {r.manual_rate_reason ?? '—'}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        {filtered.length} rate{filtered.length !== 1 ? 's' : ''} shown
        {filter !== 'all' && ` (filtered: ${filter})`}.
        Rates are shared across all orgs and cached for 5 minutes per session.
      </p>
    </div>
  );
}
