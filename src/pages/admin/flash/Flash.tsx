import { useState, useCallback } from 'react';
import { Zap, ExternalLink, Loader2, CheckCircle2, AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useFlashStatus } from '@/hooks/useFlashStatus';

// Legacy localStorage hint key — retained as an export so FlashCallback
// can clear it on success. Real status now comes from the flash-status
// edge function (Layer 2).
export const LS_FLASH_STATUS_HINT = 'owb_flash_status_hint';

export default function Flash() {
  const { orgId, allOrgs, loading: orgLoading } = useUserOrg();
  const {
    status,
    loading: statusLoading,
    error: statusError,
    updatedAt,
    refresh,
  } = useFlashStatus();
  const [starting, setStarting] = useState(false);

  const isOwner = !!allOrgs.find((m) => m.org_id === orgId && m.role === 'OWNER');

  const onConnect = useCallback(async () => {
    setStarting(true);
    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user) throw new Error('Not signed in');

      const state = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const { error } = await supabase
        .from('flash_oauth_state')
        .insert({ state, purpose: 'platform-bootstrap', user_id: user.id, expires_at: expiresAt });
      if (error) throw new Error(error.message);

      const flashAuthBase =
        (import.meta.env.VITE_FLASH_AUTHORIZATION_URL as string | undefined) ??
        'https://flash.example/oauth/authorize';
      const clientId = (import.meta.env.VITE_FLASH_CLIENT_ID as string | undefined) ?? 'TBD';
      const redirectUri = window.location.origin + '/app/admin/flash/callback';

      const url = new URL(flashAuthBase);
      url.searchParams.set('client_id', clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', 'read_write');
      url.searchParams.set('state', state);

      window.location.assign(url.toString());
    } catch (err) {
      console.error('Flash connect failed:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to start Flash connection');
      setStarting(false);
    }
  }, []);

  if (orgLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isOwner) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-foreground mb-1">Pay with Flash</h1>
        <p className="text-sm text-muted-foreground mb-6">Platform billing connection</p>
        <div className="rounded-lg border border-border bg-card p-6 max-w-2xl">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <h3 className="text-base font-semibold text-card-foreground mb-1">
                Admin access required
              </h3>
              <p className="text-sm text-muted-foreground">
                Only the Orange Way Books organization OWNER can manage the platform Flash
                connection.
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const connected = !!status?.connected;
  const expiresAt = status?.expiresAt;

  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground mb-1">Pay with Flash</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Platform billing connection — connect the Orange Way Books Flash account once so customers
        can pay their subscription via Flash.
      </p>

      <div className="rounded-lg border border-border bg-card p-6 max-w-2xl">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[color:var(--color-brand-orange)]/10 flex items-center justify-center">
              <Zap className="w-5 h-5 text-[color:var(--color-brand-orange)]" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-card-foreground">Flash Connect</h3>
              <p className="text-xs text-muted-foreground">
                One-time OAuth bootstrap for the Orange Way Books merchant account.
              </p>
            </div>
          </div>

          {statusLoading ? (
            <Badge variant="secondary">
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
              Checking…
            </Badge>
          ) : connected ? (
            <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
              <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
              Connected
            </Badge>
          ) : (
            <Badge variant="secondary">Not connected</Badge>
          )}
        </div>

        {statusError && <p className="text-xs text-red-600 mb-3">{statusError}</p>}

        {connected && expiresAt ? (
          <div className="text-sm text-muted-foreground space-y-1">
            <p>
              Token expires <strong>{new Date(expiresAt).toLocaleString()}</strong>.
            </p>
            {updatedAt && <p>Last refreshed {new Date(updatedAt).toLocaleString()}.</p>}
            <div className="pt-3 flex gap-2">
              <Button variant="outline" onClick={onConnect} disabled={starting}>
                {starting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Starting…
                  </>
                ) : (
                  <>
                    Reconnect <ExternalLink className="w-4 h-4 ml-2" />
                  </>
                )}
              </Button>
              <Button variant="ghost" onClick={() => void refresh()} disabled={statusLoading}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Re-check
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Click below to connect the Orange Way Books merchant Flash account. You will be
              redirected to Flash to sign in and authorize the connection, then sent back here.
            </p>
            <div className="flex gap-2">
              <Button onClick={onConnect} disabled={starting}>
                {starting ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Starting…
                  </>
                ) : (
                  <>
                    Connect Flash <ExternalLink className="w-4 h-4 ml-2" />
                  </>
                )}
              </Button>
              <Button variant="ghost" onClick={() => void refresh()} disabled={statusLoading}>
                <RefreshCw className="w-4 h-4 mr-2" />
                Re-check
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
