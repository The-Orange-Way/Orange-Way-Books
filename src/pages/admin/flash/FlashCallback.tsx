import { useEffect, useState, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Loader2, CheckCircle2, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import { LS_FLASH_STATUS_HINT } from './Flash';

/**
 * /app/admin/flash/callback, handles the Flash OAuth redirect.
 * Reads ?code and ?state from the URL, POSTs them to the
 * flash-oauth-callback edge function, and bounces back to /admin/flash.
 */
export default function FlashCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<'pending' | 'ok' | 'error'>('pending');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const didRunRef = useRef(false);

  useEffect(() => {
    if (didRunRef.current) return;
    didRunRef.current = true;

    const code = params.get('code');
    const stateParam = params.get('state');
    const errorParam = params.get('error');

    if (errorParam) {
      setState('error');
      setErrorMsg(params.get('error_description') ?? errorParam);
      return;
    }
    if (!code || !stateParam) {
      setState('error');
      setErrorMsg('Missing code or state in callback URL.');
      return;
    }

    (async () => {
      try {
        const { data, error } = await supabase.functions.invoke('flash-oauth-callback', {
          body: { code, state: stateParam },
        });
        if (error) throw new Error(error.message);
        const result = data as { ok?: boolean; expires_at?: string; error?: string } | null;
        if (!result?.ok) {
          throw new Error(result?.error ?? 'Token exchange failed');
        }
        // Clear any stale localStorage hint left from the Layer-1 build
        // status is now read server-side via the flash-status function.
        try {
          localStorage.removeItem(LS_FLASH_STATUS_HINT);
        } catch {
          /* noop */
        }
        setState('ok');
        setTimeout(() => navigate('/app/admin/flash', { replace: true }), 1500);
      } catch (err) {
        console.error('Flash callback failed:', err);
        setState('error');
        setErrorMsg(err instanceof Error ? err.message : 'Unknown error');
      }
    })();
  }, [params, navigate]);

  return (
    <div className="max-w-xl mx-auto py-12">
      <div className="rounded-lg border border-border bg-card p-8 text-center">
        {state === 'pending' && (
          <>
            <Loader2 className="w-10 h-10 animate-spin mx-auto text-muted-foreground mb-4" />
            <h2 className="text-lg font-semibold text-card-foreground mb-1">
              Connecting to Flash…
            </h2>
            <p className="text-sm text-muted-foreground">
              Exchanging authorization code for tokens.
            </p>
          </>
        )}
        {state === 'ok' && (
          <>
            <CheckCircle2 className="w-10 h-10 mx-auto text-green-600 mb-4" />
            <h2 className="text-lg font-semibold text-card-foreground mb-1">Connected to Flash</h2>
            <p className="text-sm text-muted-foreground">Redirecting back…</p>
          </>
        )}
        {state === 'error' && (
          <>
            <XCircle className="w-10 h-10 mx-auto text-red-600 mb-4" />
            <h2 className="text-lg font-semibold text-card-foreground mb-1">
              Flash connection failed
            </h2>
            <p className="text-sm text-muted-foreground mb-6">
              {errorMsg ?? 'Something went wrong.'}
            </p>
            <Button
              variant="outline"
              onClick={() => navigate('/app/admin/flash', { replace: true })}
            >
              Back to admin
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
