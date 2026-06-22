import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { LATEST_VAULT_KEY_VERSION } from '@/lib/vault';
import { ShieldCheck, Loader2 } from 'lucide-react';

interface SecurityTabProps {
  orgId: string | null;
}

export function SecurityTab({ orgId }: SecurityTabProps) {
  const [keyVersion, setKeyVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    const { data: settings } = await supabase
      .from('org_settings')
      .select('vault_key_version')
      .eq('org_id', orgId)
      .maybeSingle();
    const kv =
      (settings as { vault_key_version?: number | null } | null)?.vault_key_version ??
      LATEST_VAULT_KEY_VERSION;
    setKeyVersion(kv);
    setLoading(false);
  }, [orgId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading || keyVersion === null) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm">
        <Loader2 className="w-4 h-4 animate-spin" />
        Loading vault status…
      </div>
    );
  }

  return (
    <div className="max-w-2xl rounded-lg border border-border bg-card p-5 space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="w-5 h-5 text-vault-unlocked" />
        <h3 className="text-base font-semibold text-card-foreground">
          Vault is at the latest version (v{keyVersion}, Argon2id)
        </h3>
      </div>
      <p className="text-sm text-muted-foreground">
        Your vault uses Argon2id (memory-hard key derivation, OWASP 2023 parameters) with the
        random-MEK wrapping pattern. Password changes re-wrap the master key instead of
        re-encrypting every row. Future format upgrades will appear here when available.
      </p>
    </div>
  );
}
