import { useEffect, useState } from 'react';
import { useVault } from '@/context/VaultContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Lock, ShieldCheck, Bitcoin, AlertTriangle } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useToast } from '@/hooks/use-toast';
import VaultRecoveryDialog from '@/components/vault/VaultRecoveryDialog';

interface RateLimitState {
  ok: boolean;
  failed_count: number;
  window_minutes: number;
  cooldown_until: string | null;
}

export default function VaultUnlockScreen() {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const [error, setError] = useState('');
  const [rateLimit, setRateLimit] = useState<RateLimitState | null>(null);
  const [now, setNow] = useState<number>(Date.now());
  const { unlock } = useVault();
  const { toast } = useToast();

  // Check rate-limit on mount and after each failure.
  const refreshRateLimit = async () => {
    const { data, error: rpcErr } = await (supabase as any).rpc('check_vault_unlock_rate_limit');
    if (rpcErr || !data || data.length === 0) {
      setRateLimit(null);
      return;
    }
    setRateLimit(data[0] as RateLimitState);
  };

  useEffect(() => { void refreshRateLimit(); }, []);

  // Tick once a second while we're cooling down so the countdown updates.
  useEffect(() => {
    if (!rateLimit || rateLimit.ok || !rateLimit.cooldown_until) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [rateLimit]);

  const cooldownRemainingMs = (() => {
    if (!rateLimit?.cooldown_until) return 0;
    return Math.max(0, new Date(rateLimit.cooldown_until).getTime() - now);
  })();
  const lockedOut = rateLimit && !rateLimit.ok && cooldownRemainingMs > 0;

  // Auto-clear lockout once the timer hits zero.
  useEffect(() => {
    if (lockedOut || !rateLimit || rateLimit.ok) return;
    if (cooldownRemainingMs === 0) void refreshRateLimit();
  }, [cooldownRemainingMs, lockedOut, rateLimit]);

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lockedOut) return;
    setError('');
    setLoading(true);
    try {
      await unlock(password);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Invalid vault password.';
      setError(msg);
      toast({ title: 'Unlock failed', description: msg, variant: 'destructive' });
      // Re-fetch rate-limit after a failure so the user sees the
      // updated count + any new cooldown immediately.
      await refreshRateLimit();
    }
    setLoading(false);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  const fmtCooldown = () => {
    const total = Math.ceil(cooldownRemainingMs / 1000);
    const mm = Math.floor(total / 60).toString();
    const ss = (total % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
  };

  const failuresLeft = rateLimit ? Math.max(0, 5 - rateLimit.failed_count) : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-background">
      <div className="w-full max-w-sm px-8">
        <div className="flex flex-col items-center mb-8">
          <div className="w-20 h-20 rounded-2xl bg-primary/10 flex items-center justify-center mb-4 animate-pulse-glow">
            <Lock className="w-10 h-10 text-primary" />
          </div>
          <div className="flex items-center gap-2 mb-1">
            <Bitcoin className="w-5 h-5 text-primary" />
            <h1 className="text-xl font-bold text-foreground">Orange Way Books</h1>
          </div>
          <p className="text-muted-foreground text-sm">Unlock your encrypted vault</p>
        </div>

        <div className="bg-card border border-border rounded-lg p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <ShieldCheck className="w-4 h-4 text-primary" />
            <span className="text-sm font-medium text-card-foreground">Layer 2 — Vault Password</span>
          </div>
          <p className="text-xs text-muted-foreground mb-4">
            Your vault password never leaves this device. It's used to decrypt your financial data locally.
          </p>

          {lockedOut && (
            <div
              role="alert"
              data-testid="vault-rate-limited"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3 mb-4 flex items-start gap-2"
            >
              <AlertTriangle className="w-4 h-4 mt-0.5 text-destructive shrink-0" />
              <div className="text-sm">
                <p className="font-medium text-destructive">Too many failed attempts</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Try again in <span className="font-mono">{fmtCooldown()}</span>. If you've forgotten your password, use the recovery code link below.
                </p>
              </div>
            </div>
          )}

          <form onSubmit={handleUnlock} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="vault-password">Vault Password</Label>
              <Input
                id="vault-password"
                type="password"
                placeholder="Enter vault password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
                disabled={!!lockedOut || loading}
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            {!lockedOut && failuresLeft !== null && failuresLeft < 5 && failuresLeft > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="vault-failures-remaining">
                {failuresLeft} {failuresLeft === 1 ? 'attempt' : 'attempts'} remaining before lockout.
              </p>
            )}
            <Button
              type="submit"
              className="w-full bg-primary hover:bg-primary-hover text-primary-foreground"
              disabled={loading || !!lockedOut}
            >
              {loading ? 'Unlocking…' : lockedOut ? `Locked — wait ${fmtCooldown()}` : 'Unlock Vault'}
            </Button>
          </form>

          <button
            type="button"
            onClick={() => setRecoveryOpen(true)}
            data-testid="forgot-password-link"
            className="w-full text-center text-sm text-primary hover:text-primary-hover mt-4 transition-colors underline-offset-4 hover:underline"
          >
            Forgot your password? Use your recovery code
          </button>

          <button
            onClick={handleLogout}
            className="w-full text-center text-sm text-muted-foreground hover:text-foreground mt-2 transition-colors"
          >
            Sign out instead
          </button>
        </div>
      </div>

      <VaultRecoveryDialog open={recoveryOpen} onClose={() => setRecoveryOpen(false)} />
    </div>
  );
}
