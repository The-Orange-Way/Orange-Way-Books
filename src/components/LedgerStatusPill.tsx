import { useState } from 'react';
import { Loader2, AlertTriangle, CheckCircle2, RefreshCcw } from 'lucide-react';
import { useLedgerStatus } from '@/hooks/useLedgerStatus';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useVault } from '@/context/VaultContext';
import { supabase } from '@/lib/supabase';
import { initChartOfAccounts } from '@/lib/init-chart-of-accounts';
import { toast } from 'sonner';

export function LedgerStatusPill() {
  const { status, error, refresh } = useLedgerStatus();
  const { orgId } = useUserOrg();
  const { encryptText, isUnlocked } = useVault();
  const [retrying, setRetrying] = useState(false);

  if (!status | status === 'ready') return null;

  const handleRetry = async () => {
    if (!orgId | !isUnlocked | retrying) return;
    setRetrying(true);
    const tid = toast.loading('Retrying chart-of-accounts setup…', {
      description: 'Server only sees ciphertext.',
      duration: Infinity,
    });
    try {
      await (supabase as any)
        .from('organizations')
        .update({ ledger_status: 'provisioning', ledger_status_error: null })
        .eq('id', orgId);
      refresh();
      await initChartOfAccounts(orgId, encryptText, (done, total) => {
        toast.loading(`Retrying chart-of-accounts setup (${done}/${total})…`, {
          id: tid,
          description: 'Server only sees ciphertext.',
          duration: Infinity,
        });
      });
      await (supabase as any)
        .from('organizations')
        .update({ ledger_status: 'ready', ledger_status_error: null })
        .eq('id', orgId);
      toast.success('Chart of accounts ready', { id: tid, duration: 3000 });
      refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await (supabase as any)
        .from('organizations')
        .update({ ledger_status: 'failed', ledger_status_error: msg })
        .eq('id', orgId)
        .then(() => undefined, () => undefined);
      toast.error('Retry failed', {
        id: tid,
        description: msg,
        duration: 10000,
      });
      refresh();
    } finally {
      setRetrying(false);
    }
  };

  if (status === 'failed') {
    return (
      <div
        role="status"
        data-testid="ledger-status-pill"
        data-ledger-status="failed"
        className="inline-flex items-center gap-2 rounded-full bg-destructive/10 px-3 py-1 text-xs text-destructive"
        title={error ?? 'Chart of accounts setup failed'}
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        Setup failed
        <button
          type="button"
          onClick={handleRetry}
          disabled={retrying | !isUnlocked}
          data-testid="ledger-status-retry"
          className="inline-flex items-center gap-1 rounded-full bg-destructive/20 px-2 py-0.5 text-[11px] font-medium hover:bg-destructive/30 disabled:cursor-not-allowed disabled:opacity-60"
          title={isUnlocked ? 'Re-run chart of accounts seed' : 'Unlock your vault to retry'}
        >
          {retrying ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCcw className="h-3 w-3" />}
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      </div>
    );
  }

  return (
    <div
      role="status"
      data-testid="ledger-status-pill"
      data-ledger-status={status}
      className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground"
    >
      <Loader2 className="h-3.5 w-3.5 animate-spin" />
      Finishing setup…
    </div>
  );
}

export function LedgerReadyBadge() {
  const { status } = useLedgerStatus();
  if (status !== 'ready') return null;
  return (
    <span
      data-testid="ledger-status-pill"
      data-ledger-status="ready"
      className="sr-only"
    >
      <CheckCircle2 className="h-3.5 w-3.5" /> Ledger ready
    </span>
  );
}
