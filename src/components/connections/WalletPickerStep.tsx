/**
 * WalletPickerStep — Phase 3 source-wallet picker.
 *
 * After a connection is added, OR's or-discover-wallets returns the list of
 * wallets visible to that API key. This dialog lets the user check which ones
 * to sync. Each pick's metadata is encrypted with ORK by the parent before
 * being sent to or-source-wallets-set; this component handles only the UX and
 * does not touch crypto.
 *
 * Mirrors the pattern in orange-rails/src/components/app/WalletPickerStep.tsx
 * but uses OWB shadcn primitives (Dialog/Checkbox/Button) for visual consistency.
 *
 * If the user "Skips for now" the connection still works in legacy account-wide
 * mode — the parent surfaces a toast.
 */
import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';

export interface DiscoveredWallet {
  external_wallet_id: string;
  currency: string;
  label?: string;
}

export interface WalletPickerStepProps {
  open: boolean;
  discoveredWallets: DiscoveredWallet[];
  providerName: string;
  onSkip: () => void;
  onConfirm: (selections: Array<DiscoveredWallet & { is_synced: boolean }>) => Promise<void>;
}

export function WalletPickerStep({
  open,
  discoveredWallets,
  providerName,
  onSkip,
  onConfirm,
}: WalletPickerStepProps) {
  // All wallets default to checked — matches the previous "sync everything"
  // baseline so users don't lose data by accident on first connect.
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(discoveredWallets.map((w) => w.external_wallet_id)),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggle(walletId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(walletId)) next.delete(walletId);
      else next.add(walletId);
      return next;
    });
  }

  async function handleConfirm() {
    setError(null);
    setSubmitting(true);
    try {
      const selections = discoveredWallets.map((w) => ({
        ...w,
        is_synced: selected.has(w.external_wallet_id),
      }));
      await onConfirm(selections);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  const noneSelected = selected.size === 0;

  return (
    <Dialog open={open} onOpenChange={() => { /* close only via explicit Skip / Confirm — protect partial setup */ }}>
      <DialogContent
        className="max-w-md"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            Found {discoveredWallets.length}{' '}
            {discoveredWallets.length === 1 ? 'wallet' : 'wallets'} on {providerName}
          </DialogTitle>
          <DialogDescription>
            Pick which wallets to sync. Wallet labels and currencies are encrypted with your
            vault key before they leave your browser — OrangeRails can't read them.
          </DialogDescription>
        </DialogHeader>

        {discoveredWallets.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            This account has no wallets to choose from.
          </div>
        ) : (
          <div className="space-y-2">
            {discoveredWallets.map((w) => {
              const isChecked = selected.has(w.external_wallet_id);
              return (
                <label
                  key={w.external_wallet_id}
                  className={[
                    'flex items-center gap-3 rounded-md border p-3 cursor-pointer transition-colors',
                    isChecked ? 'bg-primary/5 border-primary/40' : 'hover:bg-muted/30',
                  ].join(' ')}
                >
                  <Checkbox
                    checked={isChecked}
                    onCheckedChange={() => toggle(w.external_wallet_id)}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      {w.label || w.currency} wallet
                    </div>
                    <div className="text-xs text-muted-foreground font-mono truncate">
                      {w.currency} · {w.external_wallet_id.slice(0, 12)}…
                    </div>
                  </div>
                </label>
              );
            })}
          </div>
        )}

        {noneSelected && discoveredWallets.length > 0 && (
          <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
            No wallets selected — saving as-is will pause sync for this connection.
          </div>
        )}

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onSkip} disabled={submitting}>
            Skip for now
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={submitting || discoveredWallets.length === 0}
          >
            {submitting ? (
              <>
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                Saving…
              </>
            ) : (
              'Confirm selection'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
