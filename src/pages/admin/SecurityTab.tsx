import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { upgradeVaultToV3, type UpgradeProgressEvent } from '@/lib/vault-migration';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { ShieldCheck, ShieldAlert, CheckCircle2, Loader2 } from 'lucide-react';

interface SecurityTabProps {
  orgId: string | null;
}

export function SecurityTab({ orgId }: SecurityTabProps) {
  const [keyVersion, setKeyVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const [password, setPassword] = useState('');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<UpgradeProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    const { data: settings } = await supabase
      .from('org_settings')
      .select('vault_key_version')
      .eq('org_id', orgId)
      .maybeSingle();
    const kv = (settings as { vault_key_version?: number | null } | null)?.vault_key_version ?? 1;
    setKeyVersion(kv);
    setLoading(false);
  }, [orgId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const handleUpgrade = async () => {
    if (!orgId) return;
    setError(null);
    setRunning(true);
    setProgress({ phase: 'verify', done: 0, total: 1 });
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');
      await upgradeVaultToV3({
        password,
        userId: user.id,
        orgId,
        supabase,
        onProgress: (evt) => setProgress(evt),
      });
      setCompleted(true);
      setPassword('');
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Vault upgrade failed';
      setError(msg);
    } finally {
      setRunning(false);
    }
  };

  if (loading || keyVersion === null) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading vault status…
      </div>
    );
  }

  // Already on the latest version — nothing to do.
  if (keyVersion >= 3) {
    return (
      <div className="max-w-2xl rounded-lg border border-border bg-card p-5 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-vault-unlocked" />
          <h3 className="text-base font-semibold text-card-foreground">
            Vault is at the latest version (v3 — Argon2id)
          </h3>
        </div>
        <p className="text-sm text-muted-foreground">
          Your vault uses Argon2id (memory-hard KDF, OWASP 2023 parameters). No
          action required. Future upgrades will appear here when available.
        </p>
      </div>
    );
  }

  const progressPercent = progress ? Math.round((progress.done / Math.max(1, progress.total)) * 100) : 0;

  return (
    <div className="max-w-2xl rounded-lg border border-border bg-card p-5 space-y-4">
      <div className="flex items-center gap-2">
        <ShieldAlert className="w-5 h-5 text-[var(--color-brand-orange)]" />
        <h3 className="text-base font-semibold text-card-foreground">
          Upgrade vault security (Argon2id v3)
        </h3>
      </div>
      <p className="text-sm text-muted-foreground">
        Your vault currently uses PBKDF2 (v{keyVersion}). Upgrading to Argon2id
        v3 makes offline brute-force attacks significantly more expensive by
        requiring 64&nbsp;MiB of memory per password guess. The upgrade is
        transactional — your data is either fully on v3 or unchanged on v
        {keyVersion}. Please enter your current vault password to proceed.
      </p>

      <div className="space-y-2">
        <Label htmlFor="security-vault-pw">Current vault password</Label>
        <Input
          id="security-vault-pw"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          disabled={running}
        />
      </div>

      {running && progress && (
        <div className="space-y-1.5">
          <Progress value={progressPercent} className="h-2" />
          <p className="text-xs text-muted-foreground">
            {describePhase(progress)} ({progress.done}/{progress.total})
          </p>
        </div>
      )}

      {completed && (
        <div className="flex items-start gap-2 rounded-md border border-vault-unlocked/40 bg-vault-unlocked/10 p-3 text-sm">
          <CheckCircle2 className="w-4 h-4 text-vault-unlocked mt-0.5" />
          <span>Vault upgrade complete. All data is now protected by Argon2id v3.</span>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Button
        onClick={handleUpgrade}
        disabled={running || password.length === 0}
        className="w-full sm:w-auto"
      >
        {running ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin mr-2" />
            Upgrading…
          </>
        ) : (
          'Upgrade vault to v3'
        )}
      </Button>
    </div>
  );
}

function describePhase(evt: UpgradeProgressEvent): string {
  switch (evt.phase) {
    case 'verify': return 'Verifying current password';
    case 'precheck': return 'Running pre-flight checks';
    case 'keygen': return 'Deriving new Argon2id key';
    case 'table:read': return `Reading ${evt.table ?? 'data'}`;
    case 'table:rewrite': return `Re-encrypting ${evt.table ?? 'data'}`;
    case 'blob:download': return 'Downloading attachment blobs';
    case 'blob:rewrite': return 'Re-encrypting attachment blobs';
    case 'commit': return 'Committing transaction';
    case 'cleanup': return 'Cleaning up old blobs';
    case 'done': return 'Complete';
    default: return 'Working';
  }
}
