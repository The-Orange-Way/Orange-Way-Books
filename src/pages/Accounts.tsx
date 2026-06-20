import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  Plus,
  Search,
  RefreshCw,
  Upload,
  Download,
  Loader2,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
  Archive,
  ArchiveRestore,
  Pencil,
  CalendarIcon,
} from 'lucide-react';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useVault } from '@/context/VaultContext';
import {
  encryptWallet,
  decryptWallet,
  encryptTransaction,
  decryptTransaction,
  decryptOrgSettings,
  encryptJournalEntry,
} from '@/lib/crypto-fields';
import { buildJournalEntryLineInsert } from '@/lib/exchange/build-je-line-insert';
import { StatementPopup } from '@/components/accounts/statement-popup';
import { formatCrypto, formatFiat } from '@/lib/formatters';
import { resolvePinnedRate } from '@/lib/exchange/rate-resolver';
import { ImportPopup } from '@/components/ui/import-popup';
import type { ImportPreviewRow, ImportResult } from '@/components/ui/import-popup';
import { parseCsvAccounts, ACCOUNT_COLUMNS, ACCOUNT_SAMPLE_CSV } from '@/lib/csv/accounts';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { MultiSelect } from '@/components/ui/multi-select';
import { useFormatCurrency } from '@/hooks/useOrgSettings';
import type { BitcoinDisplay } from '@/types';

interface WalletRow {
  id: string;
  encrypted_name: string;
  asset: string;
  account_type: string | null;
  initial_balance: number;
  connection_type: string | null;
  created_at: string | null;
  archived?: boolean;
  institution?: string | null;
  issuer?: string | null;
  sync_status?: string | null;
  exchange_rate?: number | null;
  external_account_code?: string | null;
}

const CURRENCIES = [
  'BTC',
  'SATS',
  'USD',
  'EUR',
  'GBP',
  'CAD',
  'AUD',
  'JPY',
  'CHF',
  'MXN',
  'BRL',
  'CLP',
  'COP',
  'PEN',
  'ARS',
  'SGD',
  'HKD',
  'INR',
  'KRW',
  'THB',
  'IDR',
  'MYR',
  'PHP',
  'NOK',
  'SEK',
  'DKK',
  'CZK',
  'PLN',
  'HUF',
  'TRY',
  'ILS',
  'AED',
  'ZAR',
  'NZD',
];
const WALLET_TYPES = ['Exchange', 'Hardware', 'Software', 'Bank', 'Custodial'];
const INSTITUTIONS = [
  'Chase',
  'Coinbase',
  'Kraken',
  'Binance',
  'Gemini',
  'BlockFi',
  'Ledger',
  'Trezor',
];
const btcDisplay: BitcoinDisplay = 'sats';

type SortKey =
  | 'encrypted_name'
  | 'account_type'
  | 'institution'
  | 'initial_balance'
  | 'asset'
  | 'sync_status'
  | 'created_at';
type SortDir = 'asc' | 'desc';

export default function Accounts() {
  const { orgId, loading: orgLoading } = useUserOrg();
  const { encryptText, decryptText } = useVault();
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<WalletRow | null>(null);
  const [statementWallet, setStatementWallet] = useState<WalletRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [backfillOpen, setBackfillOpen] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // view state
  const [search, setSearch] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [expandedView, setExpandedView] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('encrypted_name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(25);

  // filters
  const [filterType, setFilterType] = useState<string[]>([]);
  const [filterInstitution, setFilterInstitution] = useState<string[]>([]);
  const [filterCurrency, setFilterCurrency] = useState<string[]>([]);

  // form state
  const [name, setName] = useState('');
  const [asset, setAsset] = useState('BTC');
  const [walletType, setWalletType] = useState('Exchange');
  const [institution, setInstitution] = useState('');
  const [issuer, setIssuer] = useState('');
  const [showIssuer, setShowIssuer] = useState(false);
  const [initialBalance, setInitialBalance] = useState('0');
  const [balanceDate, setBalanceDate] = useState<Date>(new Date());
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const initialFormRef = useRef<string>('');
  const [primaryCurrency, setPrimaryCurrency] = useState('USD');

  const markDirty = useCallback(() => {
    const current = JSON.stringify({
      name,
      asset,
      walletType,
      institution,
      issuer,
      initialBalance,
    });
    setDirty(current !== initialFormRef.current);
  }, [name, asset, walletType, institution, issuer, initialBalance]);

  useEffect(() => {
    markDirty();
  }, [markDirty]);

  const fetchWallets = async () => {
    if (!orgId) return;
    const [{ data }, { data: sData }] = await Promise.all([
      supabase
        .from('accounts')
        .select('*')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false }),
      supabase.from('org_settings').select('*').eq('org_id', orgId).maybeSingle(),
    ]);
    if (sData) {
      const dec = await decryptOrgSettings(sData as any, decryptText);
      if (dec.primary_currency) setPrimaryCurrency(dec.primary_currency.toUpperCase());
    }
    const decrypted = await Promise.all(
      ((data as any[]) ?? []).map(async (w) => {
        const fields = await decryptWallet(w, decryptText);
        return { ...w, ...fields };
      }),
    );
    setWallets(decrypted);
    setLoading(false);
  };

  useEffect(() => {
    if (orgId) fetchWallets();
    else if (!orgLoading) setLoading(false);
  }, [orgId, orgLoading]);

  const { formatAmount } = useFormatCurrency();
  const formatBalance = (amount: number, assetType: string) => formatAmount(amount, assetType);

  // filtering & sorting
  const filtered = useMemo(() => {
    return wallets.filter((w) => {
      if (!showArchived && w.archived) return false;
      if (showArchived && !w.archived) return false;
      if (filterType.length && !filterType.includes(w.account_type | '')) return false;
      if (filterCurrency.length && !filterCurrency.includes(w.asset)) return false;
      if (filterInstitution.length && !filterInstitution.includes(w.institution | '')) return false;
      if (search) {
        const term = search.toLowerCase();
        const n = (w.encrypted_name | '').toLowerCase();
        const inst = (w.institution | '').toLowerCase();
        if (!n.includes(term) && !inst.includes(term) && !w.asset.toLowerCase().includes(term))
          return false;
      }
      return true;
    });
  }, [wallets, showArchived, filterType, filterCurrency, filterInstitution, search]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      let av: any = (a as any)[sortKey] ?? '';
      let bv: any = (b as any)[sortKey] ?? '';
      if (sortKey === 'initial_balance') {
        av = Number(av);
        bv = Number(bv);
      } else {
        av = String(av).toLowerCase();
        bv = String(bv).toLowerCase();
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }, [filtered, sortKey, sortDir]);

  const paged = sorted.slice(page * perPage, (page + 1) * perPage);
  const totalPages = Math.max(1, Math.ceil(sorted.length / perPage));
  const startIdx = page * perPage + 1;
  const endIdx = Math.min((page + 1) * perPage, sorted.length);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="w-3 h-3 ml-1 opacity-40" />;
    return sortDir === 'asc' ? (
      <ArrowUp className="w-3 h-3 ml-1" />
    ) : (
      <ArrowDown className="w-3 h-3 ml-1" />
    );
  };

  const syncDot = (status: string | null | undefined) => {
    switch (status) {
      case 'SYNCED':
        return (
          <>
            <span className="w-2 h-2 rounded-full bg-green-500 inline-block mr-1" />
            Fresh
          </>
        );
      case 'SYNCING':
        return (
          <>
            <span className="w-2 h-2 rounded-full bg-amber-500 inline-block mr-1" />
            Syncing
          </>
        );
      case 'ERROR':
        return (
          <>
            <span className="w-2 h-2 rounded-full bg-red-500 inline-block mr-1" />
            Error
          </>
        );
      default:
        return <span className="text-muted-foreground">Never</span>;
    }
  };

  // modal handlers
  const openAdd = () => {
    setEditing(null);
    setName('');
    setAsset('BTC');
    setWalletType('Exchange');
    setInstitution('');
    setIssuer('');
    setShowIssuer(false);
    setInitialBalance('0');
    setBalanceDate(new Date());
    initialFormRef.current = JSON.stringify({
      name: '',
      asset: 'BTC',
      walletType: 'Exchange',
      institution: '',
      issuer: '',
      initialBalance: '0',
    });
    setDirty(false);
    setModalOpen(true);
  };

  const openEdit = (w: WalletRow) => {
    setEditing(w);
    setName(w.encrypted_name | '');
    setAsset(w.asset);
    setWalletType(w.account_type | 'Exchange');
    setInstitution(w.institution | '');
    setIssuer(w.issuer | '');
    setShowIssuer(!!w.issuer);
    initialFormRef.current = JSON.stringify({
      name: w.encrypted_name | '',
      asset: w.asset,
      walletType: w.account_type | 'Exchange',
      institution: w.institution | '',
      issuer: w.issuer | '',
      initialBalance: String(w.initial_balance ?? 0),
    });
    setDirty(false);
    setModalOpen(true);
  };

  const tryCloseModal = (open: boolean) => {
    if (!open && dirty) {
      if (!confirm('You have unsaved changes. Discard?')) return;
    }
    setModalOpen(open);
  };

  const handleSave = async () => {
    if (!orgId || !name.trim()) return;
    setSaving(true);
    try {
      if (editing) {
        const enc = await encryptWallet(
          {
            encrypted_name: name.trim(),
            initial_balance: editing.initial_balance ?? 0,
            asset,
            account_type: walletType,
            connection_type: editing.connection_type | 'manual',
            external_account_code: editing.external_account_code | null,
          },
          encryptText,
        );
        const { error } = await supabase
          .from('accounts')
          .update({
            ...enc,
          } as any)
          .eq('id', editing.id);
        if (error) throw error;

        // Resolve + store asset→BTC rate. Failure is non-blocking.
        try {
          const rate = await resolveAssetToBtcRate(asset);
          if (rate !== null) {
            await supabase
              .from('accounts')
              .update({ exchange_rate: rate } as any)
              .eq('id', editing.id);
          }
        } catch (rateErr) {
          console.warn('[Accounts] rate update on edit failed (non-fatal):', rateErr);
        }
      } else {
        const balance = parseFloat(initialBalance) | 0;
        const enc = await encryptWallet(
          {
            encrypted_name: name.trim(),
            initial_balance: balance,
            asset,
            account_type: walletType,
            connection_type: 'manual',
            external_account_code: null,
          },
          encryptText,
        );
        const { data: newWallet, error } = await supabase
          .from('accounts')
          .insert({
            org_id: orgId,
            ...enc,
          } as any)
          .select('id')
          .single();
        if (error) throw error;

        // Resolve + store asset→BTC rate. Failure is non-blocking.
        if (newWallet) {
          try {
            const rate = await resolveAssetToBtcRate(asset);
            if (rate !== null) {
              await supabase
                .from('accounts')
                .update({ exchange_rate: rate } as any)
                .eq('id', (newWallet as any).id);
            }
          } catch (rateErr) {
            console.warn('[Accounts] rate update on create failed (non-fatal):', rateErr);
          }
        }

        // Create opening balance transaction row when balance > 0
        if (balance > 0 && newWallet) {
          try {
            const txDate = format(balanceDate, 'yyyy-MM-dd');
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
              account_id: (newWallet as any).id,
              date: txDate,
              ...encTx,
            } as any);
            if (txErr) {
              console.error('Opening balance tx insert failed:', txErr);
            } else {
              toast.success(`Opening balance recorded: ${formatBalance(balance, asset)}`);
            }
          } catch (txErr) {
            console.error('Opening balance tx insert failed:', txErr);
          }

          // Also post a beginning balance journal entry (DR wallet / CR Owner's Equity)
          // so the ledger engine picks it up via JE lines (the proper accounting path)
          try {
            const jeDate = format(balanceDate, 'yyyy-MM-dd');
            const encJe = await encryptJournalEntry(
              {
                memo: `Opening balance — ${name.trim()}`,
                ref_number: null,
                currency: asset,
                exchange_rate: null,
                status: 'POSTED',
                source_type: 'opening_balance',
                period_locked: false,
              },
              encryptText,
            );
            const { data: je, error: jeErr } = await supabase
              .from('journal_entries')
              .insert({
                org_id: orgId,
                date: jeDate,
                ...encJe,
              } as any)
              .select('id')
              .single();
            if (!jeErr && je) {
              const debitLine = await buildJournalEntryLineInsert({
                wallet_currency: asset,
                primary_currency: primaryCurrency,
                date: jeDate,
                debit: balance,
                credit: 0,
                account_name: name.trim(),
                description: 'Opening balance',
                encrypt: encryptText,
              });
              const creditLine = await buildJournalEntryLineInsert({
                wallet_currency: asset,
                primary_currency: primaryCurrency,
                date: jeDate,
                debit: 0,
                credit: balance,
                account_name: "Owner's Equity",
                description: 'Opening balance',
                encrypt: encryptText,
              });
              await supabase.from('journal_entry_lines').insert([
                { journal_entry_id: (je as any).id, ...debitLine.insert },
                { journal_entry_id: (je as any).id, ...creditLine.insert },
              ] as any);
            }
          } catch (jeErr) {
            console.error('Opening balance JE insert failed (non-fatal):', jeErr);
          }
        }
      }
      setModalOpen(false);
      await fetchWallets();
    } catch (err: any) {
      alert('Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleBackfillOpeningBalances = async () => {
    if (!orgId) return;
    setBackfilling(true);
    try {
      // Re-fetch raw wallet rows (we need encrypted columns + initial_balance)
      const { data: rawWallets, error: wErr } = await supabase
        .from('accounts')
        .select('*')
        .eq('org_id', orgId);
      if (wErr) throw wErr;

      let created = 0;
      for (const w of (rawWallets as any[]) ?? []) {
        const initBal = Number(w.initial_balance ?? 0);
        if (!(initBal > 0)) continue;

        // Fetch this wallet's transactions and decrypt types
        const { data: txs } = await supabase
          .from('transactions')
          .select('*')
          .eq('account_id', w.id);
        let hasOpening = false;
        for (const tx of (txs as any[]) ?? []) {
          try {
            const fields = await decryptTransaction(tx, decryptText);
            if (fields.type === 'opening_balance') {
              hasOpening = true;
              break;
            }
          } catch {
            // skip rows we cannot decrypt
          }
        }
        if (hasOpening) continue;

        // Decrypt wallet to get asset (wallet.asset is encrypted at L2)
        let walletAsset = w.asset;
        try {
          const wFields = await decryptWallet(w, decryptText);
          walletAsset = wFields.asset | w.asset;
        } catch {
          // fallback to raw
        }

        const dateStr = w.created_at
          ? format(new Date(w.created_at), 'yyyy-MM-dd')
          : format(new Date(), 'yyyy-MM-dd');
        try {
          const encTx = await encryptTransaction(
            {
              memo: 'Opening balance',
              amount: initBal,
              usd_value: null,
              exchange_rate: null,
              asset: walletAsset,
              type: 'opening_balance',
              status: 'complete',
              cleared_status: 'NOT_CLEARED',
            },
            encryptText,
          );
          const { error: txErr } = await supabase.from('transactions').insert({
            org_id: orgId,
            account_id: w.id,
            date: dateStr,
            ...encTx,
          } as any);
          if (txErr) {
            console.error(`Backfill failed for wallet ${w.id}:`, txErr);
          } else {
            created++;
          }
        } catch (err) {
          console.error(`Backfill encrypt failed for wallet ${w.id}:`, err);
        }
      }

      toast.success(`Created ${created} opening balance transaction${created === 1 ? '' : 's'}.`);
      await fetchWallets();
    } catch (err: any) {
      toast.error('Backfill failed: ' + (err?.message | String(err)));
    } finally {
      setBackfilling(false);
      setBackfillOpen(false);
    }
  };

  // Resolve (asset → BTC) rate. Returns null on any failure.
  // BTC → BTC is 1 by construction (identity in resolver).
  const resolveAssetToBtcRate = async (assetCode: string): Promise<number | null> => {
    try {
      const result = await resolvePinnedRate({ source: assetCode, target: 'BTC' });
      if (result.pending) return null;
      if (!Number.isFinite(result.rate) || result.rate <= 0) return null;
      return result.rate;
    } catch (err) {
      console.warn(`[Accounts] rate resolve failed for ${assetCode}→BTC`, err);
      return null;
    }
  };

  // Stub for external-source sync. Real connectors will be wired later.
  // TODO: wire real connector sync (exchange/bank APIs) here.
  const syncExternalWallet = async (_w: WalletRow): Promise<void> => {
    // No-op until real connectors are wired.
  };

  const handleRefreshAll = async () => {
    if (!orgId || refreshing) return;
    setRefreshing(true);
    // a) Optimistically mark every visible wallet as SYNCING
    setWallets((prev) => prev.map((w) => ({ ...w, sync_status: 'SYNCING' })));

    const snapshot = wallets;
    let successCount = 0;
    let errorCount = 0;

    try {
      await Promise.all(
        snapshot.map(async (w) => {
          try {
            // d) External-source stub (still refresh rate either way)
            const ct = (w.connection_type | '').toLowerCase();
            const isExternal = (ct === 'exchange') | (ct === 'bank');
            if (isExternal) {
              await syncExternalWallet(w);
            }

            // b) Fresh rate (asset → BTC); null for failures (including for BTC which resolves to 1)
            const rate = await resolveAssetToBtcRate(w.asset);

            // Persist: exchange_rate + sync_status
            const update: Record<string, any> = { sync_status: 'SYNCED' };
            if (rate !== null) update.exchange_rate = rate;
            const { error } = await supabase
              .from('accounts')
              .update(update as any)
              .eq('id', w.id);
            if (error) throw error;
            successCount++;
          } catch (err) {
            errorCount++;
            console.error(`[Accounts] refresh failed for wallet ${w.id}:`, err);
            await supabase
              .from('accounts')
              .update({ sync_status: 'ERROR' } as any)
              .eq('id', w.id);
          }
        }),
      );

      if (errorCount === 0) {
        toast.success(`Refreshed rates for ${successCount} wallet${successCount === 1 ? '' : 's'}`);
      } else {
        toast.error(
          `Refreshed ${successCount} wallet${successCount === 1 ? '' : 's'}; ${errorCount} failed`,
        );
      }
    } catch (err: any) {
      console.error('[Accounts] refresh failed:', err);
      toast.error('Refresh failed: ' + (err?.message | String(err)));
    } finally {
      // e) Re-read wallet list
      await fetchWallets();
      setRefreshing(false);
    }
  };

  const handleArchiveToggle = async (w: WalletRow) => {
    // For now just toggle in local state (no DB column yet)
    setWallets((prev) =>
      prev.map((ww) => (ww.id === w.id ? { ...ww, archived: !ww.archived } : ww)),
    );
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && modalOpen) tryCloseModal(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [modalOpen, dirty]);

  if (loading || orgLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold text-foreground">Accounts</h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search accounts..."
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              className="pl-8 w-[200px]"
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={handleRefreshAll}
            disabled={refreshing}
            title="Refresh rates & sync accounts"
          >
            {refreshing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <RefreshCw className="w-4 h-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs text-muted-foreground"
            onClick={() => setBackfillOpen(true)}
            title="Create opening balance transactions for existing accounts"
          >
            Backfill Opening Balances
          </Button>
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="w-4 h-4 mr-1" />
            Import
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Download className="w-4 h-4 mr-1" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>PDF</DropdownMenuItem>
              <DropdownMenuItem>CSV</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button onClick={openAdd}>
            <Plus className="w-4 h-4 mr-1" />
            Add Account
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 mb-3">
        <MultiSelect
          label="All Types"
          options={WALLET_TYPES}
          selected={filterType}
          onChange={(v) => {
            setFilterType(v);
            setPage(0);
          }}
        />
        <MultiSelect
          label="All Institutions"
          options={INSTITUTIONS}
          selected={filterInstitution}
          onChange={(v) => {
            setFilterInstitution(v);
            setPage(0);
          }}
        />
        <MultiSelect
          label="All Currencies"
          options={CURRENCIES}
          selected={filterCurrency}
          onChange={(v) => {
            setFilterCurrency(v);
            setPage(0);
          }}
        />
      </div>

      {/* Archive / Expand toggles */}
      <div className="flex items-center justify-between mb-4">
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          onClick={() => {
            setShowArchived(!showArchived);
            setPage(0);
          }}
        >
          {showArchived ? 'Hide Archived Accounts' : 'Show Archived Accounts'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          onClick={() => setExpandedView(!expandedView)}
        >
          {expandedView ? '<< Collapse View' : 'Expand View >>'}
        </Button>
      </div>

      {/* Table */}
      {sorted.length === 0 ? (
        <div className="bg-card border border-border rounded-lg p-12 text-center text-muted-foreground text-sm">
          No accounts yet — click '+ Add Account' to get started.
        </div>
      ) : (
        <>
          {/* Desktop / tablet table (>= md). Card list below covers mobile. */}
          <div className="bg-card border border-border rounded-lg overflow-x-auto hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort('encrypted_name')}
                  >
                    <span className="flex items-center">
                      Name
                      <SortIcon col="encrypted_name" />
                    </span>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort('account_type')}
                  >
                    <span className="flex items-center">
                      Type
                      <SortIcon col="account_type" />
                    </span>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort('institution')}
                  >
                    <span className="flex items-center">
                      Institution
                      <SortIcon col="institution" />
                    </span>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none text-right"
                    onClick={() => toggleSort('initial_balance')}
                  >
                    <span className="flex items-center justify-end">
                      Balance
                      <SortIcon col="initial_balance" />
                    </span>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort('asset')}
                  >
                    <span className="flex items-center">
                      Currency
                      <SortIcon col="asset" />
                    </span>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort('sync_status')}
                  >
                    <span className="flex items-center">
                      Last Sync
                      <SortIcon col="sync_status" />
                    </span>
                  </TableHead>
                  {expandedView && (
                    <>
                      <TableHead>Issuer</TableHead>
                      <TableHead className="text-right">Exchange Rate</TableHead>
                      <TableHead className="text-right">BTC Balance</TableHead>
                    </>
                  )}
                  <TableHead className="w-[100px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.map((w) => (
                  <TableRow
                    key={w.id}
                    className={cn('cursor-pointer hover:bg-muted/40', w.archived && 'opacity-50')}
                    onClick={() => setStatementWallet(w)}
                  >
                    <TableCell className="font-medium text-[13px]">
                      {w.encrypted_name || '[Encrypted]'}
                    </TableCell>
                    <TableCell className="text-xs">{w.account_type || '—'}</TableCell>
                    <TableCell className="text-xs">{w.institution || '—'}</TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatBalance(w.initial_balance ?? 0, w.asset)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={w.asset === 'BTC' ? 'default' : 'secondary'}
                        className="text-[10px]"
                      >
                        {w.asset}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">{syncDot(w.sync_status)}</TableCell>
                    {expandedView &&
                      (() => {
                        const isBtc = w.asset === 'BTC';
                        const effectiveRate = isBtc ? 1 : (w.exchange_rate ?? null);
                        const btcBalance =
                          effectiveRate !== null ? (w.initial_balance ?? 0) * effectiveRate : null;
                        const rateLabel = isBtc
                          ? '1 BTC'
                          : effectiveRate !== null
                            ? `1 ${w.asset} = ${Number(effectiveRate).toLocaleString(undefined, { maximumSignificantDigits: 6 })} BTC`
                            : '—';
                        return (
                          <>
                            <TableCell className="text-xs">{w.issuer || '—'}</TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {rateLabel}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {btcBalance !== null ? formatBalance(btcBalance, 'BTC') : '—'}
                            </TableCell>
                          </>
                        );
                      })()}
                    <TableCell>
                      <div className="flex gap-1" onClick={(e) => e.stopPropagation()}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => openEdit(w)}
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => handleArchiveToggle(w)}
                        >
                          {w.archived ? (
                            <ArchiveRestore className="w-3.5 h-3.5" />
                          ) : (
                            <Archive className="w-3.5 h-3.5" />
                          )}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* Mobile: card list (< md). Tap a card to open the statement sheet. */}
          <div className="md:hidden space-y-2">
            {paged.map((w) => {
              const isBtc = w.asset === 'BTC';
              const effectiveRate = isBtc ? 1 : (w.exchange_rate ?? null);
              const btcBalance =
                expandedView && effectiveRate !== null
                  ? (w.initial_balance ?? 0) * effectiveRate
                  : null;
              return (
                <div
                  key={w.id}
                  className={cn(
                    'bg-card border border-border rounded-lg p-3 cursor-pointer active:bg-muted/40',
                    w.archived && 'opacity-50',
                  )}
                  onClick={() => setStatementWallet(w)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-[13px] font-medium">
                        <span className="truncate">{w.encrypted_name || '[Encrypted]'}</span>
                        <Badge
                          variant={w.asset === 'BTC' ? 'default' : 'secondary'}
                          className="text-[10px] shrink-0"
                        >
                          {w.asset}
                        </Badge>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground truncate">
                        {[w.account_type, w.institution].filter(Boolean).join(' · ') | '—'}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-sm tabular-nums">
                        {formatBalance(w.initial_balance ?? 0, w.asset)}
                      </div>
                      <div className="mt-0.5 text-[10px] text-muted-foreground">
                        {syncDot(w.sync_status)}
                      </div>
                    </div>
                  </div>
                  {expandedView && (
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                      {w.issuer && (
                        <div className="col-span-2 truncate text-muted-foreground">
                          Issuer: {w.issuer}
                        </div>
                      )}
                      <div className="text-muted-foreground">
                        {isBtc
                          ? '1 BTC'
                          : effectiveRate !== null
                            ? `1 ${w.asset} = ${Number(effectiveRate).toLocaleString(undefined, { maximumSignificantDigits: 6 })} BTC`
                            : 'Rate: —'}
                      </div>
                      <div className="text-right font-mono">
                        {btcBalance !== null ? formatBalance(btcBalance, 'BTC') : '—'}
                      </div>
                    </div>
                  )}
                  <div
                    className="mt-2 flex justify-end gap-0.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => openEdit(w)}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => handleArchiveToggle(w)}
                    >
                      {w.archived ? (
                        <ArchiveRestore className="w-3.5 h-3.5" />
                      ) : (
                        <Archive className="w-3.5 h-3.5" />
                      )}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4 text-sm">
            <span className="text-muted-foreground">
              Showing {startIdx}–{endIdx} of {sorted.length} accounts
            </span>
            <div className="flex items-center gap-2">
              <Select
                value={String(perPage)}
                onValueChange={(v) => {
                  setPerPage(Number(v));
                  setPage(0);
                }}
              >
                <SelectTrigger className="w-[70px] h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[10, 25, 50].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages - 1}
                onClick={() => setPage(page + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Add/Edit Modal */}
      <Dialog open={modalOpen} onOpenChange={tryCloseModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{editing ? 'Edit Account' : 'Add Account'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>Name *</Label>
              <Input
                placeholder="e.g. Main Checking"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <Label>Account Type</Label>
              <Select value={walletType} onValueChange={setWalletType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WALLET_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Institution</Label>
              <Input
                placeholder="e.g. Chase, Coinbase"
                value={institution}
                onChange={(e) => setInstitution(e.target.value)}
                list="inst-list"
              />
              <datalist id="inst-list">
                {INSTITUTIONS.map((i) => (
                  <option key={i} value={i} />
                ))}
              </datalist>
            </div>
            <div>
              <Label>Currency *</Label>
              <Select value={asset} onValueChange={setAsset}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!showIssuer ? (
              <button
                type="button"
                className="text-xs text-primary hover:underline"
                onClick={() => setShowIssuer(true)}
              >
                + Define Issuer
              </button>
            ) : (
              <div>
                <Label>Issuer</Label>
                <Input
                  placeholder="Optional issuer"
                  value={issuer}
                  onChange={(e) => setIssuer(e.target.value)}
                />
              </div>
            )}
            {!editing && (
              <>
                <div>
                  <Label>Beginning Balance *</Label>
                  <div className="relative">
                    <span className="absolute left-3 top-2.5 text-xs text-muted-foreground">
                      {asset === 'BTC' ? '₿' : '$'}
                    </span>
                    <Input
                      type="number"
                      step="any"
                      value={initialBalance}
                      onChange={(e) => setInitialBalance(e.target.value)}
                      onBlur={() => {
                        const n = parseFloat(initialBalance);
                        if (!isNaN(n))
                          setInitialBalance(asset === 'BTC' ? n.toFixed(8) : n.toFixed(2));
                      }}
                      className="pl-7 text-right font-mono"
                    />
                  </div>
                </div>
                <div>
                  <Label>Date *</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="w-full justify-start text-left">
                        <CalendarIcon className="w-4 h-4 mr-2" />
                        {format(balanceDate, 'MM/dd/yyyy')}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar
                        mode="single"
                        selected={balanceDate}
                        onSelect={(d) => d && setBalanceDate(d)}
                        className="p-3 pointer-events-auto"
                      />
                    </PopoverContent>
                  </Popover>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => tryCloseModal(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={saving || !name.trim()}>
              {saving && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              {saving ? 'Saving...' : editing ? 'Save Changes' : 'Add Account'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Backfill Opening Balances confirmation */}
      <AlertDialog
        open={backfillOpen}
        onOpenChange={(o) => {
          if (!backfilling) setBackfillOpen(o);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Backfill opening balance transactions?</AlertDialogTitle>
            <AlertDialogDescription>
              Create opening balance transactions for accounts that have an initial balance but no
              opening balance transaction yet? This scans every transaction on every qualifying
              account and may take a moment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={backfilling}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleBackfillOpeningBalances();
              }}
              disabled={backfilling}
            >
              {backfilling && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              {backfilling ? 'Backfilling...' : 'Backfill'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Statement / Reconcile Popup */}
      <StatementPopup
        open={!!statementWallet}
        onClose={() => setStatementWallet(null)}
        wallet={statementWallet}
        orgId={orgId ?? ''}
      />

      {/* CSV Import */}
      <ImportPopup
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          fetchWallets();
        }}
        entityName="Accounts"
        sampleCsvContent={ACCOUNT_SAMPLE_CSV}
        sampleFileName="accounts-sample.csv"
        columns={ACCOUNT_COLUMNS}
        tips={[
          'Name and Currency are required fields.',
          'Valid types: EXCHANGE, HARDWARE, SOFTWARE, BANK, CUSTODIAL.',
          'Duplicate wallet names will be skipped.',
        ]}
        parseCsv={parseCsvAccounts}
        onImportRows={async (rows: ImportPreviewRow[]): Promise<ImportResult> => {
          if (!orgId)
            return {
              created: 0,
              skipped: 0,
              failed: rows.length,
              errors: ['No organization found'],
            };
          // decryptWallet reads encrypted_name, encrypted_balance, asset, account_type, etc.
          // A partial select (e.g. only encrypted_name) leaves asset undefined → decrypt throws an atob error.
          const { data: existing } = await supabase
            .from('accounts')
            .select('*')
            .eq('org_id', orgId);
          const decryptedExisting = await Promise.all(
            (existing | []).map(async (w: any) => {
              const fields = await decryptWallet(w, decryptText);
              return fields.encrypted_name;
            }),
          );
          const existingNames = new Set(decryptedExisting.map((n) => n?.toLowerCase()));
          let created = 0,
            skipped = 0,
            failed = 0;
          const errors: string[] = [];
          const warnings: string[] = [];
          for (const row of rows) {
            const name = row.data.name.trim();
            if (existingNames.has(name.toLowerCase())) {
              skipped++;
              warnings.push(`"${name}" already exists — skipped`);
              continue;
            }
            const enc = await encryptWallet(
              {
                encrypted_name: name,
                initial_balance: parseFloat(row.data.balance) | 0,
                asset: row.data.currency,
                account_type: row.data.type.toLowerCase(),
                connection_type: 'manual',
                external_account_code: null,
              },
              encryptText,
            );
            const { error } = await supabase.from('accounts').insert({
              org_id: orgId,
              ...enc,
            } as any);
            if (error) {
              const msg = error.message | '';
              if (
                msg.toLowerCase().includes('already exists') |
                msg.toLowerCase().includes('duplicate') |
                msg.includes('23505')
              ) {
                skipped++;
                warnings.push(`"${name}" already exists`);
              } else {
                failed++;
                errors.push(`Row ${row.rowIndex + 1}: ${msg}`);
              }
            } else {
              created++;
              existingNames.add(name.toLowerCase());
            }
          }
          return { created, skipped, failed, errors, warnings };
        }}
      />
    </div>
  );
}
