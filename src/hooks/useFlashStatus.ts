import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabase';
import type { FlashStatus } from '@/lib/flash';

interface State {
  status: FlashStatus | null;
  loading: boolean;
  error: string | null;
  updatedAt: string | null;
}

export function useFlashStatus(): State & { refresh: () => Promise<void> } {
  const [state, setState] = useState<State>({
    status: null, loading: true, error: null, updatedAt: null,
  });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const { data, error } = await supabase.functions.invoke('flash-status', { method: 'GET' as any });
      if (error) throw new Error(error.message);
      const d = data as { connected: boolean; expiresAt: string | null; scopes: string[] | null; updatedAt?: string };
      setState({
        status: { connected: d.connected, expiresAt: d.expiresAt, scopes: d.scopes },
        loading: false,
        error: null,
        updatedAt: d.updatedAt ?? null,
      });
    } catch (err) {
      setState({
        status: null,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load status',
        updatedAt: null,
      });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  return { ...state, refresh: load };
}
