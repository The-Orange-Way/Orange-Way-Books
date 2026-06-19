/**
 * LegacyVaultBanner — surfaces a warning when the active org is using a
 * vault key version older than the current default (v4).
 *
 * Background
 * ──────────
 * Orange Way Books has shipped 4 generations of vault encryption:
 *   v1  PBKDF2 + deterministic salt; many columns stored plaintext
 *   v2  PBKDF2 + per-org random salt; amounts encrypted, types/currencies plaintext (legacy vault scheme)
 *   v3  Argon2id derived KEK; same column coverage as the v2 scheme
 *   v4  Random MEK wrapped under Argon2id KEK + recovery code KEK; ALL business
 *       columns encrypted (amounts, types, currencies, statuses, memos, etc.)
 *
 * New orgs default to v4 (see VaultContext.LATEST_VAULT_KEY_VERSION). The only
 * way to end up on v1-v3 is a stale account that pre-dates the migration. For
 * those orgs, some business metadata (account type, currency, status) is
 * stored in plaintext on the server, weakening the ZKA promise.
 *
 * This banner detects vault_key_version < 4 on AppShell mount and tells the
 * user. Auto-migration is intentionally not offered yet because the upgrade
 * is a column-by-column re-encrypt of every row and needs more careful UX
 * than a banner can give (Phase 4.6 work). For now we surface the situation
 * + point at support, and stop the user from being blind to it.
 *
 * Surfaced by 2026-05-16 security review. Tracked as S5.
 */

import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';

const DISMISS_KEY_PREFIX = 'legacy_vault_banner_dismissed_';
const LATEST = 4;

interface Props {
  orgId: string | null;
}

export function LegacyVaultBanner({ orgId }: Props) {
  const [keyVersion, setKeyVersion] = useState<number | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    setDismissed(localStorage.getItem(`${DISMISS_KEY_PREFIX}${orgId}`) === '1');
    (async () => {
      const { data } = await (supabase as any)
        .from('org_settings')
        .select('vault_key_version')
        .eq('org_id', orgId)
        .maybeSingle();
      setKeyVersion((data as any)?.vault_key_version ?? null);
    })();
  }, [orgId]);

  if (!orgId || keyVersion === null || keyVersion >= LATEST || dismissed) return null;

  const handleDismiss = () => {
    localStorage.setItem(`${DISMISS_KEY_PREFIX}${orgId}`, '1');
    setDismissed(true);
  };

  return (
    <div
      role="alert"
      data-testid="legacy-vault-banner"
      className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-200 flex items-start gap-3"
    >
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="flex-1 space-y-1">
        <p className="font-medium">Your vault is on an older encryption version (v{keyVersion}).</p>
        <p className="text-xs">
          Newer organizations are created on v{LATEST}, which encrypts more
          metadata client-side (account types, currencies, statuses). Your data
          stays usable, but some metadata is stored in plaintext on our servers.
          Contact support for a guided upgrade, or create a fresh organization
          and import a backup.
        </p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={handleDismiss}
        aria-label="Dismiss"
        className="h-7 w-7 p-0"
      >
        <X className="w-4 h-4" />
      </Button>
    </div>
  );
}
