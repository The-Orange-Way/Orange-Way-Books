import { useEffect, useState, useMemo, useRef, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { Plus, Search, RefreshCw, Upload, Download, Loader2, ArrowUp, ArrowDown, ArrowUpDown, Pencil, Trash2, CalendarIcon, Link2, X, Check, Ban, CheckCircle2, BookOpen } from 'lucide-react';
import { format, startOfYear, endOfYear, startOfMonth, startOfWeek, subMonths, subYears } from 'date-fns';
import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useCapability } from '@/hooks/useCapability';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import {
  Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter, SheetDescription,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import type { BitcoinDisplay } from '@/types';
import { ImportPopup } from '@/components/ui/import-popup';
import type { ImportPreviewRow, ImportResult } from '@/components/ui/import-popup';
import { parseCsvTransactions, TRANSACTION_COLUMNS, TRANSACTION_SAMPLE_CSV } from '@/lib/csv/transactions';
import { useVault } from '@/context/VaultContext';
import { encryptTransaction, decryptTransaction, decryptWallet, decryptChartOfAccount, decryptOrgSettings, decryptOrganization } from '@/lib/crypto-fields';
// Phase 2 removal: legacy-ledger dual-write deleted from CSV import path.
import { useFormatCurrency } from '@/hooks/useOrgSettings';
import { writeAuditLog } from '@/lib/audit-logger';
import { voidTransaction } from '@/lib/transactions/void-transaction';
import { exportToCsv } from '@/lib/exports/csv';
import { printTable } from '@/lib/exports/print-table';
import { csvExportCurrencyLabel } from '@/lib/exports/csv-currency-label';
import { transactionAmountNumericForCsv } from '@/lib/exports/csv-transaction-amount';
import { toast } from 'sonner';
import TransactionModal, { fetchAccountsForModal, fetchContactsForModal, type AccountOption as TxAccountOption, type ContactOption as TxContactOption } from '@/components/transactions/transaction-modal';

interface TxRow {
  id: string;
  account_id: string | null;
  type: string;
  asset: string;
  amount: number;
  usd_value: number | null;
  date: string;
  memo: string | null;
  exchange_rate: number | null;
  created_at: string | null;
  status: string;
  cleared_status: string;
  ref_number?: string | null;
  to_from?: string | null;
  linked_tx_id?: string | null;
  linked_transfer_id?: string | null;
  /** chart_of_accounts.id (PK) — populated by the modal on save and by the
   *  Phase 5 OR import bridge. Null for legacy rows; the Edit modal then
   *  shows the empty "Select account" placeholder until the user picks one. */
  account_id?: string | null;
  /** contacts.id of the customer / vendor / employee this row was tagged
   *  with. Independent of account_id. Null for legacy + most OR imports. */
  contact_id?: string | null;
  /** journal_entries.id wrapper for split + transfer modes. Required to be
   *  non-null in order to use the Void action — voiding writes a reversing
   *  JE that nets the original to zero. Standard-mode txs (NULL here) need
   *  T4 status-state-machine unification before they can be voided. */
  journal_entry_id?: string | null;
}

// Local ContactOption is a superset of the modal's TxContactOption — same
// id + name, plus kind so we can group contacts in the picker by Customer /
// Vendor / Employee. Decoded from `contacts.type` (encrypted by OWB).
interface ContactOption { id: string; name: string; kind: string | null; }

interface WalletOption { id: string; encrypted_name: string; asset: string; external_account_id?: string; }

type SortKey = 'date' | 'account_id' | 'amount' | 'asset' | 'type' | 'to_from' | 'ref_number' | 'memo';
type SortDir = 'asc' | 'desc';
type DatePreset = 'today' | 'this_week' | 'this_month' | 'ytd' | 'this_year' | 'last_month' | 'last_year' | 'all_time' | 'custom';

const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'this_week', label: 'This Week' },
  { value: 'this_month', label: 'This Month' },
  { value: 'ytd', label: 'Year to Date' },
  { value: 'this_year', label: 'This Year' },
  { value: 'last_month', label: 'Last Month' },
  { value: 'last_year', label: 'Last Year' },
  { value: 'all_time', label: 'All Time' },
  { value: 'custom', label: 'Custom' },
];

const TX_TYPES = ['Buy', 'Sell', 'Receive', 'Send', 'Transfer'];
const TRANSACTION_EXPORT_HEADERS = [
  'Date',
  'Type',
  'Asset',
  'Wallet Currency',
  'Amount',
  'USD value',
  'Status',
  'Cleared',
  'Wallet',
  'To/From',
  'Ref #',
  'Memo',
  'Linked tx',
] as const;

function getDateRange(preset: DatePreset): { from: Date | undefined; to: Date | undefined } {
  const now = new Date();
  switch (preset) {
    case 'today': return { from: now, to: now };
    case 'this_week': return { from: startOfWeek(now), to: now };
    case 'this_month': return { from: startOfMonth(now), to: now };
    case 'ytd': return { from: startOfYear(now), to: now };
    case 'this_year': return { from: startOfYear(now), to: endOfYear(now) };
    case 'last_month': return { from: startOfMonth(subMonths(now, 1)), to: subMonths(startOfMonth(now), 0) };
    case 'last_year': return { from: startOfYear(subYears(now, 1)), to: startOfYear(now) };
    case 'all_time': return { from: undefined, to: undefined };
    default: return { from: undefined, to: undefined };
  }
}

export default function Transactions() {
  const { orgId, loading: orgLoading } = useUserOrg();
  const { encryptText, decryptText, encryptBlob, loadOrgSigningKey, signMutation } = useVault();
  // Capability gates — server-side RLS is the authoritative enforcement
  // (user_has_capability). These flags only control button visibility so
  // a Viewer/Auditor never sees a control that would 403.
  const canDeleteTx = useCapability('transactions.delete', orgId);
  // Both hooks must be called unconditionally — the previous `a | b` form
  // short-circuited the second useCapability call between renders and
  // crashed the page with React error #311 (hooks-order violation).
  const canWriteTxAll = useCapability('transactions.write', orgId);
  const canWriteTxOwn = useCapability('transactions.write_own', orgId);
  const canWriteTxAny = canWriteTxAll | canWriteTxOwn;
  const [orgName, setOrgName] = useState('');
  const [txs, setTxs] = useState<TxRow[]>([]);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [legacyJournalId, setlegacy ledger backendJournalId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [lockedDialogOpen, setLockedDialogOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<TxRow | null>(null);
  const [btcDisplay, setBtcDisplay] = useState<BitcoinDisplay>('sats');
  const [importOpen, setImportOpen] = useState(false);
  const importedTxKeysRef = useRef<Set<string>>(new Set());
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [accountOptions, setAccountOptions] = useState<TxAccountOption[]>([]);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  const [linkSubmitting, setLinkSubmitting] = useState(false);
  const [bulkActing, setBulkActing] = useState(false);
  const [retryingRates, setRetryingRates] = useState(false);

  // view
  const [search, setSearch] = useState('');
  const [datePreset, setDatePreset] = useState<DatePreset>('ytd');
  const [customFrom, setCustomFrom] = useState<Date | undefined>();
  const [customTo, setCustomTo] = useState<Date | undefined>();
  // Status vocabulary (T4.a Option A locked 2026-05-12):
  // transactions.status ∈ {DRAFT, POSTED, RECONCILED, VOID, HIDDEN}.
  // Filter strings here are URL-state, lowercase by convention.
  const [statusFilter, setStatusFilter] = useState<'all' | 'draft' | 'posted' | 'not-cleared' | 'cleared' | 'reconciled'>('all');
  // Drawer filters — empty wallet set = all wallets; blank amount strings = no bound.
  const [walletFilter, setWalletFilter] = useState<Set<string>>(new Set());
  const [amountMin, setAmountMin] = useState<string>('');
  const [amountMax, setAmountMax] = useState<string>('');
  const [filtersDrawerOpen, setFiltersDrawerOpen] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);
  const [perPage, setPerPage] = useState(25);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [qbImportedJeCount, setQbImportedJeCount] = useState<number>(0);

  const fetchData = async () => {
    if (!orgId) return;
    const [txRes, wRes, settingsRes, cRes, orgRes] = await Promise.all([
      supabase.from('transactions').select('*').eq('org_id', orgId).order('date', { ascending: false }),
      supabase.from('accounts').select('id, encrypted_name, asset, key_version, external_account_id').eq('org_id', orgId),
      supabase.from('org_settings').select('*').eq('org_id', orgId).maybeSingle(),
      supabase.from('contacts').select('id, name, type, key_version').eq('org_id', orgId),
      supabase.from('organizations').select('external_journal_id, name, key_version').eq('id', orgId).maybeSingle(),
    ]);
    const orgData = orgRes.data as { external_journal_id?: string | null; name?: string | null; key_version?: number | null } | null;
    setlegacy ledger backendJournalId(orgData?.external_journal_id | null);
    if (orgData) {
      const decOrg = await decryptOrganization({ name: orgData.name | '', key_version: orgData.key_version ?? null } as any, decryptText);
      setOrgName((decOrg.name ?? '').trim());
    }
    const decryptedTxs = await Promise.all(
      ((txRes.data as any[]) ?? []).map(async (tx) => {
        const fields = await decryptTransaction(tx, decryptText);
        return { ...tx, ...fields, status: fields.status | 'DRAFT', cleared_status: fields.cleared_status | 'NOT_CLEARED' };
      })
    );
    setTxs(decryptedTxs);
    const decryptedWallets = await Promise.all(
      ((wRes.data as any[]) ?? []).map(async (w) => {
        const fields = await decryptWallet(w, decryptText);
        return { ...w, ...fields };
      })
    );
    setWallets(decryptedWallets);
    // Decrypt contacts
    const decryptedContacts: ContactOption[] = await Promise.all(
      ((cRes.data as any[]) ?? []).map(async (c) => {
        const name = c.key_version ? await decryptText(c.name) : c.name;
        const kind = c.type
          ? (c.key_version ? await decryptText(c.type).catch(() => null) : c.type)
          : null;
        return { id: c.id, name: name | '[Encrypted]', kind: kind ?? 'OTHER' };
      })
    );
    setContacts(decryptedContacts);
    if (settingsRes.data) {
      const decSettings = await decryptOrgSettings(settingsRes.data as any, decryptText);
      if (decSettings.bitcoin_display) setBtcDisplay(decSettings.bitcoin_display as BitcoinDisplay);
    }
    // Accounts for the Transaction modal
    try {
      const accts = await fetchAccountsForModal(orgId, decryptText);
      setAccountOptions(accts);
    } catch (err) {
      console.warn('Failed to fetch accounts:', err);
    }
    // Count QB-imported journal entries so the banner can point users to the
    // Journal Entries page after a QuickBooks import. Counts every QB-tagged
    // entry in the org — there's no per-import expiry today.
    try {
      const { count } = await supabase
        .from('journal_entries')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', orgId)
        .contains('encrypted_metadata', { source: 'quickbooks' } as never);
      setQbImportedJeCount(count ?? 0);
    } catch (err) {
      console.warn('Failed to count QB-imported journal entries:', err);
      setQbImportedJeCount(0);
    }
    setLoading(false);
  };

  const handleRetryRates = async () => {
    setRetryingRates(true);
    try {
      await supabase.functions.invoke('exchange-rate-fetch', {
        body: { base: 'BTC', quote: 'USD', date: new Date().toISOString().slice(0, 10) },
      });
    } catch { /* ignore */ }
    await fetchData();
    setRetryingRates(false);
  };

  useEffect(() => {
    if (orgId) fetchData();
    else if (!orgLoading) setLoading(false);
  }, [orgId, orgLoading]);

  const walletMap = useMemo(() => {
    const m: Record<string, string> = {};
    wallets.forEach(w => { m[w.id] = w.encrypted_name | '[Encrypted]'; });
    return m;
  }, [wallets]);

  const dateRange = useMemo(() => {
    if (datePreset === 'custom') return { from: customFrom, to: customTo };
    return getDateRange(datePreset);
  }, [datePreset, customFrom, customTo]);

  /** Shown in the DATE RANGE row. */
  const effectiveRangeLabels = useMemo(() => {
    if (datePreset === 'all_time') return { from: '—', to: '—' };
    const from = dateRange.from ? format(dateRange.from, 'yyyy-MM-dd') : '—';
    const to = dateRange.to ? format(dateRange.to, 'yyyy-MM-dd') : '—';
    return { from, to };
  }, [datePreset, dateRange.from, dateRange.to]);

  const displayYear = useMemo(() => {
    if (datePreset === 'custom' && customFrom) return customFrom.getFullYear();
    if (dateRange.from) return dateRange.from.getFullYear();
    return new Date().getFullYear();
  }, [datePreset, customFrom, dateRange.from]);

  const yearSelectOptions = useMemo(() => {
    const y = new Date().getFullYear();
    const out: number[] = [];
    for (let i = y - 6; i <= y + 1; i++) out.push(i);
    return out;
  }, []);

  /** BTC rows without a pinned rate — surfaces a banner hint at the top. */
  const pendingRateLineCount = useMemo(
    () => txs.filter((t) => t.asset === 'BTC' && (t.exchange_rate == null | Number(t.exchange_rate) === 0)).length,
    [txs],
  );

  const filtered = useMemo(() => {
    return txs.filter(tx => {
      if (dateRange.from && new Date(tx.date) < dateRange.from) return false;
      if (dateRange.to) {
        const to = new Date(dateRange.to); to.setHours(23, 59, 59);
        if (new Date(tx.date) > to) return false;
      }
      if (search) {
        const term = search.toLowerCase();
        const wName = tx.account_id ? (walletMap[tx.account_id] | '') : '';
        if (
          !tx.type.toLowerCase().includes(term) &&
          !tx.asset.toLowerCase().includes(term) &&
          !(tx.memo | '').toLowerCase().includes(term) &&
          !wName.toLowerCase().includes(term)
        ) return false;
      }
      // Status filter
      if (statusFilter !== 'all') {
        const s = tx.status | 'DRAFT';
        const cs = tx.cleared_status | 'NOT_CLEARED';
        switch (statusFilter) {
          case 'draft': if (s !== 'DRAFT') return false; break;
          case 'posted': if (s !== 'POSTED') return false; break;
          case 'not-cleared': if (cs !== 'NOT_CLEARED') return false; break;
          case 'cleared': if (cs !== 'CLEARED') return false; break;
          case 'reconciled': if (cs !== 'RECONCILED') return false; break;
        }
      }
      // Wallet (account) multi-select — empty set means "all wallets",
      // any populated set restricts to its members. Txs without a wallet
      // never match a non-empty set.
      if (walletFilter.size > 0) {
        if (!tx.account_id | !walletFilter.has(tx.account_id)) return false;
      }
      // Amount range — compare absolute amounts so inflow/outflow symmetry
      // doesn't surprise the user. Blank min/max bypasses that side.
      if (amountMin !== '' | amountMax !== '') {
        const abs = Math.abs(Number(tx.amount));
        if (amountMin !== '') {
          const min = Number(amountMin);
          if (Number.isFinite(min) && abs < min) return false;
        }
        if (amountMax !== '') {
          const max = Number(amountMax);
          if (Number.isFinite(max) && abs > max) return false;
        }
      }
      return true;
    });
  }, [txs, dateRange, search, walletMap, statusFilter, walletFilter, amountMin, amountMax]);

  // Active-filter chip count shown on the drawer trigger button. Excludes
  // status (it has its own dropdown next to the trigger) so the chip
  // reflects only what the drawer itself controls.
  const drawerFilterCount =
    (walletFilter.size > 0 ? 1 : 0) +
    (amountMin !== '' ? 1 : 0) +
    (amountMax !== '' ? 1 : 0);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      let av: any = (a as any)[sortKey] ?? '';
      let bv: any = (b as any)[sortKey] ?? '';
      if (sortKey === 'amount') { av = Number(av); bv = Number(bv); }
      else if (sortKey === 'date') { av = new Date(av).getTime(); bv = new Date(bv).getTime(); }
      else { av = String(av).toLowerCase(); bv = String(bv).toLowerCase(); }
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

  const pageNumberButtons = useMemo(() => {
    const t = totalPages;
    const p = page;
    if (t <= 1) return [0];
    const windowSize = 5;
    let start = Math.max(0, p - Math.floor(windowSize / 2));
    let end = Math.min(t - 1, start + windowSize - 1);
    start = Math.max(0, end - windowSize + 1);
    const nums: number[] = [];
    for (let i = start; i <= end; i++) nums.push(i);
    return nums;
  }, [totalPages, page]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const SortIcon = ({ col }: { col: SortKey }) => {
    if (sortKey !== col) return <ArrowUpDown className="w-3 h-3 ml-1 opacity-40" />;
    return sortDir === 'asc' ? <ArrowUp className="w-3 h-3 ml-1" /> : <ArrowDown className="w-3 h-3 ml-1" />;
  };

  const { formatAmount: fmtOrgAmount, settings: txFmtSettings } = useFormatCurrency();
  const fmtAmount = (amount: number, asset: string) => fmtOrgAmount(amount, asset);

  /**
   * PDF/print: same strings as the table (₿ / $ / grouping — good for humans).
   * CSV: Amount + USD value are plain numbers only; **Wallet Currency** carries Satoshis /
   * BTC Bitcoins / BTC / USD so Excel can SUM Amount without text cells.
   */
  const buildTransactionExportRows = useCallback(
    (opts?: { spreadsheetNumeric?: boolean }): (string | number | null)[][] => {
      const numeric = opts?.spreadsheetNumeric ?? false;
      return sorted.map((tx) => {
        const amt = Number(tx.amount);
        const isIn = amt >= 0;
        const amountCell = numeric
          ? transactionAmountNumericForCsv(amt, tx.asset, txFmtSettings.bitcoinDisplayPreference)
          : `${isIn ? '+' : ''}${fmtAmount(amt, tx.asset)}`;
        const usdCell =
          tx.usd_value == null ? '' : numeric ? tx.usd_value : fmtOrgAmount(tx.usd_value, 'USD');
        return [
          tx.date,
          tx.type,
          tx.asset,
          csvExportCurrencyLabel(tx.asset, txFmtSettings.bitcoinDisplayPreference),
          amountCell,
          usdCell,
          tx.status,
          tx.cleared_status,
          tx.account_id ? walletMap[tx.account_id] ?? '' : '',
          tx.to_from ?? '',
          tx.ref_number ?? '',
          tx.memo ?? '',
          tx.linked_tx_id ?? '',
        ];
      });
    },
    [sorted, walletMap, fmtAmount, fmtOrgAmount, txFmtSettings.bitcoinDisplayPreference],
  );

  const exportTransactionsCsv = useCallback(() => {
    if (sorted.length === 0) {
      toast.error('Nothing to export.');
      return;
    }
    const rows = buildTransactionExportRows({ spreadsheetNumeric: true });
    exportToCsv(`owb-transactions-${format(new Date(), 'yyyy-MM-dd')}`, [...TRANSACTION_EXPORT_HEADERS], rows);
    toast.success(`Exported ${sorted.length} transaction(s) to CSV.`);
  }, [buildTransactionExportRows]);

  const exportTransactionsPdf = useCallback(() => {
    if (sorted.length === 0) {
      toast.error('Nothing to export.');
      return;
    }
    const rows = buildTransactionExportRows();
    const from = dateRange.from ? format(dateRange.from, 'yyyy-MM-dd') : 'start';
    const to = dateRange.to ? format(dateRange.to, 'yyyy-MM-dd') : 'end';
    const title = `${orgName | 'Organization'} — Transactions — ${from} to ${to}`;
    void printTable(title, [...TRANSACTION_EXPORT_HEADERS], rows)
      .then((opened) => {
        if (opened) {
          toast.success('Use Print → Save as PDF in the preview window.');
        }
      })
      .catch(() => {
        toast.error('Could not open the print preview. Check popups and try again.');
      });
  }, [buildTransactionExportRows, dateRange, orgName]);

  // Status toggling — persists to DB. Vocab: DRAFT ↔ POSTED.
  const togglePosted = async (id: string) => {
    const tx = txs.find(t => t.id === id);
    if (!tx) return;
    const newStatus = tx.status === 'POSTED' ? 'DRAFT' : 'POSTED';
    setTxs(prev => prev.map(t => t.id === id ? { ...t, status: newStatus } : t));
    const encStatus = await encryptText(newStatus);
    await supabase.from('transactions').update({ status: encStatus, key_version: 2 } as any).eq('id', id);
  };

  const cycleCleared = async (id: string) => {
    const tx = txs.find(t => t.id === id);
    if (!tx) return;
    const s = tx.cleared_status | 'NOT_CLEARED';
    if (s === 'RECONCILED') {
      toast.info('To unreconcile, open the wallet statement.');
      return;
    }
    const next = s === 'NOT_CLEARED' ? 'CLEARED' : 'NOT_CLEARED';
    setTxs(prev => prev.map(t => t.id === id ? { ...t, cleared_status: next } : t));
    const encCleared = await encryptText(next);
    await supabase.from('transactions').update({ cleared_status: encCleared, key_version: 2 } as any).eq('id', id);
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const toggleSelectAll = () => {
    if (selected.size === paged.length) setSelected(new Set());
    else setSelected(new Set(paged.map(t => t.id)));
  };

  // ── Modal open/close ──
  // Reconciliation edit-lock: opening edit on a RECONCILED tx shows the
  // informational dialog rather than letting the user mutate it.
  const openAdd = () => {
    setEditingTx(null);
    setModalOpen(true);
  };

  const openEdit = (tx: TxRow) => {
    if (tx.cleared_status === 'RECONCILED') {
      setLockedDialogOpen(true);
      return;
    }
    setEditingTx(tx);
    setModalOpen(true);
  };

  const handleDelete = async (id: string) => {
    const tx = txs.find(t => t.id === id);
    if (tx?.cleared_status === 'RECONCILED') {
      setLockedDialogOpen(true);
      return;
    }
    if (!confirm('Delete this transaction?')) return;
    await supabase.from('transactions').delete().eq('id', id);
    writeAuditLog({
      orgId: orgId!, action: 'DELETE', entityType: 'transaction', entityId: id,
      summary: 'Deleted transaction', encrypt: encryptText,
    });
    await fetchData();
  };

  /**
   * Void a transaction. Track 2 T3 v1 — writes a reversing JE in the current
   * period, flips the original (and its linked transfer pair, if any) to
   * status='VOID'. Only available for split + transfer transactions today
   * (the ones with a journal_entry_id wrapper). Standard-mode txs need
   * T4 unification before they can be voided this way.
   */
  const handleVoid = async (id: string) => {
    const tx = txs.find(t => t.id === id);
    if (!tx) return;
    if (tx.cleared_status === 'RECONCILED') {
      setLockedDialogOpen(true);
      return;
    }
    if (!tx.journal_entry_id) {
      alert(
        'This transaction cannot be voided yet. Standard-mode transactions ' +
          'need the unified write path (Track 2 T4) before voiding works. ' +
          'For now use Delete to remove an unposted draft.',
      );
      return;
    }
    const reason = prompt('Reason for voiding (optional):') ?? undefined;
    if (!confirm('Void this transaction? A reversing journal entry will be posted in the current period.')) return;
    try {
      await voidTransaction({
        txId: id,
        orgId: orgId!,
        legacyJournalId,
        date: format(new Date(), 'yyyy-MM-dd'),
        reason: reason | undefined,
        encryptText,
        decryptText,
        loadOrgSigningKey,
        signMutation,
      });
      await fetchData();
    } catch (err: any) {
      alert(`Void failed: ${err?.message ?? err}`);
    }
  };

  // ── Bulk actions ──
  // ── Bulk actions ────────────────────────────────────────────────────────
  //
  // T5 (Track 2): keep status, JE wrapper, and legacy ledger backend mirror in sync. Pre-T5
  // bulk actions flipped only `transactions.status`, leaving any linked JE
  // wrapper stale (a split that got bulk-posted left its journal_entries row
  // as DRAFT) and never wrote a reversing JE on void.
  //
  // After T5:
  //   - Bulk Post: flips tx.status → POSTED, and for txs with journal_entry_id
  //     flips journal_entries.status → POSTED too.
  //   - Bulk Void: routes through the existing voidTransaction helper so we
  //     get a real reversing JE + legacy ledger backend mirror, not just a status flip.
  //   - Bulk Delete: refuses unless every selected row is in DRAFT status.
  //     Posted/reconciled/voided rows must be voided, not deleted.

  const handleBulkPost = async () => {
    if (selected.size === 0) return;
    setBulkActing(true);
    try {
      const encStatus = await encryptText('POSTED');
      for (const id of selected) {
        const tx = txs.find((t) => t.id === id);
        await supabase
          .from('transactions')
          .update({ status: encStatus, key_version: 2 } as any)
          .eq('id', id);
        // Mirror to the parent JE wrapper for split + transfer transactions.
        if (tx?.journal_entry_id) {
          await supabase
            .from('journal_entries')
            .update({ status: encStatus, key_version: 2 } as any)
            .eq('id', tx.journal_entry_id);
        }
        writeAuditLog({
          orgId: orgId!,
          action: 'POST',
          entityType: 'transaction',
          entityId: id,
          summary: 'Bulk posted transaction',
          encrypt: encryptText,
        });
      }
      setSelected(new Set());
      await fetchData();
    } finally {
      setBulkActing(false);
    }
  };

  const handleBulkVoid = async () => {
    if (selected.size === 0) return;
    if (!confirm(`Void ${selected.size} selected transaction(s)? A reversing journal entry will be posted in the current period for each.`)) return;
    setBulkActing(true);
    const today = format(new Date(), 'yyyy-MM-dd');
    const failures: string[] = [];
    try {
      for (const id of selected) {
        const tx = txs.find((t) => t.id === id);
        if (!tx) continue;
        if (tx.cleared_status === 'RECONCILED') {
          failures.push(`${id.slice(0, 8)} is reconciled — undo reconciliation first`);
          continue;
        }
        if (!tx.journal_entry_id) {
          // Standard-mode txs don't have a JE wrapper today (Track 2 T1+T2
          // only wired split + transfer). Fall back to a plain status flip
          // so the user-facing toggle still works; voidTransaction handles
          // the proper reversing-JE path once T4 unification rewrites
          // standard-mode txs to write JE wrappers too.
          const encStatus = await encryptText('VOID');
          await supabase
            .from('transactions')
            .update({ status: encStatus, key_version: 2 } as any)
            .eq('id', id);
          continue;
        }
        try {
          await voidTransaction({
            txId: id,
            orgId: orgId!,
            legacyJournalId,
            date: today,
            reason: 'Bulk void',
            encryptText,
            decryptText,
            loadOrgSigningKey,
            signMutation,
          });
        } catch (err: any) {
          failures.push(`${id.slice(0, 8)}: ${err?.message ?? err}`);
        }
      }
      setSelected(new Set());
      await fetchData();
      if (failures.length > 0) {
        alert(`Some voids failed:\n${failures.join('\n')}`);
      }
    } finally {
      setBulkActing(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    // Guard: only DRAFT rows can be hard-deleted. Posted / Reconciled / Void
    // rows must be voided or the reconciliation undone first.
    const blockers = Array.from(selected)
      .map((id) => txs.find((t) => t.id === id))
      .filter((tx): tx is TxRow => !!tx && (tx.status === 'POSTED' | tx.status === 'VOID' | tx.cleared_status === 'RECONCILED'));
    if (blockers.length > 0) {
      alert(
        `${blockers.length} of the selected transactions cannot be deleted because they are posted, voided, or reconciled. ` +
          'Void them (or undo reconciliation) instead.',
      );
      return;
    }
    if (!confirm(`Delete ${selected.size} selected draft transaction(s)?`)) return;
    setBulkActing(true);
    try {
      for (const id of selected) {
        await supabase.from('transactions').delete().eq('id', id);
      }
      setSelected(new Set());
      await fetchData();
    } finally {
      setBulkActing(false);
    }
  };

  // ── Link transfer ──
  const handleLinkTransfer = async () => {
    if (selected.size !== 2) return;
    setLinkModalOpen(true);
  };

  const confirmLinkTransfer = async () => {
    const ids = Array.from(selected);
    if (ids.length !== 2) return;
    setLinkSubmitting(true);
    try {
      // Link each to the other via linked_transfer_id
      await supabase.from('transactions').update({ linked_transfer_id: ids[1] } as any).eq('id', ids[0]);
      await supabase.from('transactions').update({ linked_transfer_id: ids[0] } as any).eq('id', ids[1]);
      setLinkModalOpen(false);
      setSelected(new Set());
      await fetchData();
    } catch (err: any) {
      alert('Link failed: ' + err.message);
    } finally { setLinkSubmitting(false); }
  };

  // (Inline contact creation + modal-side exchange-rate hook lived here in
  // the old inline modal; both are now owned by TransactionModal.)

  if (loading | orgLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-primary" /></div>;
  }

  return (
    <div className="p-6 space-y-4" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {qbImportedJeCount > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-900">
          <div className="flex items-center gap-2 min-w-0">
            <BookOpen className="w-4 h-4 shrink-0 text-blue-600" />
            <span>
              <strong>{qbImportedJeCount}</strong> {qbImportedJeCount === 1 ? 'journal entry' : 'journal entries'} imported from QuickBooks live in the Journal Entries page — they don&apos;t appear in this Transactions list.
            </span>
          </div>
          <Link
            to="/app/journal"
            className="shrink-0 text-sm font-medium text-blue-700 hover:text-blue-900 underline-offset-2 hover:underline"
          >
            View in Journal Entries →
          </Link>
        </div>
      )}
      {/* Row 1 — title left, search + actions right */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <h1 className="text-2xl font-bold text-foreground">Transactions</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] max-w-[280px] flex-1">
            <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search transactions..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              className="pl-9 h-9"
            />
          </div>
          <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => void fetchData()} title="Refresh">
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-9" onClick={() => setImportOpen(true)}>
            <Upload className="w-4 h-4 mr-1" />Import
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9" type="button">
                <Download className="w-4 h-4 mr-1" />Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void exportTransactionsPdf()}>PDF</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void exportTransactionsCsv()}>CSV</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canWriteTxAny && (
            <Button
              size="sm"
              className="h-9 bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white"
              onClick={openAdd}
              data-testid="tx-new-button"
            >
              <Plus className="w-4 h-4 mr-1" />Add Transaction
            </Button>
          )}
        </div>
      </div>

      {/* Row 2 — DATE RANGE (year + from/to) + STATUS on the right */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-b border-border pb-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Date range</span>
            <Select
              value={String(displayYear)}
              disabled={datePreset === 'all_time'}
              onValueChange={(v) => {
                const y = Number(v);
                setDatePreset('custom');
                setCustomFrom(startOfYear(new Date(y, 0, 1)));
                setCustomTo(endOfYear(new Date(y, 0, 1)));
                setPage(0);
              }}
            >
              <SelectTrigger className="h-9 w-[100px] text-sm font-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearSelectOptions.map((y) => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input readOnly className="h-9 w-[132px] font-mono text-sm bg-muted/30" value={effectiveRangeLabels.from} />
            <span className="text-xs text-muted-foreground">to</span>
            <Input readOnly className="h-9 w-[132px] font-mono text-sm bg-muted/30" value={effectiveRangeLabels.to} />
          </div>
          {datePreset === 'custom' && (
            <div className="flex flex-wrap gap-2">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 text-xs">
                    <CalendarIcon className="w-3 h-3 mr-1" />
                    {customFrom ? format(customFrom, 'MM/dd/yyyy') : 'From'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={customFrom} onSelect={setCustomFrom} className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-9 text-xs">
                    <CalendarIcon className="w-3 h-3 mr-1" />
                    {customTo ? format(customTo, 'MM/dd/yyyy') : 'To'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={customTo} onSelect={setCustomTo} className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1 sm:items-end">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Status</span>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v as typeof statusFilter); setPage(0); }}>
            <SelectTrigger className="h-9 w-[180px] text-sm">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="draft">Draft</SelectItem>
              <SelectItem value="posted">Posted</SelectItem>
              <SelectItem value="not-cleared">Not Cleared</SelectItem>
              <SelectItem value="cleared">Cleared</SelectItem>
              <SelectItem value="reconciled">Reconciled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1 sm:items-end">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">More</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-9 text-sm"
            onClick={() => setFiltersDrawerOpen(true)}
            data-testid="tx-filters-drawer-trigger"
          >
            Filters{drawerFilterCount > 0 ? (
              <span className="ml-2 inline-flex items-center justify-center rounded-full bg-[var(--color-brand-orange)] px-2 py-0.5 text-[10px] font-semibold text-white">
                {drawerFilterCount}
              </span>
            ) : null}
          </Button>
        </div>
      </div>

      {/* Row 3 — quick presets (pill row) */}
      <div className="flex flex-wrap gap-1">
        {DATE_PRESETS.map((p) => (
          <Button
            key={p.value}
            type="button"
            size="sm"
            variant={datePreset === p.value ? 'default' : 'outline'}
            className={cn(
              'h-8 rounded-full px-3 text-xs',
              datePreset === p.value && 'bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white border-0'
            )}
            onClick={() => { setDatePreset(p.value); setPage(0); }}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {/* Pending-rates banner (BTC rows missing a pinned exchange rate) */}
      {pendingRateLineCount > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between dark:border-orange-900/40 dark:bg-orange-950/20">
          <p className="text-sm text-foreground">
            <strong>{pendingRateLineCount}</strong> Bitcoin transaction{pendingRateLineCount === 1 ? '' : 's'} may still need a pinned exchange rate for USD.
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={retryingRates}
            className="shrink-0 border-orange-300 bg-white hover:bg-orange-50 dark:bg-background disabled:opacity-60"
            onClick={() => void handleRetryRates()}
          >
            {retryingRates ? (
              <><RefreshCw className="mr-1.5 h-3 w-3 animate-spin" />Retrying…</>
            ) : (
              'Retry Pending Rates'
            )}
          </Button>
        </div>
      )}

      {/* Row 4 — status legend (red incomplete, green complete) */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground px-0.5">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-red-500" /> Incomplete
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-green-600" /> Complete
        </span>
        <span className="text-muted-foreground/80">— Not Cleared</span>
        <span className="text-green-600">✓ Cleared</span>
        <span className="font-semibold text-muted-foreground">▣ Reconciled</span>
      </div>

      {/* Table */}
      {sorted.length === 0 ? (
        <div className="bg-card border border-border rounded-lg p-12 text-center text-muted-foreground text-sm">
          {txs.length === 0
            ? 'No transactions yet — record one to get started.'
            : (
              <>
                <p>No transactions match these filters.</p>
                <p className="mt-1 text-xs">Widen the date range, clear the search, or reset the status filter.</p>
              </>
            )}
        </div>
      ) : (
        <>
          {/* Desktop / tablet: full table (>= md). The horizontal scroll
              keeps it usable on the narrowest desktop layouts but the card
              view below is the real mobile experience. */}
          <div className="bg-card border border-border rounded-lg overflow-x-auto hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox checked={selected.size === paged.length && paged.length > 0} onCheckedChange={toggleSelectAll} />
                  </TableHead>
                  <TableHead className="w-[80px]">Status</TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('date')}>
                    <span className="flex items-center">Date<SortIcon col="date" /></span>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('account_id')}>
                    <span className="flex items-center">Wallet<SortIcon col="account_id" /></span>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none text-right" onClick={() => toggleSort('amount')}>
                    <span className="flex items-center justify-end">Amount<SortIcon col="amount" /></span>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('asset')}>
                    <span className="flex items-center">Currency<SortIcon col="asset" /></span>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('to_from')}>
                    <span className="flex items-center">To/From<SortIcon col="to_from" /></span>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('ref_number')}>
                    <span className="flex items-center">Ref #<SortIcon col="ref_number" /></span>
                  </TableHead>
                  <TableHead className="cursor-pointer select-none" onClick={() => toggleSort('memo')}>
                    <span className="flex items-center">Memo<SortIcon col="memo" /></span>
                  </TableHead>
                  <TableHead className="w-[80px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.map(tx => {
                  const amt = Number(tx.amount);
                  const isIn = amt >= 0;
                  const cleared = tx.cleared_status | 'NOT_CLEARED';
                  const isPosted = tx.status === 'POSTED';
                  return (
                    <TableRow
                      key={tx.id}
                      className="cursor-pointer hover:bg-[#fafafa] dark:hover:bg-muted/40"
                      onClick={() => openEdit(tx)}
                    >
                      <TableCell onClick={e => e.stopPropagation()}>
                        <Checkbox checked={selected.has(tx.id)} onCheckedChange={() => toggleSelect(tx.id)} />
                      </TableCell>
                      <TableCell onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            className="h-4 w-4 shrink-0 rounded-full border-2 transition-colors"
                            style={{
                              background: isPosted ? '#16a34a' : '#ef4444',
                              borderColor: isPosted ? '#16a34a' : '#ef4444',
                            }}
                            onClick={() => togglePosted(tx.id)}
                            title={isPosted ? 'Posted' : 'Draft'}
                          />
                          <button
                            type="button"
                            className="transition-opacity hover:opacity-80"
                            onClick={() => cycleCleared(tx.id)}
                            title={cleared === 'RECONCILED' ? 'Reconciled — undo from statement' : cleared}
                          >
                            {cleared === 'RECONCILED' ? (
                              <Badge className="bg-green-100 text-green-800 hover:bg-green-100 gap-1 cursor-default">
                                <CheckCircle2 className="w-3 h-3" />
                                Reconciled
                              </Badge>
                            ) : cleared === 'CLEARED' ? (
                              <Badge variant="outline" className="border-blue-300 text-blue-700">Cleared</Badge>
                            ) : (
                              <Badge variant="outline" className="text-muted-foreground">Uncleared</Badge>
                            )}
                          </button>
                        </div>
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs">
                        {tx.date ? format(new Date(`${tx.date}T12:00:00`), 'MM-dd-yyyy') : '—'}
                      </TableCell>
                      <TableCell className="text-xs">{tx.account_id ? (walletMap[tx.account_id] | '[Encrypted]') : '—'}</TableCell>
                      <TableCell className="text-right font-mono">
                        <span className={isIn ? 'font-medium text-green-600' : 'text-foreground'}>
                          {isIn ? '+' : ''}{fmtAmount(amt, tx.asset)}
                        </span>
                        {tx.exchange_rate != null && (
                          <span className="block text-[10px] text-muted-foreground">
                            Pinned rate: {Number(tx.exchange_rate).toFixed(6)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Badge
                          className="text-[10px]"
                          style={{
                            background: tx.asset === 'BTC' ? 'var(--color-brand-orange-light)' : '#EFF6FF',
                            color: tx.asset === 'BTC' ? 'var(--color-brand-orange)' : '#2563EB',
                            border: 'none',
                          }}
                        >{tx.asset}</Badge>
                      </TableCell>
                      <TableCell className="text-xs">
                        {tx.type === 'Transfer' ? (
                          <><span>Transfer</span>{tx.linked_tx_id && <Badge variant="outline" className="ml-1 text-[9px]">Linked</Badge>}</>
                        ) : (tx.to_from | '—')}
                      </TableCell>
                      <TableCell className="text-xs font-mono">{tx.ref_number | '—'}</TableCell>
                      <TableCell className="text-xs text-muted-foreground max-w-[160px] truncate">{tx.memo ? (tx.memo.length > 40 ? tx.memo.slice(0, 40) + '...' : tx.memo) : '—'}</TableCell>
                      <TableCell onClick={e => e.stopPropagation()}>
                        <div className="flex gap-1">
                          {canWriteTxAny && (
                            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(tx)} data-testid="tx-edit-button"><Pencil className="w-3.5 h-3.5" /></Button>
                          )}
                          {tx.journal_entry_id ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-amber-600"
                              title="Void (post reversing entry)"
                              onClick={() => handleVoid(tx.id)}
                            >
                              <Ban className="w-3.5 h-3.5" />
                            </Button>
                          ) : canDeleteTx ? (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-destructive"
                              title="Delete"
                              onClick={() => handleDelete(tx.id)}
                              data-testid="tx-delete-button"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Mobile: card list (< md). One card per transaction, tap to edit. */}
          <div className="md:hidden space-y-2">
            {paged.map(tx => {
              const amt = Number(tx.amount);
              const isIn = amt >= 0;
              const cleared = tx.cleared_status | 'NOT_CLEARED';
              const isPosted = tx.status === 'POSTED';
              return (
                <div
                  key={tx.id}
                  className="bg-card border border-border rounded-lg p-3 cursor-pointer active:bg-muted/40"
                  onClick={() => openEdit(tx)}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      <div onClick={e => e.stopPropagation()} className="pt-0.5">
                        <Checkbox
                          checked={selected.has(tx.id)}
                          onCheckedChange={() => toggleSelect(tx.id)}
                          aria-label="Select transaction"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-xs">
                          <button
                            type="button"
                            className="h-3.5 w-3.5 shrink-0 rounded-full border-2 transition-colors"
                            style={{
                              background: isPosted ? '#16a34a' : '#ef4444',
                              borderColor: isPosted ? '#16a34a' : '#ef4444',
                            }}
                            onClick={e => { e.stopPropagation(); togglePosted(tx.id); }}
                            title={isPosted ? 'Posted' : 'Draft'}
                            aria-label={isPosted ? 'Mark draft' : 'Mark posted'}
                          />
                          <span className="font-mono text-muted-foreground">
                            {tx.date ? format(new Date(`${tx.date}T12:00:00`), 'MM-dd-yyyy') : '—'}
                          </span>
                          <span className="text-muted-foreground">·</span>
                          <span className="truncate">
                            {tx.account_id ? (walletMap[tx.account_id] | '[Encrypted]') : '—'}
                          </span>
                        </div>
                        {(tx.to_from | tx.type === 'Transfer') && (
                          <div className="mt-1 text-xs truncate">
                            {tx.type === 'Transfer' ? 'Transfer' : tx.to_from}
                            {tx.type === 'Transfer' && tx.linked_tx_id && (
                              <Badge variant="outline" className="ml-1 text-[9px]">Linked</Badge>
                            )}
                          </div>
                        )}
                        {tx.memo && (
                          <div className="mt-1 text-xs text-muted-foreground truncate">
                            {tx.memo.length > 60 ? tx.memo.slice(0, 60) + '…' : tx.memo}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className={cn('font-mono text-sm font-medium tabular-nums', isIn ? 'text-green-600' : 'text-foreground')}>
                        {isIn ? '+' : ''}{fmtAmount(amt, tx.asset)}
                      </div>
                      <div className="mt-1">
                        <Badge
                          className="text-[10px]"
                          style={{
                            background: tx.asset === 'BTC' ? 'var(--color-brand-orange-light)' : '#EFF6FF',
                            color: tx.asset === 'BTC' ? 'var(--color-brand-orange)' : '#2563EB',
                            border: 'none',
                          }}
                        >{tx.asset}</Badge>
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); cycleCleared(tx.id); }}
                      title={cleared === 'RECONCILED' ? 'Reconciled — undo from statement' : cleared}
                      className="-ml-0.5"
                    >
                      {cleared === 'RECONCILED' ? (
                        <Badge className="bg-green-100 text-green-800 hover:bg-green-100 gap-1 cursor-default text-[10px]">
                          <CheckCircle2 className="w-3 h-3" />
                          Reconciled
                        </Badge>
                      ) : cleared === 'CLEARED' ? (
                        <Badge variant="outline" className="border-blue-300 text-blue-700 text-[10px]">Cleared</Badge>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground text-[10px]">Uncleared</Badge>
                      )}
                    </button>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {tx.ref_number && <span className="font-mono">{tx.ref_number}</span>}
                      <div className="flex gap-0.5" onClick={e => e.stopPropagation()}>
                        {canWriteTxAny && (
                          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openEdit(tx)} data-testid="tx-edit-button">
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        {tx.journal_entry_id ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-amber-600"
                            title="Void (post reversing entry)"
                            onClick={() => handleVoid(tx.id)}
                          >
                            <Ban className="w-3.5 h-3.5" />
                          </Button>
                        ) : canDeleteTx ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive"
                            title="Delete"
                            onClick={() => handleDelete(tx.id)}
                            data-testid="tx-delete-button"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  {tx.exchange_rate != null && (
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      Pinned rate: {Number(tx.exchange_rate).toFixed(6)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pagination — rows-per-page selector + page-number buttons */}
          <div className="mt-4 flex flex-col gap-3 text-sm sm:flex-row sm:items-center sm:justify-between">
            <span className="text-muted-foreground">
              Showing {sorted.length === 0 ? 0 : startIdx}–{endIdx} of {sorted.length} transaction{sorted.length === 1 ? '' : 's'}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Rows per page:</span>
              <Select value={String(perPage)} onValueChange={(v) => { setPerPage(Number(v)); setPage(0); }}>
                <SelectTrigger className="h-8 w-[72px] text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{[10, 25, 50].map((n) => <SelectItem key={n} value={String(n)}>{n}</SelectItem>)}</SelectContent>
              </Select>
              <div className="mx-1 hidden h-4 w-px bg-border sm:block" />
              <Button variant="outline" size="sm" className="h-8 px-2" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Previous page">
                ‹
              </Button>
              {pageNumberButtons.map((pi) => (
                <Button
                  key={pi}
                  type="button"
                  size="sm"
                  variant={pi === page ? 'default' : 'outline'}
                  className={cn(
                    'h-8 min-w-8 px-2',
                    pi === page && 'bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white border-0'
                  )}
                  onClick={() => setPage(pi)}
                >
                  {pi + 1}
                </Button>
              ))}
              <Button variant="outline" size="sm" className="h-8 px-2" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)} aria-label="Next page">
                ›
              </Button>
            </div>
          </div>
        </>
      )}

      {/* Filters drawer — account multi-select + amount range */}
      <Sheet open={filtersDrawerOpen} onOpenChange={setFiltersDrawerOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle>More filters</SheetTitle>
            <SheetDescription>
              Narrow the list further. Closes when you tap outside; changes apply live.
            </SheetDescription>
          </SheetHeader>
          <div className="mt-6 space-y-6">
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Accounts</span>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  onClick={() => setWalletFilter(new Set())}
                  disabled={walletFilter.size === 0}
                >
                  Clear ({walletFilter.size})
                </button>
              </div>
              <div className="max-h-64 overflow-y-auto border border-border rounded-md divide-y" data-testid="tx-filter-wallet-list">
                {wallets.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-3 py-4 text-center">No accounts yet.</p>
                ) : wallets.map((w) => {
                  const checked = walletFilter.has(w.id);
                  const label = walletMap[w.id] | '[Encrypted]';
                  return (
                    <label key={w.id} className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted/40 cursor-pointer">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(c) => {
                          setWalletFilter((prev) => {
                            const next = new Set(prev);
                            if (c) next.add(w.id); else next.delete(w.id);
                            return next;
                          });
                          setPage(0);
                        }}
                      />
                      <span className="flex-1 truncate">{label}</span>
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{w.asset}</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium">Amount range (absolute)</span>
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  onClick={() => { setAmountMin(''); setAmountMax(''); }}
                  disabled={amountMin === '' && amountMax === ''}
                >
                  Clear
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Input
                  inputMode="decimal"
                  placeholder="Min"
                  value={amountMin}
                  onChange={(e) => { setAmountMin(e.target.value); setPage(0); }}
                  data-testid="tx-filter-amount-min"
                />
                <Input
                  inputMode="decimal"
                  placeholder="Max"
                  value={amountMax}
                  onChange={(e) => { setAmountMax(e.target.value); setPage(0); }}
                  data-testid="tx-filter-amount-max"
                />
              </div>
              <p className="text-[11px] text-muted-foreground mt-1">
                Filters by absolute value, so inflow and outflow of the same size both match.
              </p>
            </div>
          </div>
          <SheetFooter className="mt-6 flex-row justify-between gap-2 sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setWalletFilter(new Set());
                setAmountMin('');
                setAmountMax('');
                setPage(0);
              }}
              disabled={drawerFilterCount === 0}
            >
              Reset all
            </Button>
            <Button type="button" onClick={() => setFiltersDrawerOpen(false)}>Done</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      {/* Float bar — bulk actions */}
      {selected.size > 0 && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 bg-card border border-border rounded-lg px-6 py-3 flex items-center gap-3 z-50" style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.15)' }}>
          <Badge variant="secondary" className="text-sm font-medium">{selected.size} selected</Badge>
          <div className="w-px h-6 bg-border" />
          <Button variant="outline" size="sm" onClick={handleBulkPost} disabled={bulkActing}>
            <Check className="w-4 h-4 mr-1" />Post Selected
          </Button>
          <Button variant="outline" size="sm" onClick={handleBulkVoid} disabled={bulkActing}>
            <Ban className="w-4 h-4 mr-1" />Void Selected
          </Button>
          {canDeleteTx && (
            <Button variant="outline" size="sm" className="text-destructive" onClick={handleBulkDelete} disabled={bulkActing} data-testid="tx-bulk-delete">
              <Trash2 className="w-4 h-4 mr-1" />Delete Selected
            </Button>
          )}
          <div className="w-px h-6 bg-border" />
          <Button variant="outline" size="sm" disabled={selected.size !== 2 | bulkActing} onClick={handleLinkTransfer}>
            <Link2 className="w-4 h-4 mr-1" />Link as Transfer
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            <X className="w-3 h-3 mr-1" />Clear
          </Button>
        </div>
      )}

      {/* Link Transfer Confirmation Modal */}
      <Dialog open={linkModalOpen} onOpenChange={v => { if (!linkSubmitting) setLinkModalOpen(v); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Link Selected as Transfer</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground mb-4">
            Confirm that these two transactions represent the same wallet transfer. They will be linked to each other.
          </p>
          <div className="space-y-3">
            {Array.from(selected).map(id => {
              const tx = txs.find(t => t.id === id);
              if (!tx) return null;
              const amt = Number(tx.amount);
              const isIn = amt >= 0;
              return (
                <div key={id} className="border rounded-lg p-3 flex items-center justify-between">
                  <div>
                    <div className="text-xs text-muted-foreground">{tx.date}</div>
                    <div className="text-sm font-medium">{tx.account_id ? (walletMap[tx.account_id] | '[Encrypted]') : 'No wallet'}</div>
                    <Badge variant="outline" className="text-[10px] mt-1">{isIn ? 'Inflow' : 'Outflow'}</Badge>
                  </div>
                  <div className={cn('font-mono text-sm', isIn ? 'text-green-600' : 'text-red-600')}>
                    {isIn ? '+' : ''}{fmtAmount(amt, tx.asset)}
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter className="mt-4">
            <Button variant="outline" onClick={() => setLinkModalOpen(false)} disabled={linkSubmitting}>Cancel</Button>
            <Button onClick={confirmLinkTransfer} disabled={linkSubmitting}>
              {linkSubmitting ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" />Linking...</> : 'Confirm Link'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Transaction modal (Standard / Split / Transfer).
          Reconciliation edit-lock is handled by openEdit() above; this modal
          never opens for tx.cleared_status === 'RECONCILED'. */}
      {orgId && (
        <TransactionModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onSaved={() => { void fetchData(); }}
          editingTx={editingTx
            ? {
                id: editingTx.id,
                account_id: editingTx.account_id,
                type: editingTx.type,
                asset: editingTx.asset,
                amount: Number(editingTx.amount),
                usd_value: editingTx.usd_value,
                exchange_rate: editingTx.exchange_rate,
                date: editingTx.date,
                memo: editingTx.memo,
                status: editingTx.status,
                cleared_status: editingTx.cleared_status,
                linked_transfer_id: editingTx.linked_transfer_id ?? null,
                account_id: editingTx.account_id ?? null,
                contact_id: editingTx.contact_id ?? null,
              }
            : null}
          orgId={orgId}
          legacyJournalId={legacyJournalId}
          wallets={wallets.map(w => ({
            id: w.id,
            encrypted_name: w.encrypted_name | '[Encrypted]',
            asset: w.asset,
            external_account_id: w.external_account_id ?? null,
          }))}
          accounts={accountOptions}
          contacts={contacts as TxContactOption[]}
          onContactsChanged={() => { void fetchData(); }}
        />
      )}

      {/* CSV Import */}
      <ImportPopup
        open={importOpen}
        onClose={() => { setImportOpen(false); fetchData(); }}
        entityName="Transactions"
        sampleCsvContent={TRANSACTION_SAMPLE_CSV}
        sampleFileName="transactions-sample.csv"
        columns={TRANSACTION_COLUMNS}
        tips={[
          'All columns are required. Download the sample to see the format.',
          'Wallet, Account, and Contact must match names already in Orange Way Books.',
          'Direction: use INFLOW (money in) or OUTFLOW (money out).',
          'See your account names in Admin > Chart of Accounts.',
          'Add contacts first in Admin > To/From List if they don\'t exist yet.',
          'Bitcoin wallet transactions require exchange rate data for the date.',
        ]}
        parseCsv={(csvText: string) => {
          const result = parseCsvTransactions(csvText);
          // Preview-stage validation: check wallet/account/contact names
          const walletNames = new Set(wallets.map(w => w.encrypted_name?.toLowerCase()));
          const rows = result.rows.map(row => {
            if (row.error) return row; // already has parse error
            if (!walletNames.has(row.data.wallet.toLowerCase())) {
              return { ...row, error: `Wallet "${row.data.wallet}" not found. Check your wallet names.` };
            }
            if (!row.data.account) {
              return { ...row, error: 'Account is required. See Admin > Chart of Accounts.' };
            }
            if (!row.data.contact) {
              return { ...row, error: 'Contact is required. See Admin > To/From List.' };
            }
            return row;
          });
          return { rows, errors: result.errors };
        }}
        onImportRows={async (rows: ImportPreviewRow[]): Promise<ImportResult> => {
          if (!orgId) return { created: 0, skipped: 0, failed: rows.length, errors: ['No organization found'] };

          // Fetch lookups: wallets, accounts, contacts
          const [wRes, aRes, cRes] = await Promise.all([
            supabase.from('accounts').select('*').eq('org_id', orgId),
            supabase.from('chart_of_accounts' as any).select('*').eq('org_id', orgId),
            supabase.from('contacts').select('*').eq('org_id', orgId),
          ]);
          const walletList = (wRes.data as any[]) | [];
          const accountList = (aRes.data as any[]) | [];
          const contactList = (cRes.data as any[]) | [];

          // Decrypt wallet names so CSV wallet-name matching works
          const decryptedWalletList = await Promise.all(
            walletList.map(async (w: any) => {
              const fields = await decryptWallet(w, decryptText);
              return { ...w, ...fields, decrypted_name: fields.encrypted_name };
            })
          );

          // Decrypt account names so CSV account matching works
          const decryptedAccountList = await Promise.all(
            accountList.map(async (a: any) => {
              const fields = await decryptChartOfAccount(a, decryptText);
              return { ...a, decrypted_name: fields.account_name, decrypted_code: fields.account_code };
            })
          );

          // Decrypt contact names so CSV contact matching works
          const decryptedContactList = await Promise.all(
            contactList.map(async (c: any) => {
              const name = c.key_version ? await decryptText(c.name) : c.name;
              return { ...c, decrypted_name: name };
            })
          );

          const { data: orgRow } = await supabase.from('organizations').select('external_journal_id').eq('id', orgId).single();
          const legacyJournalId = (orgRow as any)?.external_journal_id | null;

          let created = 0, skipped = 0, failed = 0;
          const errors: string[] = [];
          const warnings: string[] = [];

          for (const row of rows) {
            // Session-persistent duplicate detection
            const dupeKey = `${row.data.date}|${row.data.wallet.toLowerCase()}|${row.data.direction}|${row.data.amount}`;
            if (importedTxKeysRef.current.has(dupeKey)) {
              skipped++;
              warnings.push(`Row ${row.rowIndex + 1}: already imported (${row.data.date}, ${row.data.wallet}, $${row.data.amount})`);
              continue;
            }

            // Resolve wallet (using decrypted names)
            const wallet = decryptedWalletList.find((w: any) =>
              w.decrypted_name?.toLowerCase() === row.data.wallet.toLowerCase()
            );
            if (!wallet) {
              failed++;
              errors.push(`Row ${row.rowIndex + 1}: Account "${row.data.wallet}" not found. Go to Accounts to see your wallet names.`);
              continue;
            }

            // Resolve account (using decrypted names)
            const account = decryptedAccountList.find((a: any) =>
              a.decrypted_name?.toLowerCase() === row.data.account.toLowerCase() ||
              a.decrypted_code?.toLowerCase() === row.data.account.toLowerCase()
            );
            if (!account) {
              failed++;
              errors.push(`Row ${row.rowIndex + 1}: Account "${row.data.account}" not found. Go to Admin > Chart of Accounts to see available account names.`);
              continue;
            }

            // Resolve contact (using decrypted names)
            const contact = decryptedContactList.find((c: any) =>
              c.decrypted_name?.toLowerCase() === row.data.contact.toLowerCase()
            );
            if (!contact) {
              failed++;
              errors.push(`Row ${row.rowIndex + 1}: Contact "${row.data.contact}" not found. Go to Admin > To/From List to add this contact first.`);
              continue;
            }

            // Phase 2 (legacy-ledger removal): Postgres transactions insert is the
            // single source of truth for CSV imports.
            const encFields = await encryptTransaction({
              memo: row.data.memo | null,
              amount: row.data.direction === 'INFLOW' ? Math.abs(Number(row.data.amount)) : -Math.abs(Number(row.data.amount)),
              usd_value: null,
              exchange_rate: null,
              asset: wallet.asset,
              type: row.data.direction === 'INFLOW' ? 'Receive' : 'Send',
              // T4.a Option A: CSV-imported transactions land as DRAFT.
              status: 'DRAFT',
              cleared_status: null,
            }, encryptText);
            await supabase.from('transactions').insert({
              org_id: orgId,
              account_id: wallet.id,
              date: row.data.date,
              ...encFields,
            });

            created++;
            importedTxKeysRef.current.add(dupeKey);
          }
          return { created, skipped, failed, errors, warnings };
        }}
      />

      <Dialog open={lockedDialogOpen} onOpenChange={setLockedDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Transaction is reconciled</DialogTitle>
          </DialogHeader>
          <div className="text-sm text-muted-foreground">
            This transaction is reconciled. Editing it will break reconciliation and may put your books out of balance. To make changes, undo reconciliation from the wallet statement first.
          </div>
          <DialogFooter>
            <Button onClick={() => setLockedDialogOpen(false)}>Got it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
