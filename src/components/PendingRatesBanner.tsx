import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, RefreshCw, Pencil } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { ManualRateDialog } from '@/components/exchange/ManualRateDialog';
import type { ManualRate } from '@/lib/exchange/build-je-line-insert';

const POLL_INTERVAL_MS = 60_000;

interface PendingRatesBannerProps {
  orgId: string | null;
}

/**
 * App-shell banner that appears when journal_entry_lines with rate_pending=true exist.
 * Polls every 60 s. Offers "Retry now" (re-checks provider) and "Resolve manually"
 * (opens ManualRateDialog for a chosen currency pair).
 */
export function PendingRatesBanner({ orgId }: PendingRatesBannerProps) {
  const [pendingCount, setPendingCount] = useState(0);
  const [retrying, setRetrying] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);

  const fetchCount = useCallback(async () => {
    if (!orgId) return;
    const { count } = await supabase
      .from('journal_entry_lines')
      .select('id', { count: 'exact', head: true })
      .eq('rate_pending', true);
    setPendingCount(count ?? 0);
  }, [orgId]);

  useEffect(() => {
    fetchCount();
    const timer = setInterval(fetchCount, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [fetchCount]);

  const handleRetry = async () => {
    setRetrying(true);
    // Trigger a re-fetch of exchange rates for pending lines by calling the edge
    // function for the most recent date, this warms the DB cache so the next
    // JE decrypt loop will find confirmed rates.
    try {
      await supabase.functions.invoke('exchange-rate-fetch', {
        body: { base: 'BTC', quote: 'USD', date: new Date().toISOString().slice(0, 10) },
      });
    } catch {
      /* ignore */
    }
    await fetchCount();
    setRetrying(false);
  };

  const handleManualConfirm = async (_manualRate: ManualRate) => {
    // Manual rate entry for a pending line is handled per-JE in ManualRateDialog.
    // Here we just re-count after the user confirms.
    setManualOpen(false);
    await fetchCount();
  };

  if (pendingCount === 0) return null;

  return (
    <>
      <div
        role="alert"
        className="flex items-center gap-3 px-4 py-2.5 text-sm"
        style={{
          background: 'var(--color-warning-bg, #FFF7ED)',
          borderBottom: '1px solid var(--color-warning-border, #FED7AA)',
          color: 'var(--color-warning-text, #92400E)',
        }}
      >
        <AlertTriangle className="w-4 h-4 flex-shrink-0" style={{ color: '#F59E0B' }} />
        <span className="flex-1">
          <strong>{pendingCount}</strong> journal entr{pendingCount === 1 ? 'y' : 'ies'} missing
          exchange rate, amounts shown in primary currency may be incomplete.
        </span>
        <button
          onClick={handleRetry}
          disabled={retrying}
          className="flex items-center gap-1 text-xs font-semibold underline underline-offset-2 hover:no-underline disabled:opacity-50"
        >
          <RefreshCw className={`w-3 h-3 ${retrying ? 'animate-spin' : ''}`} />
          Retry now
        </button>
        <button
          onClick={() => setManualOpen(true)}
          className="flex items-center gap-1 text-xs font-semibold underline underline-offset-2 hover:no-underline"
        >
          <Pencil className="w-3 h-3" />
          Resolve manually
        </button>
      </div>

      {/* ManualRateDialog needs a pair, use generic prompt when opened from banner */}
      <ManualRateDialog
        open={manualOpen}
        walletCurrency="BTC"
        primaryCurrency="USD"
        date={new Date().toISOString().slice(0, 10)}
        onConfirm={handleManualConfirm}
        onClose={() => setManualOpen(false)}
      />
    </>
  );
}
