/**
 * DestinationAccountPicker — Phase 3 second step of the add-connection flow.
 *
 * After the user picks WHICH source wallets to sync (WalletPickerStep), this
 * dialog asks WHERE each source wallet's transactions should land. The picker
 * is also re-opened later from the connection card via "Edit mapping".
 *
 * IMPORTANT — Phase 3 fix: the destination is a WALLET (rows from the
 * `wallets` table), not a chart-of-accounts entry. The earlier Phase 3
 * implementation incorrectly inserted into `chart_of_accounts`, mixing the
 * accounting math layer (Asset/Liability/Equity/...) with the user-facing
 * wallets concept. This picker now lists active wallets the user already has
 * (or can create one inline) and stores the wallet id in
 * connection_account_map.encrypted_account_id (semantically a wallet id; the
 * column name and schema are unchanged).
 *
 * Default UX choice: 1:1 mapping. Each source wallet has a single Select
 * that picks a destination wallet. A small "+ New" button next to each
 * select opens an inline modal that creates the wallet (reusing the same
 * encryptAccount path Accounts.tsx uses) and auto-selects it.
 *
 * Every wallets row stays encrypted on disk; this component only uses the
 * already-decrypted in-memory wallet name to render the dropdown options.
 */

import { useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import { CalendarIcon, Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { supabase } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import {
  decryptWallet,
  encryptWallet,
  encryptTransaction,
} from '@/lib/crypto-fields';
import { resolvePinnedRate } from '@/lib/exchange/rate-resolver';

/** Account types matching the existing Accounts.tsx UI. */
const WALLET_TYPES = ['Exchange', 'Hardware', 'Software', 'Bank', 'Custodial'] as const;

/** Currencies offered for inline-create. Mirrors Accounts.tsx CURRENCIES. */
const CURRENCIES = [
  'BTC', 'SATS',
  'USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'CHF',
  'MXN', 'BRL', 'CLP', 'COP', 'PEN', 'ARS',
  'SGD', 'HKD', 'INR', 'KRW', 'THB', 'IDR', 'MYR', 'PHP',
  'NOK', 'SEK', 'DKK', 'CZK', 'PLN', 'HUF', 'TRY',
  'ILS', 'AED', 'ZAR', 'NZD',
];

export interface SourceWalletPick {
  external_wallet_id: string;
  currency: string;
  label?: string | null;
  /** Pre-selected wallets.id when editing an existing mapping. */
  initialAccountId?: string | null;
}

export interface WalletOption {
  id: string;
  name: string;
  asset: string;
  account_type: string | null;
  archived: boolean;
}

export interface DestinationAccountPickerProps {
  open: boolean;
  orgId: string;
  /** Plaintext source wallets (already decrypted by caller). */
  sourceWallets: SourceWalletPick[];
  onCancel: () => void;
  /**
   * Persists the chosen mappings. external_account_id retains its column name for
   * backwards-compat with the connection_account_map schema, but the value is
   * now a wallets.id (semantically a wallet id).
   */
  onConfirm: (
    mappings: Array<{ or_external_wallet_id: string; external_account_id: string }>,
  ) => Promise<void>;
}

/**
 * Resolve an asset → BTC rate (1 for BTC). Returns null on failure so the
 * caller can keep going without a stored rate. Mirrors the helper in
 * Accounts.tsx so behavior is consistent across creation surfaces.
 */
async function resolveAssetToBtcRate(assetCode: string): Promise<number | null> {
  try {
    const result = await resolvePinnedRate({ source: assetCode, target: 'BTC' });
    if (result.pending) return null;
    if (!Number.isFinite(result.rate) | result.rate <= 0) return null;
    return result.rate;
  } catch (err) {
    console.warn(`[DestinationAccountPicker] rate resolve failed for ${assetCode}→BTC`, err);
    return null;
  }
}

export function DestinationAccountPicker({
  open,
  orgId,
  sourceWallets,
  onCancel,
  onConfirm,
}: DestinationAccountPickerProps) {
  const { decryptText } = useVault();
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [loadingWallets, setLoadingWallets] = useState(false);
  const [walletsError, setWalletsError] = useState<string | null>(null);

  /** source_wallet.external_wallet_id → wallets.id */
  const [picked, setPicked] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const w of sourceWallets) {
      if (w.initialAccountId) init[w.external_wallet_id] = w.initialAccountId;
    }
    return init;
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [createOpenForWallet, setCreateOpenForWallet] = useState<string | null>(null);

  const refreshWallets = useMemo(() => async () => {
    setLoadingWallets(true);
    setWalletsError(null);
    try {
      const { data, error: dbErr } = await supabase
        .from('accounts')
        .select('*')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false });
      if (dbErr) throw dbErr;
      const decrypted = await Promise.all(
        ((data as any[]) ?? []).map(async (row): Promise<WalletOption | null> => {
          try {
            const fields = await decryptWallet(row, decryptText);
            // No archived column in OWB wallets schema yet; archived state lives
            // only in local UI state in Accounts.tsx, so we treat all rows as
            // selectable here.
            return {
              id: row.id as string,
              name: fields.encrypted_name | '[Encrypted]',
              asset: fields.asset,
              account_type: fields.account_type,
              archived: false,
            };
          } catch {
            return null;
          }
        }),
      );
      setWallets(decrypted.filter((w): w is WalletOption => w !== null));
    } catch (err) {
      setWalletsError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingWallets(false);
    }
  }, [orgId, decryptText]);

  useEffect(() => {
    if (open) void refreshWallets();
  }, [open, refreshWallets]);

  function handleCreated(sourceWalletId: string, newWalletId: string) {
    setPicked((prev) => ({ ...prev, [sourceWalletId]: newWalletId }));
    setCreateOpenForWallet(null);
    void refreshWallets();
  }

  async function handleConfirm() {
    setError(null);
    setSubmitting(true);
    try {
      const mappings = sourceWallets
        .map((w) => ({
          or_external_wallet_id: w.external_wallet_id,
          // external_account_id column name is preserved for schema stability;
          // the value is now a wallets.id (encrypted before persistence by
          // the caller's saveMappingsForConnection helper).
          external_account_id: picked[w.external_wallet_id] ?? '',
        }))
        .filter((m) => m.external_account_id);
      await onConfirm(mappings);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  }

  // Group wallets by asset (currency) for nicer dropdown sectioning.
  const walletsByAsset = useMemo(() => {
    const m = new Map<string, WalletOption[]>();
    for (const w of wallets) {
      const arr = m.get(w.asset) ?? [];
      arr.push(w);
      m.set(w.asset, arr);
    }
    return m;
  }, [wallets]);

  // The source wallet being created-for, if any. Used to seed the inline
  // create form's currency from the source wallet's currency.
  const creatingForWallet = createOpenForWallet
    ? sourceWallets.find((w) => w.external_wallet_id === createOpenForWallet) ?? null
    : null;

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          // Only close on explicit programmatic intent (via onCancel) — block
          // backdrop / Escape close so a stray click doesn't lose the
          // partially-configured connection state.
          if (!o && !submitting) {
            // Intentionally do nothing here; close is driven by Skip/Cancel
            // buttons or the explicit X close button.
          }
        }}
      >
        <DialogContent
          className="max-w-lg"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Where should these wallets land?</DialogTitle>
            <DialogDescription>
              Pick a destination wallet for each source wallet. You can change this
              later from the connection card.
            </DialogDescription>
          </DialogHeader>

          {walletsError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {walletsError}
            </div>
          )}

          <div className="space-y-3">
            {sourceWallets.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No source wallets selected — nothing to route.
              </p>
            ) : (
              sourceWallets.map((w) => (
                <div
                  key={w.external_wallet_id}
                  className="rounded-md border p-3 space-y-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">
                        {w.label | w.currency} wallet
                      </div>
                      <div className="text-xs text-muted-foreground font-mono truncate">
                        {w.currency}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="flex-1">
                      <Select
                        value={picked[w.external_wallet_id] ?? ''}
                        onValueChange={(v) =>
                          setPicked((prev) => ({ ...prev, [w.external_wallet_id]: v }))
                        }
                        disabled={loadingWallets | submitting}
                      >
                        <SelectTrigger>
                          <SelectValue
                            placeholder={
                              loadingWallets
                                ? 'Loading wallets…'
                                : 'Pick a destination wallet'
                            }
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {Array.from(walletsByAsset.entries()).map(([asset, opts]) => (
                            <div key={asset}>
                              <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                                {asset}
                              </div>
                              {opts.map((wal) => (
                                <SelectItem key={wal.id} value={wal.id}>
                                  {wal.name}
                                  {wal.account_type ? (
                                    <span className="ml-2 text-xs text-muted-foreground">
                                      ({wal.account_type})
                                    </span>
                                  ) : null}
                                </SelectItem>
                              ))}
                            </div>
                          ))}
                          {wallets.length === 0 && !loadingWallets && (
                            <div className="px-2 py-2 text-xs text-muted-foreground">
                              No wallets yet — create one with the + button.
                            </div>
                          )}
                        </SelectContent>
                      </Select>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setCreateOpenForWallet(w.external_wallet_id)}
                      disabled={submitting}
                      title="Create a new wallet"
                    >
                      <Plus className="w-3 h-3 mr-1" />
                      New
                    </Button>
                  </div>
                </div>
              ))
            )}
          </div>

          <p className="text-xs text-muted-foreground">
            Mapping is encrypted in your browser before being saved. OrangeRails and the
            Orange Way Books server cannot tell which OR wallet maps to which Orange Way Books wallet.
          </p>

          {error && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={onCancel}
              disabled={submitting}
            >
              Skip for now
            </Button>
            <Button type="button" onClick={handleConfirm} disabled={submitting}>
              {submitting ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                  Saving…
                </>
              ) : (
                'Save mapping'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {createOpenForWallet && creatingForWallet && (
        <CreateWalletInlineDialog
          orgId={orgId}
          defaultName={`${creatingForWallet.label | creatingForWallet.currency} wallet`}
          defaultAsset={creatingForWallet.currency | 'BTC'}
          onCancel={() => setCreateOpenForWallet(null)}
          onCreated={(newId) => handleCreated(createOpenForWallet, newId)}
        />
      )}
    </>
  );
}

// ─── Inline create-wallet modal ──────────────────────────────────────────

interface CreateWalletInlineDialogProps {
  orgId: string;
  defaultName: string;
  defaultAsset: string;
  onCancel: () => void;
  onCreated: (newWalletId: string) => void;
}

function CreateWalletInlineDialog({
  orgId,
  defaultName,
  defaultAsset,
  onCancel,
  onCreated,
}: CreateWalletInlineDialogProps) {
  const { encryptText } = useVault();
  const [name, setName] = useState(defaultName);
  const [asset, setAsset] = useState<string>(
    CURRENCIES.includes(defaultAsset) ? defaultAsset : 'BTC',
  );
  const [walletType, setWalletType] = useState<string>('Exchange');
  const [openingBalanceStr, setOpeningBalanceStr] = useState<string>('0');
  const [openingDate, setOpeningDate] = useState<Date>(new Date());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const balance = parseFloat(openingBalanceStr) | 0;

      // Encrypted insert — same path Accounts.tsx uses for user-created wallets,
      // tagged with connection_type='orangerails' so we can later distinguish
      // wallets that were spawned from a connection mapping flow.
      const enc = await encryptWallet(
        {
          encrypted_name: name.trim(),
          initial_balance: balance,
          asset,
          account_type: walletType,
          connection_type: 'orangerails',
          external_account_code: null,
        },
        encryptText,
      );
      const { data: newWallet, error: insErr } = await supabase
        .from('accounts')
        .insert({
          org_id: orgId,
          ...enc,
        } as any)
        .select('id')
        .single();
      if (insErr) throw insErr;
      const newId = (newWallet as { id: string } | null)?.id;
      if (!newId) throw new Error('Wallet insert returned no id');

      // Resolve + store asset→BTC rate. Failure is non-blocking — same
      // tolerance Accounts.tsx grants its create path.
      try {
        const rate = await resolveAssetToBtcRate(asset);
        if (rate !== null) {
          await supabase.from('accounts').update({ exchange_rate: rate } as any).eq('id', newId);
        }
      } catch (rateErr) {
        console.warn('[DestinationAccountPicker] rate update on create failed (non-fatal):', rateErr);
      }

      // Opening balance transaction (only when balance > 0). Mirrors the
      // shape Accounts.tsx writes so the wallet's history is identical
      // regardless of whether it was created from /wallets or this picker.
      if (balance > 0) {
        try {
          const txDate = format(openingDate, 'yyyy-MM-dd');
          const encTx = await encryptTransaction(
            {
              memo: 'Opening balance',
              amount: balance,
              usd_value: null,
              exchange_rate: null,
              asset,
              type: 'opening_balance',
              status: 'complete',
              cleared_status: 'NOT_CLEARED',
            },
            encryptText,
          );
          const { error: txErr } = await supabase.from('transactions').insert({
            org_id: orgId,
            account_id: newId,
            date: txDate,
            ...encTx,
          } as any);
          if (txErr) {
            console.error('Opening balance tx insert failed:', txErr);
          }
        } catch (txErr) {
          console.error('Opening balance tx insert failed:', txErr);
        }
      }

      toast.success('Wallet created');
      onCreated(newId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => { /* close only via explicit Cancel — protect partial input */ }}>
      <DialogContent
        className="max-w-md"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>Create new wallet</DialogTitle>
          <DialogDescription>
            This wallet is encrypted in your browser before it leaves. It will appear in
            your Accounts list alongside the rest.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="cw-new-name">Name</Label>
            <Input
              id="cw-new-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Blink Lightning"
              disabled={submitting}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cw-new-currency">Currency</Label>
              <Select value={asset} onValueChange={setAsset} disabled={submitting}>
                <SelectTrigger id="cw-new-currency">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cw-new-type">Type</Label>
              <Select value={walletType} onValueChange={setWalletType} disabled={submitting}>
                <SelectTrigger id="cw-new-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WALLET_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="cw-new-balance">Opening balance</Label>
              <div className="relative">
                <span className="absolute left-3 top-2.5 text-xs text-muted-foreground">
                  {asset === 'BTC' ? '₿' : '$'}
                </span>
                <Input
                  id="cw-new-balance"
                  type="number"
                  step="any"
                  value={openingBalanceStr}
                  onChange={(e) => setOpeningBalanceStr(e.target.value)}
                  onBlur={() => {
                    const n = parseFloat(openingBalanceStr);
                    if (!isNaN(n)) setOpeningBalanceStr(asset === 'BTC' ? n.toFixed(8) : n.toFixed(2));
                  }}
                  className="pl-7 text-right font-mono"
                  disabled={submitting}
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Leave at 0 if the wallet starts empty before its first transaction.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>As of</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    className="w-full justify-start text-left font-normal"
                    disabled={submitting}
                  >
                    <CalendarIcon className="w-4 h-4 mr-2" />
                    {format(openingDate, 'MM/dd/yyyy')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={openingDate}
                    onSelect={(d) => d && setOpeningDate(d)}
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={submitting | !name.trim()}>
            {submitting ? (
              <>
                <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                Creating…
              </>
            ) : (
              'Create wallet'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
