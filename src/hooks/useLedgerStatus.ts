import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';

export type LedgerStatus = 'pending' | 'provisioning' | 'ready' | 'failed';

export interface LedgerStatusState {
  status: LedgerStatus | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function useLedgerStatus(): LedgerStatusState {
  const { orgId } = useUserOrg();
  const [status, setStatus] = useState<LedgerStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!orgId) {
      setStatus(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    const fetchStatus = async () => {
      const { data, error: dbErr } = await (supabase as any)
        .from('organizations')
        .select('ledger_status, ledger_status_error')
        .eq('id', orgId)
        .single();
      if (cancelled) return;
      if (dbErr) {
        setError(dbErr.message);
        setLoading(false);
        return;
      }
      setStatus(data?.ledger_status ?? null);
      setError(data?.ledger_status_error ?? null);
      setLoading(false);
    };

    fetchStatus();

    // Poll while provisioning to flip to ready/failed without a page reload.
    const interval = window.setInterval(() => {
      setStatus((current) => {
        if (current === 'pending' | current === 'provisioning') {
          fetchStatus();
        }
        return current;
      });
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [orgId, tick]);

  return {
    status,
    error,
    loading,
    refresh: () => setTick((t) => t + 1),
  };
}
