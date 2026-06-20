import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import {
  Plus,
  Search,
  RefreshCw,
  Upload,
  Download,
  Loader2,
  ChevronRight,
  ChevronDown,
  Pencil,
  Trash2,
  Undo2,
  CalendarIcon,
  X,
  AlertTriangle,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import {
  format,
  startOfYear,
  endOfYear,
  startOfMonth,
  startOfWeek,
  subMonths,
  subYears,
} from 'date-fns';
import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useCapability } from '@/hooks/useCapability';
import { mintInternalJeRefNumber } from '@/lib/journal-entry-ref-numbers';
import { formatCrypto, formatFiat } from '@/lib/formatters';
import { useVault } from '@/context/VaultContext';
import {
  encryptJournalEntry,
  decryptJournalEntry,
  encryptJournalEntryLine,
  decryptJournalEntryLine,
  decryptChartOfAccount,
  decryptOrganization,
  decryptOrgSettings,
} from '@/lib/crypto-fields';
import { reverseJournalEntry } from '@/lib/transactions/reverse-journal-entry';
import { writeAuditLog } from '@/lib/audit-logger';
import { Checkbox } from '@/components/ui/checkbox';
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import type { BitcoinDisplay } from '@/types';
import { ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react';
import { exportToCsv } from '@/lib/exports/csv';
import { printTable } from '@/lib/exports/print-table';
import { csvExportCurrencyLabel } from '@/lib/exports/csv-currency-label';
import { transactionAmountNumericForCsv } from '@/lib/exports/csv-transaction-amount';
import { toast } from 'sonner';
import {
  ImportPopup,
  type ImportPreviewRow,
  type ImportResult,
} from '@/components/ui/import-popup';
import {
  JOURNAL_CSV_HEADERS,
  JOURNAL_SAMPLE_CSV,
  parseCsvJournalEntries,
  groupJournalImportRows,
  journalGroupKey,
  parseJournalCurrencyLabel,
  parseJournalAmountCell,
} from '@/lib/csv/journal-entries';
import { buildJournalEntryLineInsert } from '@/lib/exchange/build-je-line-insert';
import { commitJournalEntriesFromStaged } from '@/lib/import-from-orange-rails/handlers';
import { useExchangeRate } from '@/lib/exchange';
import { ManualRateDialog } from '@/components/exchange/ManualRateDialog';
import { AttachmentList } from '@/components/attachments/AttachmentList';
import type { ManualRate } from '@/lib/exchange/build-je-line-insert';

type DatePreset =
  | 'today'
  | 'this_week'
  | 'this_month'
  | 'ytd'
  | 'this_year'
  | 'last_month'
  | 'last_year'
  | 'all_time'
  | 'custom';
// Status vocabulary (T4.a Option A locked 2026-05-12):
// journal_entries.status ∈ {DRAFT, POSTED, VOID, HIDDEN}. APPROVED was a
// A prior label that meant "posted" — collapsed into POSTED. REVERSED was
// A prior label for void-via-reversing-entry — collapsed into VOID; the
// reversal_of_id FK distinguishes a void reversal JE from any other.
type JEStatusFilter = 'all' | 'DRAFT' | 'POSTED' | 'VOID';

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

function getDateRange(preset: DatePreset): { from: Date | undefined; to: Date | undefined } {
  const now = new Date();
  switch (preset) {
    case 'today':
      return { from: now, to: now };
    case 'this_week':
      return { from: startOfWeek(now), to: now };
    case 'this_month':
      return { from: startOfMonth(now), to: now };
    case 'ytd':
      return { from: startOfYear(now), to: now };
    case 'this_year':
      return { from: startOfYear(now), to: endOfYear(now) };
    case 'last_month':
      return { from: startOfMonth(subMonths(now, 1)), to: subMonths(startOfMonth(now), 0) };
    case 'last_year':
      return { from: startOfYear(subYears(now, 1)), to: startOfYear(now) };
    case 'all_time':
      return { from: undefined, to: undefined };
    default:
      return { from: undefined, to: undefined };
  }
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

interface JournalEntry {
  id: string;
  date: string;
  ref_number: string | null;
  memo: string | null;
  currency: string;
  status: string;
  source_type: string | null;
  exchange_rate: number | null;
  period_locked: boolean;
  created_at: string | null;
}

interface JournalLine {
  id: string;
  journal_entry_id: string;
  account_id: string | null;
  account_code: string | null;
  account_name: string | null;
  debit: number;
  credit: number;
  description: string | null;
  book_value: number | null;
}

interface Account {
  id: string;
  account_name: string;
  account_code: string | null;
  account_type: string;
}

interface PairingWarning {
  code: string;
  message: string;
}

interface FormLine {
  account_code: string;
  account_name: string;
  debit: string;
  credit: string;
  description: string;
}

// ── Pairing inspector ─────────────────────────────────────────────────────
//
// Looks at the lines the user is about to post and flags four common
// confused-entry patterns. None of these are hard errors (the JE can
// still post); they're nudges in the form. The order of the checks
// below is the order the warnings appear in the UI.

/** Canonical account-type vocabulary the inspector cares about. INCOME
 *  is the canonical form; REVENUE is folded into it because OWB's older
 *  templates use that label. */
type CanonicalAcctType = 'ASSET' | 'LIABILITY' | 'EQUITY' | 'INCOME' | 'EXPENSE';

function toCanonicalType(raw: string | null | undefined): CanonicalAcctType | null {
  if (
    (raw === 'ASSET') |
    (raw === 'LIABILITY') |
    (raw === 'EQUITY') |
    (raw === 'INCOME') |
    (raw === 'EXPENSE')
  ) {
    return raw;
  }
  if (raw === 'REVENUE') return 'INCOME';
  return null;
}

/** Each working row carries the original FormLine fields plus the
 *  resolved account id and canonical type so the warning checks below
 *  read cleanly. Built once and consumed by every check. */
interface InspectedLine extends FormLine {
  accountType: CanonicalAcctType | null;
  accountId: string;
  debitNum: number;
  creditNum: number;
}

function annotateLines(
  formLines: FormLine[],
  accountsByName: Map<string, Account>,
): InspectedLine[] {
  const out: InspectedLine[] = [];
  for (const line of formLines) {
    if (!line.account_name) continue;
    if (!line.debit && !line.credit) continue;
    const acct = accountsByName.get(line.account_name.toLowerCase());
    out.push({
      ...line,
      accountType: toCanonicalType(acct?.account_type),
      accountId: acct?.id ?? line.account_name,
      debitNum: parseFloat(line.debit) | 0,
      creditNum: parseFloat(line.credit) | 0,
    });
  }
  return out;
}

function findPairingWarnings(
  formLines: FormLine[],
  accountsByName: Map<string, Account>,
): PairingWarning[] {
  const warnings: PairingWarning[] = [];
  const lines = annotateLines(formLines, accountsByName);
  if (lines.length === 0) return warnings;

  const dr = lines.filter((l) => l.debitNum > 0);
  const cr = lines.filter((l) => l.creditNum > 0);

  // 1. Same account showing on both sides — usually a typo, but the user
  //    might mean it (e.g. clearing an internal sub-account). Surface it.
  const drAccountIds = new Set(dr.map((l) => l.accountId));
  const collisions = cr.filter((l) => drAccountIds.has(l.accountId));
  if (collisions.length > 0) {
    const names = collisions.map((l) => l.account_name).join(', ');
    warnings.push({
      code: 'same-account-both-sides',
      message: `Same account on both debit & credit sides (${names}). Confirm this is intentional.`,
    });
  }

  // The next three checks need the set of types in play.
  const typesInPlay = new Set<CanonicalAcctType>();
  for (const l of lines) {
    if (l.accountType) typesInPlay.add(l.accountType);
  }

  // 2. Only P&L accounts — most real entries also touch a balance-sheet
  //    leg (cash, payables, equity). All-INCOME/EXPENSE is a smell.
  if (typesInPlay.size > 0) {
    let onlyPL = true;
    for (const t of typesInPlay) {
      if (t !== 'INCOME' && t !== 'EXPENSE') {
        onlyPL = false;
        break;
      }
    }
    if (onlyPL) {
      warnings.push({
        code: 'profit-and-loss-only',
        message:
          'Only income/expense accounts used. Most entries also touch a balance-sheet account (cash, payables, equity).',
      });
    }
  }

  // 3. Equity moving directly against P&L. Almost always wrong — equity
  //    moves through retained earnings, not directly through income.
  if (typesInPlay.has('EQUITY') && typesInPlay.has('INCOME') | typesInPlay.has('EXPENSE')) {
    warnings.push({
      code: 'equity-with-profit-and-loss',
      message: 'Equity posted directly against income/expense. Unusual — worth a second look.',
    });
  }

  // 4. Income posted against expense — should usually flow via a cash /
  //    payables / receivables leg.
  const drTypes = new Set(
    dr.map((l) => l.accountType).filter((t): t is CanonicalAcctType => t !== null),
  );
  const crTypes = new Set(
    cr.map((l) => l.accountType).filter((t): t is CanonicalAcctType => t !== null),
  );
  const incomeVsExpense =
    (drTypes.has('EXPENSE') && crTypes.has('INCOME')) ||
    (drTypes.has('INCOME') && crTypes.has('EXPENSE'));
  if (incomeVsExpense) {
    warnings.push({
      code: 'income-expense-direct-pairing',
      message:
        'Income and expense posted against each other. Should this flow through cash/payables/receivables instead?',
    });
  }

  return warnings;
}

// ── Lock-date helper ──────────────────────────────────────────────────────

/** True when the entry's date falls within a period the org has marked
 *  closed (the lock-date floor). Empty `lockDate` means no period close
 *  is configured; nothing is locked. */
function entryFallsInLockedPeriod(entryDate: string, lockDate: string | null): boolean {
  if (!lockDate) return false;
  return entryDate <= lockDate;
}

type SortKey = 'date' | 'memo' | 'amount';
type SortDir = 'asc' | 'desc';

function cellDebitCredit(
  raw: number | null | undefined,
  currency: string,
  btcDisplay: BitcoinDisplay,
  formatAmountValue: (amount: number, currency: string) => string,
  spreadsheetNumeric: boolean,
): string | number {
  if (raw == null || raw === 0) return '';
  return spreadsheetNumeric
    ? transactionAmountNumericForCsv(raw, currency, btcDisplay)
    : formatAmountValue(raw, currency);
}

function buildJournalExportRows(
  entryList: JournalEntry[],
  linesMap: Record<string, JournalLine[]>,
  formatAmountValue: (amount: number, currency: string) => string,
  btcDisplay: BitcoinDisplay,
  spreadsheetNumeric: boolean,
): (string | number | null)[][] {
  const rows: (string | number | null)[][] = [];
  for (const e of entryList) {
    const elines = linesMap[e.id] ?? [];
    const currencyLabel = csvExportCurrencyLabel(e.currency, btcDisplay);
    if (elines.length === 0) {
      rows.push([
        e.date,
        e.ref_number ?? '',
        e.memo ?? '',
        e.status,
        '',
        '',
        '',
        currencyLabel,
        '',
        '',
      ]);
      continue;
    }
    for (const line of elines) {
      rows.push([
        e.date,
        e.ref_number ?? '',
        e.memo ?? '',
        e.status,
        line.account_code ?? '',
        line.account_name ?? '',
        line.description ?? '',
        currencyLabel,
        cellDebitCredit(line.debit, e.currency, btcDisplay, formatAmountValue, spreadsheetNumeric),
        cellDebitCredit(line.credit, e.currency, btcDisplay, formatAmountValue, spreadsheetNumeric),
      ]);
    }
  }
  return rows;
}

// ── Account autocomplete combobox ──────────────────────────────────────────

interface AccountOption {
  id: string;
  account_name: string;
  account_code: string | null;
  account_type: string;
}

function AccountCombobox({
  value,
  accounts,
  onChange,
}: {
  value: string;
  accounts: AccountOption[];
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');

  const filtered = React.useMemo(() => {
    const q = search.toLowerCase();
    return accounts
      .filter(
        (a) =>
          a.account_name.toLowerCase().includes(q) ||
          (a.account_code ?? '').toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [accounts, search]);

  return (
    <div className="relative">
      <input
        className="h-8 text-xs border rounded px-2 w-full bg-background"
        placeholder="Account name"
        value={open ? search : value}
        onFocus={() => {
          setOpen(true);
          setSearch(value);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setSearch(e.target.value);
          onChange(e.target.value);
        }}
      />
      {open && filtered.length > 0 && (
        <div className="absolute z-50 w-full mt-0.5 bg-background border rounded shadow-lg max-h-48 overflow-y-auto text-xs">
          {filtered.map((a) => (
            <div
              key={a.id}
              className="px-2 py-1.5 cursor-pointer hover:bg-muted flex items-center justify-between"
              onMouseDown={() => {
                onChange(a.account_name);
                setSearch(a.account_name);
                setOpen(false);
              }}
            >
              <span className="font-medium">{a.account_name}</span>
              <span className="text-muted-foreground ml-2">{a.account_type}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function JournalEntries() {
  const { orgId, loading: orgLoading } = useUserOrg();
  const { encryptText, decryptText } = useVault();
  // Capability gates — UI presence only; RLS still authoritative.
  const canWriteJE = useCapability('journal_entries.write', orgId);
  const canDeleteJE = useCapability('journal_entries.delete', orgId);
  const [orgName, setOrgName] = useState('');
  const [entries, setEntries] = useState<JournalEntry[]>([]);
  // Bulk-action state (Track 7).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);
  const [lines, setLines] = useState<Record<string, JournalLine[]>>({});
  const [loading, setLoading] = useState(true);
  const [btcDisplay, setBtcDisplay] = useState<BitcoinDisplay>('sats');
  const [primaryCurrency, setPrimaryCurrency] = useState('USD');

  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [datePreset, setDatePreset] = useState<DatePreset>('ytd');
  const [customFrom, setCustomFrom] = useState<Date | undefined>(undefined);
  const [customTo, setCustomTo] = useState<Date | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<JEStatusFilter>('all');

  // modal
  const [modalOpen, setModalOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<JournalEntry | null>(null);
  const [saving, setSaving] = useState(false);

  // form
  const [fDate, setFDate] = useState<Date>(new Date());
  const [fCurrency, setFCurrency] = useState('USD');
  const [fRefNum, setFRefNum] = useState('');
  const [fMemo, setFMemo] = useState('');
  const [fLines, setFLines] = useState<FormLine[]>([
    { account_code: '', account_name: '', debit: '', credit: '', description: '' },
    { account_code: '', account_name: '', debit: '', credit: '', description: '' },
  ]);

  // Simple mode toggle (plus/minus vs debit/credit)
  const [simpleMode, setSimpleMode] = useState(false);

  // Lock date from org_settings
  const [lockDate, setLockDate] = useState<string | null>(null);

  // Manual rate dialog — shown when a JE line posts with rate_pending=true
  const [manualRateOpen, setManualRateOpen] = useState(false);
  const [manualRatePair, setManualRatePair] = useState<{
    walletCurrency: string;
    primaryCurrency: string;
    date: string;
  } | null>(null);
  const manualRateResolveRef = useRef<((rate: ManualRate) => void) | null>(null);

  // Builds a single JE line insert, prompting for a manual rate if pending.
  const buildLineInsert = useCallback(
    async (params: {
      wallet_currency: string;
      primary_currency: string;
      date: string;
      debit: number;
      credit: number;
      account_name?: string | null;
      account_code?: string | null;
      description?: string | null;
    }) => {
      const result = await buildJournalEntryLineInsert({ ...params, encrypt: encryptText });
      if (result.pending) {
        toast.warning(
          `Rate for ${params.wallet_currency}→${params.primary_currency} not available. Line saved as pending — resolve from the Pending Rates banner.`,
        );
      }
      return result.insert;
    },
    [encryptText],
  );

  // Accounts list for pairing warnings & simple mode type inference
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const accountsByName = useMemo(() => {
    const map = new Map<string, Account>();
    accounts.forEach((a) => map.set(a.account_name.toLowerCase(), a));
    return map;
  }, [accounts]);

  const fetchData = async () => {
    if (!orgId) return;
    const [jeRes, sRes, acctRes, orgRes] = await Promise.all([
      supabase
        .from('journal_entries')
        .select('*')
        .eq('org_id', orgId)
        .order('date', { ascending: false }),
      supabase.from('org_settings').select('*').eq('org_id', orgId).maybeSingle(),
      supabase.from('chart_of_accounts').select('*').eq('org_id', orgId).eq('is_archived', false),
      supabase.from('organizations').select('name, key_version').eq('id', orgId).maybeSingle(),
    ]);
    if (orgRes.data) {
      const decOrg = await decryptOrganization(orgRes.data as any, decryptText);
      setOrgName((decOrg.name ?? '').trim());
    }
    const je = (jeRes.data as any[]) ?? [];
    const decryptedJe = await Promise.all(
      je.map(async (e: any) => {
        const fields = await decryptJournalEntry(e, decryptText);
        return { ...e, ...fields };
      }),
    );
    setEntries(decryptedJe);

    if (je.length > 0) {
      const ids = je.map((e) => e.id);
      const { data: lineData } = await supabase
        .from('journal_entry_lines')
        .select('*')
        .in('journal_entry_id', ids);
      const grouped: Record<string, JournalLine[]> = {};
      ((lineData as any[]) ?? []).forEach((l) => {
        if (!grouped[l.journal_entry_id]) grouped[l.journal_entry_id] = [];
        grouped[l.journal_entry_id].push(l);
      });
      for (const key of Object.keys(grouped)) {
        grouped[key] = await Promise.all(
          grouped[key].map(async (l: any) => {
            const fields = await decryptJournalEntryLine(l, decryptText);
            return { ...l, ...fields };
          }),
        );
      }
      setLines(grouped);
    }

    if (acctRes.data) {
      const decryptedAccts = await Promise.all(
        (acctRes.data as any[]).map(async (a) => {
          const fields = await decryptChartOfAccount(a, decryptText);
          return {
            id: a.id,
            account_name: fields.account_name,
            account_code: fields.account_code,
            account_type: fields.account_type,
          };
        }),
      );
      setAccounts(decryptedAccts);
    }

    if (sRes.data) {
      const decSettings = await decryptOrgSettings(sRes.data as any, decryptText);
      if (decSettings.bitcoin_display) setBtcDisplay(decSettings.bitcoin_display as BitcoinDisplay);
      if (decSettings.primary_currency)
        setPrimaryCurrency(decSettings.primary_currency.toUpperCase());
      setLockDate((sRes.data as any).journal_lock_date ?? null);
    }
    setLoading(false);
  };

  useEffect(() => {
    if (orgId) fetchData();
    else if (!orgLoading) setLoading(false);
  }, [orgId, orgLoading]);

  const entryTotals = useMemo(() => {
    const totals: Record<string, number> = {};
    entries.forEach((e) => {
      const elines = lines[e.id] | [];
      totals[e.id] = elines.reduce((s, l) => s + (Number(l.debit) | 0), 0);
    });
    return totals;
  }, [entries, lines]);

  const dateRange = useMemo(() => {
    if (datePreset === 'custom') return { from: customFrom, to: customTo };
    return getDateRange(datePreset);
  }, [datePreset, customFrom, customTo]);

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

  const filtered = useMemo(() => {
    let list = entries;
    // Date range — entries have a plaintext `date` field (yyyy-MM-dd)
    list = list.filter((e) => {
      if (!e.date) return true;
      const d = new Date(e.date.includes('T') ? e.date : `${e.date}T12:00:00`);
      if (dateRange.from && d < dateRange.from) return false;
      if (dateRange.to) {
        const to = new Date(dateRange.to);
        to.setHours(23, 59, 59);
        if (d > to) return false;
      }
      return true;
    });
    if (statusFilter !== 'all') {
      list = list.filter((e) => e.status === statusFilter);
    }
    if (search) {
      const term = search.toLowerCase();
      list = list.filter(
        (e) =>
          (e.memo | '').toLowerCase().includes(term) ||
          (e.ref_number | '').toLowerCase().includes(term) ||
          e.currency.toLowerCase().includes(term),
      );
    }
    return list;
  }, [entries, search, dateRange, statusFilter]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      let av: any, bv: any;
      if (sortKey === 'date') {
        av = new Date(a.date).getTime();
        bv = new Date(b.date).getTime();
      } else if (sortKey === 'memo') {
        av = (a.memo | '').toLowerCase();
        bv = (b.memo | '').toLowerCase();
      } else {
        av = entryTotals[a.id] | 0;
        bv = entryTotals[b.id] | 0;
      }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
    return copy;
  }, [filtered, sortKey, sortDir, entryTotals]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
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

  const toggleExpand = (id: string) => {
    setExpandedIds((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const fmtAmount = useCallback(
    (amount: number, currency: string) => {
      if ((currency === 'BTC') | (currency === 'SATS'))
        return formatCrypto(currency === 'SATS' ? amount / 1e8 : amount, btcDisplay);
      return formatFiat(amount, ['USD', 'EUR', 'GBP'].includes(currency) ? currency : 'USD');
    },
    [btcDisplay],
  );

  const exportJournalCsv = useCallback(() => {
    if (sorted.length === 0) {
      toast.error('Nothing to export.');
      return;
    }
    const rows = buildJournalExportRows(sorted, lines, fmtAmount, btcDisplay, true);
    exportToCsv(
      `owb-journal-entries-${format(new Date(), 'yyyy-MM-dd')}`,
      [...(JOURNAL_CSV_HEADERS as readonly string[])],
      rows,
    );
    toast.success(
      `Exported ${sorted.length} journal entr${sorted.length === 1 ? 'y' : 'ies'} to CSV (${rows.length} rows).`,
    );
  }, [sorted, lines, fmtAmount, btcDisplay]);

  const exportJournalPdf = useCallback(() => {
    if (sorted.length === 0) {
      toast.error('Nothing to export.');
      return;
    }
    const rows = buildJournalExportRows(sorted, lines, fmtAmount, btcDisplay, false);
    const title = `${orgName || 'Organization'} — Journal entries — ${format(new Date(), 'yyyy-MM-dd')}`;
    void printTable(title, [...(JOURNAL_CSV_HEADERS as readonly string[])], rows)
      .then((opened) => {
        if (opened) {
          toast.success('Use Print → Save as PDF in the preview window.');
        }
      })
      .catch(() => {
        toast.error('Could not open the print preview. Check popups and try again.');
      });
  }, [sorted, lines, orgName, fmtAmount, btcDisplay]);

  const statusBadge = (status: string) => {
    // T4.a Option A unified vocab. APPROVED / REVERSED kept as legacy aliases
    // so old encrypted rows render correctly until they're touched by a write.
    const styles: Record<string, { bg: string; color: string }> = {
      DRAFT: { bg: '#DBEAFE', color: '#2563EB' },
      POSTED: { bg: '#DCFCE7', color: '#16a34a' },
      VOID: { bg: '#F3F4F6', color: '#6B7280' },
      HIDDEN: { bg: '#F3F4F6', color: '#6B7280' },
      APPROVED: { bg: '#DCFCE7', color: '#16a34a' }, // legacy → renders like POSTED
      REVERSED: { bg: '#F3F4F6', color: '#6B7280' }, // legacy → renders like VOID
    };
    const s = styles[status] | styles.DRAFT;
    return (
      <Badge className="text-[10px]" style={{ background: s.bg, color: s.color, border: 'none' }}>
        {status}
      </Badge>
    );
  };

  // P11: mints JE-YYYY-NNNN via the next_je_ref_number SECURITY DEFINER RPC.
  // Replaces the old client-side regex that tried to parse ref_number, which
  // breaks at ZKA L2 because ref_number now holds AES-GCM ciphertext rather
  // than the human-readable JE-NNN string.
  const generateRefNum = useCallback(async (): Promise<string> => {
    if (!orgId) return 'JE-0001';
    try {
      return await mintInternalJeRefNumber(supabase, orgId, new Date().getUTCFullYear());
    } catch (err) {
      console.error('mintInternalJeRefNumber failed; falling back to JE-0001', err);
      return 'JE-0001';
    }
  }, [orgId]);

  const openAdd = async () => {
    setEditingEntry(null);
    setFDate(new Date());
    setFCurrency('USD');
    setFRefNum(await generateRefNum());
    setFMemo('');
    setFLines([
      { account_code: '', account_name: '', debit: '', credit: '', description: '' },
      { account_code: '', account_name: '', debit: '', credit: '', description: '' },
    ]);
    setModalOpen(true);
  };

  const openEdit = (entry: JournalEntry) => {
    if ((entry.status !== 'DRAFT') | entry.period_locked) return;
    setEditingEntry(entry);
    setFDate(new Date(entry.date));
    setFCurrency(entry.currency);
    setFRefNum(entry.ref_number | '');
    setFMemo(entry.memo | '');
    const entryLines = lines[entry.id] | [];
    setFLines(
      entryLines.length >= 2
        ? entryLines.map((l) => ({
            account_code: l.account_code | '',
            account_name: l.account_name | '',
            debit: l.debit ? String(l.debit) : '',
            credit: l.credit ? String(l.credit) : '',
            description: l.description | '',
          }))
        : [
            { account_code: '', account_name: '', debit: '', credit: '', description: '' },
            { account_code: '', account_name: '', debit: '', credit: '', description: '' },
          ],
    );
    setModalOpen(true);
  };

  const totalDebits = fLines.reduce((s, l) => s + (parseFloat(l.debit) | 0), 0);
  const totalCredits = fLines.reduce((s, l) => s + (parseFloat(l.credit) | 0), 0);
  const isBalanced = Math.abs(totalDebits - totalCredits) < 0.001 && totalDebits > 0;

  // Lock date check whenever date changes
  const isLocked = useMemo(() => {
    const dateStr = format(fDate, 'yyyy-MM-dd');
    return entryFallsInLockedPeriod(dateStr, lockDate);
  }, [fDate, lockDate]);

  const lockMessage = useMemo(() => {
    if (!isLocked || !lockDate) return null;
    return `Books are locked through ${lockDate}. Entry cannot be saved for this date.`;
  }, [isLocked, lockDate]);

  // Pairing warnings
  const pairingWarnings = useMemo(() => {
    return findPairingWarnings(fLines, accountsByName);
  }, [fLines, accountsByName]);

  // Simple mode: convert +/- amount to debit/credit based on account type
  const resolveSimpleAmount = (
    accountName: string,
    amountStr: string,
  ): { debit: string; credit: string } => {
    const amount = parseFloat(amountStr);
    if (!amountStr || isNaN(amount) || amount === 0) return { debit: '', credit: '' };
    const acct = accountsByName.get(accountName.toLowerCase());
    const acctType = acct ? normalizeAccountType(acct.account_type) : null;
    // For debit-normal accounts (Asset, Expense): positive = debit, negative = credit
    // For credit-normal accounts (Liability, Equity, Income/Revenue): positive = credit, negative = debit
    const isDebitNormal = !acctType | (acctType === 'ASSET') | (acctType === 'EXPENSE');
    const absAmt = Math.abs(amount).toString();
    if (isDebitNormal) {
      return amount > 0 ? { debit: absAmt, credit: '' } : { debit: '', credit: absAmt };
    } else {
      return amount > 0 ? { debit: '', credit: absAmt } : { debit: absAmt, credit: '' };
    }
  };

  const updateLine = (idx: number, field: keyof FormLine | 'amount', value: string) => {
    const copy = [...fLines];
    if (field === 'amount') {
      // Simple mode: resolve amount to debit/credit
      const { debit, credit } = resolveSimpleAmount(copy[idx].account_name, value);
      copy[idx] = { ...copy[idx], debit, credit };
      // Store the raw amount in a data attribute via description prefix... no, just derive it
    } else {
      copy[idx] = { ...copy[idx], [field]: value };
      if (field === 'debit' && value) copy[idx].credit = '';
      if (field === 'credit' && value) copy[idx].debit = '';
      // In simple mode, when account_name changes, re-resolve the existing amount
      if (simpleMode && field === 'account_name') {
        const currentAmount = getSimpleAmount(copy[idx]);
        if (currentAmount) {
          const { debit, credit } = resolveSimpleAmount(value, currentAmount);
          copy[idx] = { ...copy[idx], account_name: value, debit, credit };
        }
      }
    }
    setFLines(copy);
  };

  // Derive the simple-mode amount from debit/credit
  const getSimpleAmount = (line: FormLine): string => {
    const acct = accountsByName.get(line.account_name.toLowerCase());
    const acctType = acct ? normalizeAccountType(acct.account_type) : null;
    const isDebitNormal = !acctType | (acctType === 'ASSET') | (acctType === 'EXPENSE');
    const d = parseFloat(line.debit) | 0;
    const c = parseFloat(line.credit) | 0;
    if (d > 0) return isDebitNormal ? d.toString() : (-d).toString();
    if (c > 0) return isDebitNormal ? (-c).toString() : c.toString();
    return '';
  };

  const handleSave = async (action: 'save_close' | 'save_new') => {
    if (!orgId || !isBalanced) return;
    // Lock date enforcement
    if (isLocked) return;
    setSaving(true);
    try {
      if (editingEntry) {
        const encEntry = await encryptJournalEntry(
          {
            memo: fMemo | null,
            ref_number: fRefNum | null,
            currency: fCurrency,
            exchange_rate: null,
            status: editingEntry.status,
            source_type: null,
            period_locked: false,
          },
          encryptText,
        );
        await supabase
          .from('journal_entries')
          .update({
            date: format(fDate, 'yyyy-MM-dd'),
            ...encEntry,
          } as any)
          .eq('id', editingEntry.id);

        await supabase.from('journal_entry_lines').delete().eq('journal_entry_id', editingEntry.id);
        const encLines = await Promise.all(
          fLines
            .filter((l) => l.debit | l.credit)
            .map(async (l) => {
              const enc = await buildLineInsert({
                wallet_currency: fCurrency,
                primary_currency: primaryCurrency,
                date: format(fDate, 'yyyy-MM-dd'),
                account_name: l.account_name | null,
                account_code: l.account_code | null,
                description: l.description | null,
                debit: parseFloat(l.debit) | 0,
                credit: parseFloat(l.credit) | 0,
              });
              return { journal_entry_id: editingEntry.id, ...enc };
            }),
        );
        await supabase.from('journal_entry_lines').insert(encLines as any);
      } else {
        const encEntry = await encryptJournalEntry(
          {
            memo: fMemo | null,
            ref_number: fRefNum | null,
            currency: fCurrency,
            exchange_rate: null,
            status: 'DRAFT',
            source_type: null,
            period_locked: false,
          },
          encryptText,
        );
        const { data: je, error } = await supabase
          .from('journal_entries')
          .insert({
            org_id: orgId,
            date: format(fDate, 'yyyy-MM-dd'),
            ...encEntry,
          } as any)
          .select()
          .single();
        if (error) throw error;

        const encLines = await Promise.all(
          fLines
            .filter((l) => l.debit | l.credit)
            .map(async (l) => {
              const enc = await buildLineInsert({
                wallet_currency: fCurrency,
                primary_currency: primaryCurrency,
                date: format(fDate, 'yyyy-MM-dd'),
                account_name: l.account_name | null,
                account_code: l.account_code | null,
                description: l.description | null,
                debit: parseFloat(l.debit) | 0,
                credit: parseFloat(l.credit) | 0,
              });
              return { journal_entry_id: (je as any).id, ...enc };
            }),
        );
        await supabase.from('journal_entry_lines').insert(encLines as any);
      }

      if (action === 'save_close') setModalOpen(false);
      else {
        setEditingEntry(null);
        setFDate(new Date());
        setFRefNum(await generateRefNum());
        setFMemo('');
        setFLines([
          { account_code: '', account_name: '', debit: '', credit: '', description: '' },
          { account_code: '', account_name: '', debit: '', credit: '', description: '' },
        ]);
      }
      await fetchData();
    } catch (err: any) {
      alert('Save failed: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this journal entry?')) return;
    await supabase.from('journal_entries').delete().eq('id', id);
    await fetchData();
  };

  const handleReverse = async (id: string) => {
    if (
      !confirm(
        'Reverse this journal entry? A new reversing entry will be posted in the current period.',
      )
    )
      return;
    try {
      await reverseJournalEntry({
        journalEntryId: id,
        orgId: orgId!,
        date: format(new Date(), 'yyyy-MM-dd'),
        encryptText,
        decryptText,
      });
      await fetchData();
    } catch (err: any) {
      alert(`Reverse failed: ${err?.message ?? err}`);
    }
  };

  /* ───── Bulk actions (Track 7) ─────
   *
   * Same pattern as Transactions bulk actions and Payments bulk
   * actions. Each handler iterates the selected set, acts only on
   * status-compatible rows, and skips the rest silently.
   *
   *   - Bulk Post: DRAFT → POSTED. Flips status only; journal_entry_lines
   *     stay where they are. period-locked entries skipped.
   *   - Bulk Reverse: POSTED → write a proper reversing JE via the helper,
   *     flip original to VOID. period-locked / source_type entries skipped.
   *   - Bulk Delete: only DRAFT entries; posted/void entries must be
   *     reversed instead. Guarded by a confirm.
   */
  const handleBulkPost = async () => {
    if (selected.size === 0) return;
    setBulkActing(true);
    let moved = 0;
    try {
      const encStatus = await encryptText('POSTED');
      for (const id of selected) {
        const e = entries.find((en) => en.id === id);
        if (!e || e.status !== 'DRAFT' || e.period_locked) continue;
        const { error } = await supabase
          .from('journal_entries')
          .update({ status: encStatus, key_version: 2 } as any)
          .eq('id', id);
        if (error) continue;
        writeAuditLog({
          orgId: orgId!,
          action: 'POST',
          entityType: 'journal_entry',
          entityId: id,
          summary: 'Bulk posted journal entry',
          encrypt: encryptText,
        });
        moved += 1;
      }
      alert(`${moved} journal entr${moved === 1 ? 'y' : 'ies'} posted.`);
      setSelected(new Set());
      await fetchData();
    } finally {
      setBulkActing(false);
    }
  };

  const handleBulkReverse = async () => {
    if (selected.size === 0) return;
    if (
      !confirm(
        `Reverse ${selected.size} selected entries? A reversing JE will be posted in the current period for each.`,
      )
    )
      return;
    setBulkActing(true);
    const today = format(new Date(), 'yyyy-MM-dd');
    const failures: string[] = [];
    let moved = 0;
    try {
      for (const id of selected) {
        const e = entries.find((en) => en.id === id);
        if (!e || e.status !== 'POSTED' || e.period_locked || e.source_type === 'VOID_REVERSAL')
          continue;
        try {
          await reverseJournalEntry({
            journalEntryId: id,
            orgId: orgId!,
            date: today,
            reason: 'Bulk reverse',
            encryptText,
            decryptText,
          });
          moved += 1;
        } catch (err: any) {
          failures.push(`${id.slice(0, 8)}: ${err?.message ?? err}`);
        }
      }
      setSelected(new Set());
      await fetchData();
      let msg = `${moved} journal entr${moved === 1 ? 'y' : 'ies'} reversed.`;
      if (failures.length) msg += `\n\nFailures:\n${failures.join('\n')}`;
      alert(msg);
    } finally {
      setBulkActing(false);
    }
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    const blockers = Array.from(selected)
      .map((id) => entries.find((e) => e.id === id))
      .filter(
        (e): e is (typeof entries)[number] => !!e && (e.status !== 'DRAFT') | e.period_locked,
      );
    if (blockers.length > 0) {
      alert(
        `${blockers.length} entries cannot be deleted (only DRAFT + unlocked rows). Reverse posted entries instead.`,
      );
      return;
    }
    if (!confirm(`Delete ${selected.size} selected draft journal entries?`)) return;
    setBulkActing(true);
    try {
      for (const id of selected) {
        await supabase.from('journal_entries').delete().eq('id', id);
      }
      setSelected(new Set());
      await fetchData();
    } finally {
      setBulkActing(false);
    }
  };

  /* ───── Selection helpers ───── */
  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleSelectAll = (pageIds: string[]) =>
    setSelected((prev) => {
      const allOnPage = pageIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allOnPage) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });

  if (loading || orgLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Row 1 — title left, search + actions right */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <h1 className="text-2xl font-bold text-foreground">Journal Entries</h1>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] max-w-[280px] flex-1">
            <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search journal entries..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 h-9"
            />
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-9 w-9 shrink-0"
            onClick={fetchData}
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </Button>
          <Button variant="outline" size="sm" className="h-9" onClick={() => setImportOpen(true)}>
            <Upload className="w-4 h-4 mr-1" />
            Import
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-9" type="button">
                <Download className="w-4 h-4 mr-1" />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void exportJournalPdf()}>PDF</DropdownMenuItem>
              <DropdownMenuItem onClick={() => exportJournalCsv()}>CSV</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canWriteJE && (
            <Button
              size="sm"
              className="h-9 bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white"
              onClick={openAdd}
              data-testid="je-new-button"
            >
              <Plus className="w-4 h-4 mr-1" />
              Add Journal Entry
            </Button>
          )}
        </div>
      </div>

      {/* Row 2 — DATE RANGE (year + from/to) + STATUS on the right */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between border-b border-border pb-3">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              Date range
            </span>
            <Select
              value={String(displayYear)}
              disabled={datePreset === 'all_time'}
              onValueChange={(v) => {
                const y = Number(v);
                setDatePreset('custom');
                setCustomFrom(startOfYear(new Date(y, 0, 1)));
                setCustomTo(endOfYear(new Date(y, 0, 1)));
              }}
            >
              <SelectTrigger className="h-9 w-[100px] text-sm font-medium">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearSelectOptions.map((y) => (
                  <SelectItem key={y} value={String(y)}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              readOnly
              className="h-9 w-[132px] font-mono text-sm bg-muted/30"
              value={effectiveRangeLabels.from}
            />
            <span className="text-xs text-muted-foreground">to</span>
            <Input
              readOnly
              className="h-9 w-[132px] font-mono text-sm bg-muted/30"
              value={effectiveRangeLabels.to}
            />
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
                  <Calendar
                    mode="single"
                    selected={customFrom}
                    onSelect={setCustomFrom}
                    className="p-3 pointer-events-auto"
                  />
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
                  <Calendar
                    mode="single"
                    selected={customTo}
                    onSelect={setCustomTo}
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
        <div className="flex flex-col gap-1 sm:items-end">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            Status
          </span>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as JEStatusFilter)}>
            <SelectTrigger className="h-9 w-[180px] text-sm">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="DRAFT">Draft</SelectItem>
              <SelectItem value="POSTED">Posted</SelectItem>
              <SelectItem value="VOID">Void</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Row 3 — quick preset pills */}
      <div className="flex flex-wrap gap-1">
        {DATE_PRESETS.map((p) => (
          <Button
            key={p.value}
            type="button"
            size="sm"
            variant={datePreset === p.value ? 'default' : 'outline'}
            className={cn(
              'h-8 rounded-full px-3 text-xs',
              datePreset === p.value &&
                'bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white border-0',
            )}
            onClick={() => setDatePreset(p.value)}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {/* Table */}
      {sorted.length === 0 ? (
        <div className="bg-card border border-border rounded-lg p-12 text-center text-muted-foreground text-sm">
          {entries.length === 0 ? (
            'No journal entries yet — create one to start your double-entry ledger.'
          ) : (
            <>
              <p>No journal entries match these filters.</p>
              <p className="mt-1 text-xs">
                Widen the date range, clear the search, or reset the status filter.
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          {/* Bulk-action bar (Track 7) — same pattern as Transactions + Payments.
            Per-status guards inside the handlers do the right-thing on mixed
            selections silently. */}
          {selected.size > 0 && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm mb-3">
              <span className="font-medium text-blue-900">{selected.size} selected</span>
              <Button
                variant="outline"
                size="sm"
                className="border-green-300 text-green-700 hover:bg-green-50"
                disabled={bulkActing}
                onClick={() => void handleBulkPost()}
              >
                Post
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="border-amber-300 text-amber-700 hover:bg-amber-50"
                disabled={bulkActing}
                onClick={() => void handleBulkReverse()}
              >
                <Undo2 className="w-3.5 h-3.5 mr-1" /> Reverse
              </Button>
              {canDeleteJE && (
                <Button
                  variant="outline"
                  size="sm"
                  className="border-red-300 text-red-700 hover:bg-red-50"
                  disabled={bulkActing}
                  onClick={() => void handleBulkDelete()}
                  data-testid="je-bulk-delete"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" /> Delete drafts
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                disabled={bulkActing}
                onClick={() => setSelected(new Set())}
              >
                Clear
              </Button>
            </div>
          )}
          {/* Desktop / tablet table (>= md). Card list below covers mobile. */}
          <div className="bg-card border border-border rounded-lg overflow-x-auto hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={sorted.length > 0 && sorted.every((e) => selected.has(e.id))}
                      onCheckedChange={() => toggleSelectAll(sorted.map((e) => e.id))}
                      aria-label="Select all"
                    />
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort('date')}
                  >
                    <span className="flex items-center">
                      Date
                      <SortIcon col="date" />
                    </span>
                  </TableHead>
                  <TableHead>Ref #</TableHead>
                  <TableHead
                    className="cursor-pointer select-none"
                    onClick={() => toggleSort('memo')}
                  >
                    <span className="flex items-center">
                      Purpose
                      <SortIcon col="memo" />
                    </span>
                  </TableHead>
                  <TableHead
                    className="cursor-pointer select-none text-right"
                    onClick={() => toggleSort('amount')}
                  >
                    <span className="flex items-center justify-end">
                      Amount
                      <SortIcon col="amount" />
                    </span>
                  </TableHead>
                  <TableHead>Currency</TableHead>
                  <TableHead className="w-[120px]">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((entry) => {
                  const expanded = expandedIds.has(entry.id);
                  const entryLines = lines[entry.id] | [];
                  const total = entryTotals[entry.id] | 0;
                  const isDraft = entry.status === 'DRAFT';
                  const canEdit = isDraft && !entry.period_locked;
                  const canReverse =
                    entry.status === 'POSTED' && !entry.period_locked && !entry.source_type;

                  return (
                    <>
                      {/* entry row */}
                      <TableRow
                        key={entry.id}
                        className={cn(
                          'hover:bg-[#fafafa] dark:hover:bg-muted/40',
                          canEdit && 'cursor-pointer',
                        )}
                        onClick={() => (canEdit ? openEdit(entry) : toggleExpand(entry.id))}
                      >
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={selected.has(entry.id)}
                            onCheckedChange={() => toggleSelect(entry.id)}
                            aria-label="Select row"
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs">
                          <span className="inline-flex items-center gap-1">
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                toggleExpand(entry.id);
                              }}
                              className="p-0.5"
                            >
                              {expanded ? (
                                <ChevronDown className="w-3.5 h-3.5" />
                              ) : (
                                <ChevronRight className="w-3.5 h-3.5" />
                              )}
                            </button>
                            {entry.date}
                          </span>
                        </TableCell>
                        <TableCell>
                          {entry.ref_number && (
                            <Badge variant="outline" className="text-[10px] font-mono">
                              {entry.ref_number}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <span className="text-xs max-w-[200px] truncate">
                              {entry.memo
                                ? entry.memo.length > 40
                                  ? entry.memo.slice(0, 40) + '...'
                                  : entry.memo
                                : '—'}
                            </span>
                            {statusBadge(entry.status)}
                            {entry.period_locked && (
                              <Badge
                                className="text-[9px]"
                                style={{ background: '#FEF3C7', color: '#D97706', border: 'none' }}
                              >
                                Locked Period
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {fmtAmount(total, entry.currency)}
                          {entry.currency !== primaryCurrency &&
                            entry.exchange_rate &&
                            entry.exchange_rate !== 1 && (
                              <span
                                className="block text-[0.72rem]"
                                style={{ color: 'var(--color-gray-400)' }}
                              >
                                1 {entry.currency} = {Number(entry.exchange_rate).toFixed(6)}{' '}
                                {primaryCurrency}
                              </span>
                            )}
                        </TableCell>
                        <TableCell>
                          <Badge
                            className="text-[10px]"
                            style={{
                              background:
                                (entry.currency === 'BTC') | (entry.currency === 'SATS')
                                  ? 'var(--color-brand-orange-light)'
                                  : '#EFF6FF',
                              color:
                                (entry.currency === 'BTC') | (entry.currency === 'SATS')
                                  ? 'var(--color-brand-orange)'
                                  : '#2563EB',
                              border: 'none',
                            }}
                          >
                            {entry.currency}
                          </Badge>
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <div className="flex gap-1">
                            {canEdit && canWriteJE && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => openEdit(entry)}
                                data-testid="je-edit-button"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                            )}
                            {canEdit && canDeleteJE && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7 text-destructive"
                                onClick={() => handleDelete(entry.id)}
                                data-testid="je-delete-button"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </Button>
                            )}
                            {canReverse && (
                              <Button
                                variant="ghost"
                                size="icon"
                                className="h-7 w-7"
                                onClick={() => handleReverse(entry.id)}
                                title="Reverse"
                              >
                                <Undo2 className="w-3.5 h-3.5" />
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>

                      {/* expanded detail */}
                      {expanded && (
                        <TableRow key={`${entry.id}-detail`}>
                          <TableCell colSpan={7} className="bg-muted/30 px-8 py-3">
                            {entryLines.length === 0 ? (
                              <p className="text-xs text-muted-foreground">No line items.</p>
                            ) : (
                              <Table>
                                <TableHeader>
                                  <TableRow>
                                    <TableHead className="text-xs">Account</TableHead>
                                    <TableHead className="text-xs text-right">Debit</TableHead>
                                    <TableHead className="text-xs text-right">Credit</TableHead>
                                    <TableHead className="text-xs">Description</TableHead>
                                  </TableRow>
                                </TableHeader>
                                <TableBody>
                                  {entryLines.map((line) => (
                                    <TableRow key={line.id}>
                                      <TableCell className="text-xs">
                                        {line.account_code
                                          ? `${line.account_code} - ${line.account_name || ''}`
                                          : line.account_name || '—'}
                                      </TableCell>
                                      <TableCell className="text-right font-mono text-xs">
                                        {Number(line.debit) > 0
                                          ? fmtAmount(Number(line.debit), entry.currency)
                                          : ''}
                                      </TableCell>
                                      <TableCell className="text-right font-mono text-xs">
                                        {Number(line.credit) > 0
                                          ? fmtAmount(Number(line.credit), entry.currency)
                                          : ''}
                                      </TableCell>
                                      <TableCell className="text-xs text-muted-foreground">
                                        {line.description || '—'}
                                      </TableCell>
                                    </TableRow>
                                  ))}
                                </TableBody>
                              </Table>
                            )}
                          </TableCell>
                        </TableRow>
                      )}
                    </>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          {/* Mobile: card list (< md). Tap to expand line items; edit/delete
            from the action row. Drafts: tapping the card body opens edit. */}
          <div className="md:hidden space-y-2">
            {sorted.map((entry) => {
              const expanded = expandedIds.has(entry.id);
              const entryLines = lines[entry.id] | [];
              const total = entryTotals[entry.id] | 0;
              const isDraft = entry.status === 'DRAFT';
              const canEdit = isDraft && !entry.period_locked;
              const canReverse =
                entry.status === 'POSTED' && !entry.period_locked && !entry.source_type;
              const isBtcCurrency = (entry.currency === 'BTC') | (entry.currency === 'SATS');
              return (
                <div
                  key={entry.id}
                  className="bg-card border border-border rounded-lg p-3"
                  onClick={() => (canEdit ? openEdit(entry) : toggleExpand(entry.id))}
                >
                  <div className="flex items-start justify-between gap-3 cursor-pointer">
                    <div className="flex items-start gap-2 min-w-0 flex-1">
                      <div onClick={(e) => e.stopPropagation()} className="pt-0.5">
                        <Checkbox
                          checked={selected.has(entry.id)}
                          onCheckedChange={() => toggleSelect(entry.id)}
                          aria-label="Select"
                        />
                      </div>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleExpand(entry.id);
                        }}
                        className="p-0.5 shrink-0"
                        aria-label={expanded ? 'Collapse lines' : 'Expand lines'}
                      >
                        {expanded ? (
                          <ChevronDown className="w-3.5 h-3.5" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-mono">{entry.date}</span>
                          {entry.ref_number && (
                            <Badge variant="outline" className="text-[10px] font-mono">
                              {entry.ref_number}
                            </Badge>
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="text-xs truncate">
                            {entry.memo
                              ? entry.memo.length > 50
                                ? entry.memo.slice(0, 50) + '…'
                                : entry.memo
                              : '—'}
                          </span>
                          {statusBadge(entry.status)}
                          {entry.period_locked && (
                            <Badge
                              className="text-[9px]"
                              style={{ background: '#FEF3C7', color: '#D97706', border: 'none' }}
                            >
                              Locked
                            </Badge>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="font-mono text-sm tabular-nums">
                        {fmtAmount(total, entry.currency)}
                      </div>
                      <Badge
                        className="mt-1 text-[10px]"
                        style={{
                          background: isBtcCurrency ? 'var(--color-brand-orange-light)' : '#EFF6FF',
                          color: isBtcCurrency ? 'var(--color-brand-orange)' : '#2563EB',
                          border: 'none',
                        }}
                      >
                        {entry.currency}
                      </Badge>
                      {entry.currency !== primaryCurrency &&
                        entry.exchange_rate &&
                        entry.exchange_rate !== 1 && (
                          <div className="mt-0.5 text-[10px] text-muted-foreground">
                            1 {entry.currency} = {Number(entry.exchange_rate).toFixed(6)}
                          </div>
                        )}
                    </div>
                  </div>

                  {expanded && (
                    <div className="mt-3 border-t pt-3" onClick={(e) => e.stopPropagation()}>
                      {entryLines.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No line items.</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {entryLines.map((line) => {
                            const d = Number(line.debit);
                            const c = Number(line.credit);
                            return (
                              <li
                                key={line.id}
                                className="text-xs flex items-start justify-between gap-3"
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="truncate">
                                    {line.account_code
                                      ? `${line.account_code} — ${line.account_name || ''}`
                                      : line.account_name || '—'}
                                  </div>
                                  {line.description && (
                                    <div className="text-muted-foreground truncate">
                                      {line.description}
                                    </div>
                                  )}
                                </div>
                                <div className="font-mono text-right shrink-0">
                                  {d > 0 && <div>Dr {fmtAmount(d, entry.currency)}</div>}
                                  {c > 0 && <div>Cr {fmtAmount(c, entry.currency)}</div>}
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </div>
                  )}

                  <div
                    className="mt-2 flex justify-end gap-0.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {canEdit && canWriteJE && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => openEdit(entry)}
                        data-testid="je-edit-button"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    {canEdit && canDeleteJE && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        onClick={() => handleDelete(entry.id)}
                        data-testid="je-delete-button"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    {canReverse && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => handleReverse(entry.id)}
                        title="Reverse"
                      >
                        <Undo2 className="w-3.5 h-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* Add/Edit Modal */}
      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle>{editingEntry ? 'Edit Journal Entry' : 'Add Journal Entry'}</DialogTitle>
              <button
                type="button"
                onClick={() => setSimpleMode(!simpleMode)}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded-md border border-border"
                title={simpleMode ? 'Switch to Advanced (debit/credit)' : 'Switch to Simple (+/-)'}
              >
                {simpleMode ? (
                  <ToggleRight className="w-4 h-4 text-primary" />
                ) : (
                  <ToggleLeft className="w-4 h-4" />
                )}
                {simpleMode ? 'Simple (+/-)' : 'Advanced (Dr/Cr)'}
              </button>
            </div>
          </DialogHeader>

          <div className="space-y-4">
            {/* Header fields */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Date *</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-start text-left">
                      <CalendarIcon className="w-4 h-4 mr-2" />
                      {format(fDate, 'MM/dd/yyyy')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={fDate}
                      onSelect={(d) => d && setFDate(d)}
                      className="p-3 pointer-events-auto"
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div>
                <Label>Currency</Label>
                <Select value={fCurrency} onValueChange={setFCurrency}>
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
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <Label>Ref #</Label>
                <Input
                  value={fRefNum}
                  onChange={(e) => setFRefNum(e.target.value)}
                  placeholder="JE26-000001"
                />
              </div>
              <div>
                <Label>Memo / Purpose</Label>
                <Input
                  value={fMemo}
                  onChange={(e) => setFMemo(e.target.value)}
                  placeholder="Description"
                />
              </div>
            </div>

            {/* Pinned-rate chip — shown when wallet currency ≠ primary */}
            {fCurrency &&
              primaryCurrency &&
              fCurrency.toUpperCase() !== primaryCurrency.toUpperCase() && (
                <PinnedRateChip
                  walletCurrency={fCurrency}
                  primaryCurrency={primaryCurrency}
                  date={format(fDate, 'yyyy-MM-dd')}
                />
              )}

            {/* Lock date warning */}
            {isLocked && lockMessage && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/30 dark:border-red-800">
                <AlertTriangle className="w-4 h-4 text-red-600 shrink-0" />
                <span className="text-sm text-red-700 dark:text-red-400">{lockMessage}</span>
              </div>
            )}

            {/* Line items */}
            <div>
              <Label className="mb-2 block">Line Items</Label>
              <div
                className="border rounded-lg overflow-hidden"
                style={{ borderColor: 'var(--color-border)' }}
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-xs">Account</TableHead>
                      {simpleMode ? (
                        <TableHead className="text-xs text-right">Amount (+/-)</TableHead>
                      ) : (
                        <>
                          <TableHead className="text-xs text-right">Debit</TableHead>
                          <TableHead className="text-xs text-right">Credit</TableHead>
                        </>
                      )}
                      <TableHead className="text-xs">Description</TableHead>
                      <TableHead className="w-8" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fLines.map((line, i) => (
                      <TableRow key={i}>
                        <TableCell className="p-1">
                          <AccountCombobox
                            value={line.account_name}
                            accounts={accounts}
                            onChange={(name) => updateLine(i, 'account_name', name)}
                          />
                        </TableCell>
                        {simpleMode ? (
                          <TableCell className="p-1">
                            <Input
                              type="number"
                              step="any"
                              placeholder="+/- 0.00"
                              value={getSimpleAmount(line)}
                              onChange={(e) => updateLine(i, 'amount', e.target.value)}
                              className="h-8 text-xs text-right w-[120px]"
                            />
                          </TableCell>
                        ) : (
                          <>
                            <TableCell className="p-1">
                              <Input
                                type="number"
                                step="any"
                                placeholder="0.00"
                                value={line.debit}
                                onChange={(e) => updateLine(i, 'debit', e.target.value)}
                                className="h-8 text-xs text-right w-[100px]"
                              />
                            </TableCell>
                            <TableCell className="p-1">
                              <Input
                                type="number"
                                step="any"
                                placeholder="0.00"
                                value={line.credit}
                                onChange={(e) => updateLine(i, 'credit', e.target.value)}
                                className="h-8 text-xs text-right w-[100px]"
                              />
                            </TableCell>
                          </>
                        )}
                        <TableCell className="p-1">
                          <Input
                            placeholder="Optional"
                            value={line.description}
                            onChange={(e) => updateLine(i, 'description', e.target.value)}
                            className="h-8 text-xs"
                          />
                        </TableCell>
                        <TableCell className="p-1">
                          {fLines.length > 2 && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7"
                              onClick={() => setFLines(fLines.filter((_, j) => j !== i))}
                            >
                              <X className="w-3 h-3" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs mt-2"
                onClick={() =>
                  setFLines([
                    ...fLines,
                    { account_code: '', account_name: '', debit: '', credit: '', description: '' },
                  ])
                }
              >
                + Add Line
              </Button>
            </div>

            {/* Pairing warnings */}
            {pairingWarnings.length > 0 && (
              <div className="space-y-1.5">
                {pairingWarnings.map((w) => (
                  <div
                    key={w.code}
                    className="flex items-start gap-2 px-3 py-2 rounded-lg border border-yellow-200 bg-yellow-50 dark:bg-yellow-950/30 dark:border-yellow-800"
                  >
                    <AlertTriangle className="w-4 h-4 text-yellow-600 shrink-0 mt-0.5" />
                    <span className="text-xs text-yellow-800 dark:text-yellow-300">
                      {w.message}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Totals */}
            <div
              className="flex items-center justify-between px-2 py-2 rounded-lg"
              style={{ background: 'var(--color-gray-50)' }}
            >
              <div className="flex gap-6 text-sm">
                <span>
                  Total Debits:{' '}
                  <strong className="font-mono">{fmtAmount(totalDebits, fCurrency)}</strong>
                </span>
                <span>
                  Total Credits:{' '}
                  <strong className="font-mono">{fmtAmount(totalCredits, fCurrency)}</strong>
                </span>
              </div>
              <div>
                {isBalanced ? (
                  <span className="text-green-600 text-sm font-medium">✓ Balanced</span>
                ) : (totalDebits > 0) | (totalCredits > 0) ? (
                  <span className="text-red-600 text-sm font-medium">
                    ✗ Out of balance by {fmtAmount(Math.abs(totalDebits - totalCredits), fCurrency)}
                  </span>
                ) : null}
              </div>
            </div>
          </div>

          {editingEntry && orgId && (
            <div className="border-t pt-4 mt-2">
              <AttachmentList
                orgId={orgId}
                entityType="journal_entry"
                entityId={editingEntry.id}
                canDelete
              />
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setModalOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => handleSave('save_close')}
              disabled={saving || !isBalanced || isLocked}
            >
              {saving && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}Save & Close
            </Button>
            {!editingEntry && (
              <Button
                variant="outline"
                onClick={() => handleSave('save_new')}
                disabled={saving || !isBalanced || isLocked}
              >
                Save & New
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ImportPopup
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          void fetchData();
        }}
        entityName="CSV lines"
        sampleCsvContent={JOURNAL_SAMPLE_CSV}
        sampleFileName="journal-entries-sample.csv"
        columns={[...JOURNAL_CSV_HEADERS]}
        tips={[
          'Columns must match an export from Orange Way Books (same headers as Download Sample).',
          'Consecutive rows with the same date, ref #, memo, status, and currency form one journal entry.',
          'Debits must equal credits for each entry. Use at least two lines with amounts.',
          'Account names must match Admin > Chart of Accounts exactly (import the COA sample first if needed).',
          'Imports are saved as DRAFT. The "Wallet Currency" column sets the entry currency (e.g. USD, BTC).',
          'If your books have a lock date, lines on or before that date cannot be imported.',
        ]}
        parseCsv={(csvText: string) => parseCsvJournalEntries(csvText, accounts)}
        onImportRows={async (rows: ImportPreviewRow[]): Promise<ImportResult> => {
          // Single source of truth for JE commit lives in
          // src/lib/import-from-orange-rails/handlers.ts. Both this CSV
          // ImportPopup and the Mode 2 ImportFromOrangeRailsWizard call
          // through it. See that file for the full step-by-step.
          return await commitJournalEntriesFromStaged(rows, { orgId, encryptText, decryptText });
        }}
      />
      {manualRatePair && (
        <ManualRateDialog
          open={manualRateOpen}
          onClose={() => {
            setManualRateOpen(false);
            setManualRatePair(null);
          }}
          walletCurrency={manualRatePair.walletCurrency}
          primaryCurrency={manualRatePair.primaryCurrency}
          date={manualRatePair.date}
          onConfirm={(rate) => {
            manualRateResolveRef.current?.(rate);
            setManualRateOpen(false);
            setManualRatePair(null);
          }}
        />
      )}
    </div>
  );
}

// ── Pinned-rate chip ──────────────────────────────────────────────────────────

function PinnedRateChip({
  walletCurrency,
  primaryCurrency,
  date,
}: {
  walletCurrency: string;
  primaryCurrency: string;
  date: string;
}) {
  const { rate, loading, stale, pending, asOf, provider } = useExchangeRateChip(
    walletCurrency,
    primaryCurrency,
    date,
  );
  if (loading) return <p className="text-xs text-muted-foreground">Fetching rate…</p>;
  if (pending)
    return (
      <p className="text-xs text-amber-600 dark:text-amber-400">
        Rate for {walletCurrency}→{primaryCurrency} unavailable — line will save as pending.
      </p>
    );
  if (!rate) return null;
  return (
    <p className="text-xs text-muted-foreground">
      1 {walletCurrency} = {rate.toFixed(8)} {primaryCurrency}
      {asOf ? ` · pinned ${asOf}` : ''}
      {provider ? ` (${provider})` : ''}
      {stale ? ' · stale' : ''}
    </p>
  );
}

function useExchangeRateChip(wallet: string, primary: string, date: string) {
  return useExchangeRate(wallet, primary, date);
}
