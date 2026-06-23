import { useState, useCallback, useRef } from 'react';
import { Play, Square, RefreshCw, CheckCircle2, AlertTriangle, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useVault } from '@/context/VaultContext';
import { useOrgSettings } from '@/hooks/useOrgSettings';
import {
  backfillDualAmounts,
  loadBackfillProgress,
  clearBackfillProgress,
  type BackfillProgress,
} from '@/lib/exchange/backfill-dual-amounts';

interface BackfillRatesProps {
  orgId: string | null;
}

type RunState = 'idle' | 'running' | 'done' | 'aborted';

/**
 * BackfillRates, Admin tab for populating dual-currency amounts on pre-dual rows.
 *
 * Gated to OWNER role by the Admin page that renders it.
 * Progress is persisted to localStorage so the browser can resume if the tab
 * is closed mid-run. ZKA: all decrypt/encrypt happens in the browser, only
 * ciphertext is written to Supabase.
 */
export function BackfillRates({ orgId }: BackfillRatesProps) {
  const { encryptText, decryptText } = useVault();
  const { settings } = useOrgSettings();
  const primaryCurrency = settings.primaryCurrency;
  const [runState, setRunState] = useState<RunState>('idle');
  const [progress, setProgress] = useState<BackfillProgress>(loadBackfillProgress);
  const abortRef = useRef<AbortController | null>(null);

  const handleStart = useCallback(async () => {
    if (!orgId || !encryptText || !decryptText) return;
    abortRef.current = new AbortController();
    setRunState('running');

    try {
      await backfillDualAmounts(orgId, primaryCurrency, encryptText, decryptText, {
        onProgress: (p) => setProgress({ ...p }),
        onDone: (p) => {
          setProgress({ ...p });
          setRunState('done');
        },
        signal: abortRef.current.signal,
      });
    } catch {
      setRunState('aborted');
    }
  }, [orgId, primaryCurrency, encryptText, decryptText]);

  const handleStop = () => {
    abortRef.current?.abort();
    setRunState('aborted');
  };

  const handleReset = () => {
    clearBackfillProgress();
    setProgress({ processed: 0, resolved: 0, pending: 0, failed: 0, lastCursor: null });
    setRunState('idle');
  };

  const total = progress.resolved + progress.pending + progress.failed;
  const pct = progress.processed > 0 ? Math.round((total / Math.max(total, 1)) * 100) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-base font-semibold">Backfill Dual-Currency Amounts</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-xl">
          Populates <code className="bg-gray-100 px-1 rounded">amount_native</code> and{' '}
          <code className="bg-gray-100 px-1 rounded">amount_primary</code> on journal entry lines
          that predate the dual-currency upgrade. Decryption and encryption happen entirely in this
          browser, nothing is sent to the server in plaintext.
        </p>
      </div>

      {/* Status cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          {
            label: 'Processed',
            value: progress.processed,
            icon: <Clock className="w-4 h-4" />,
            color: 'text-gray-600',
          },
          {
            label: 'Resolved',
            value: progress.resolved,
            icon: <CheckCircle2 className="w-4 h-4" />,
            color: 'text-green-600',
          },
          {
            label: 'Pending rate',
            value: progress.pending,
            icon: <AlertTriangle className="w-4 h-4" />,
            color: 'text-amber-600',
          },
          {
            label: 'Failed',
            value: progress.failed,
            icon: <AlertTriangle className="w-4 h-4" />,
            color: 'text-red-600',
          },
        ].map((card) => (
          <div
            key={card.label}
            className="border rounded-lg px-4 py-3"
            style={{ borderColor: 'var(--color-border)' }}
          >
            <div className={`flex items-center gap-1 text-xs font-medium mb-1 ${card.color}`}>
              {card.icon}
              {card.label}
            </div>
            <p className="text-2xl font-bold font-mono text-foreground">{card.value}</p>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      {total > 0 && (
        <div>
          <div className="flex justify-between text-xs text-muted-foreground mb-1">
            <span>{total} rows processed</span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${pct}%`,
                background: 'var(--color-brand-orange)',
              }}
            />
          </div>
        </div>
      )}

      {/* Resume notice */}
      {runState === 'idle' && progress.lastCursor && (
        <div
          className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg"
          style={{ background: '#FFF7ED', border: '1px solid #FED7AA', color: '#92400E' }}
        >
          <RefreshCw className="w-3.5 h-3.5 flex-shrink-0" />
          Previous run was interrupted. Click Start to resume from where it left off, or Reset to
          start fresh.
        </div>
      )}

      {/* State messages */}
      {runState === 'done' && (
        <div
          className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg"
          style={{ background: '#DCFCE7', border: '1px solid #86EFAC', color: '#166534' }}
        >
          <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" />
          Backfill complete.{' '}
          {progress.pending > 0 &&
            `${progress.pending} rows still have pending rates, use the Exchange Rates tab to resolve them manually.`}
        </div>
      )}
      {runState === 'aborted' && (
        <div
          className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg"
          style={{ background: '#FFF7ED', border: '1px solid #FED7AA', color: '#92400E' }}
        >
          <Square className="w-3.5 h-3.5 flex-shrink-0" />
          Run stopped. Progress is saved, click Start to resume.
        </div>
      )}
      {runState === 'running' && (
        <div
          className="flex items-center gap-2 text-xs px-3 py-2 rounded-lg"
          style={{ background: '#EFF6FF', border: '1px solid #BFDBFE', color: '#1E40AF' }}
        >
          <RefreshCw className="w-3.5 h-3.5 flex-shrink-0 animate-spin" />
          Running… keep this tab open. Progress is saved automatically.
        </div>
      )}

      {/* Controls */}
      <div className="flex items-center gap-3">
        {runState !== 'running' ? (
          <Button
            onClick={handleStart}
            disabled={!orgId || runState === 'done'}
            className="flex items-center gap-2"
            style={{ background: 'var(--color-brand-orange)', color: 'white' }}
          >
            <Play className="w-4 h-4" />
            {progress.lastCursor ? 'Resume' : 'Start'} backfill
          </Button>
        ) : (
          <Button onClick={handleStop} variant="destructive" className="flex items-center gap-2">
            <Square className="w-4 h-4" />
            Stop
          </Button>
        )}
        <Button
          variant="outline"
          onClick={handleReset}
          disabled={runState === 'running'}
          className="flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4" />
          Reset
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Backfilling large orgs can take several minutes. Rows that cannot resolve a rate are marked{' '}
        <code className="bg-gray-100 px-1 rounded">rate_pending=true</code> and will appear in the
        Pending Rates banner until resolved manually.
      </p>
    </div>
  );
}
