import { useEffect, useState, useMemo, useCallback } from 'react';
import { Plus, Search, RefreshCw, Upload, Download, Loader2, ArrowUp, ArrowDown, ArrowUpDown, Eye, CheckCircle, XCircle, CalendarIcon, X, DollarSign, Clock, RotateCcw } from 'lucide-react';
import { format, startOfYear, endOfYear, startOfMonth, startOfWeek, subMonths, subYears } from 'date-fns';
import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useCapability } from '@/hooks/useCapability';
import { useVault } from '@/context/VaultContext';
import { encryptPaymentRequest, decryptPaymentRequest, decryptOrganization, decryptOrgSettings, encryptPaymentRequestLineItem, decryptPaymentRequestLineItem } from '@/lib/crypto-fields';
import { resolvePinnedRate } from '@/lib/exchange/rate-resolver';
import { useFormatCurrency } from '@/hooks/useOrgSettings';
import { ImportPopup } from '@/components/ui/import-popup';
import type { ImportPreviewRow, ImportResult } from '@/components/ui/import-popup';
import { parseCsvPayments, PAYMENT_COLUMNS, PAYMENT_SAMPLE_CSV } from '@/lib/csv/payments';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Table, TableHeader, TableBody, TableHead, TableRow, TableCell,
} from '@/components/ui/table';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { exportToCsv } from '@/lib/exports/csv';
import { printTable } from '@/lib/exports/print-table';
import { csvExportCurrencyLabel } from '@/lib/exports/csv-currency-label';
import { transactionAmountNumericForCsv } from '@/lib/exports/csv-transaction-amount';
import type { BitcoinDisplay } from '@/types';

/* ───── types ───── */

const PAYMENT_EXPORT_HEADERS = [
  'Ref #',
  'Status',
  'Type',
  'Payee',
  'Amount',
  'Currency',
  'Vendor ref',
  'Description',
  'Due date',
  'Document date',
  'Created at',
  'Paid at',
] as const;

// Status set. ON_HOLD added 2026-05-12 (Track 4 PR A) — used when an
// approver pauses for
// "need more info" without rejecting outright.
const STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'ON_HOLD', 'PAID', 'CANCELLED'] as const;
type PaymentStatus = typeof STATUSES[number];
/** Three tabs: Requests, Approvals, Payments. */
type TabValue = 'requests' | 'approvals' | 'payments';
type PaymentViewRole = 'requester' | 'approver' | 'payer' | 'admin';
type SortCol = 'ref_number' | 'created_at' | 'amount' | 'status';
type SortDir = 'asc' | 'desc';
type DatePreset = 'today' | 'this_week' | 'this_month' | 'ytd' | 'this_year' | 'last_month' | 'last_year' | 'all_time' | 'custom';
type StatusFilter = 'all' | 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'ON_HOLD' | 'PAID' | 'CANCELLED';

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

const CURRENCIES = ['USD', 'BTC', 'EUR', 'GBP', 'CAD', 'AUD', 'SATS'];

interface PaymentRow {
  id: string;
  org_id: string;
  ref_number: string | null;
  encrypted_payee: string | null;
  encrypted_description: string | null;
  encrypted_rejection_reason: string | null;
  encrypted_amount: string | null;
  amount: number;
  currency: string;
  status: string;
  request_type: string;
  vendor_ref: string | null;
  due_date: string | null;
  document_date: string | null;
  payment_address: string | null;
  requested_by: string | null;
  approved_by: string | null;
  paid_at: string | null;
  key_version: number | null;
  created_at: string | null;
  updated_at: string | null;
}

interface DecryptedPayment {
  id: string;
  ref_number: string | null;
  payee: string | null;
  description: string | null;
  rejection_reason: string | null;
  amount: number;
  currency: string;
  status: string;
  request_type: string;
  vendor_ref: string | null;
  due_date: string | null;
  document_date: string | null;
  payment_address: string | null;
  requested_by: string | null;
  approved_by: string | null;
  paid_at: string | null;
  created_at: string | null;
  // T4 PR E — frozen snapshots captured at creation.
  payee_email_snapshot: string | null;
  payee_phone_snapshot: string | null;
}

/* ───── helpers ───── */

function statusBadge(status: string) {
  switch (status) {
    case 'DRAFT': return <Badge variant="outline" className="bg-slate-50 text-slate-600 border-slate-200">Draft</Badge>;
    case 'PENDING': return <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">Pending</Badge>;
    case 'APPROVED': return <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">Approved</Badge>;
    case 'REJECTED': return <Badge variant="outline" className="bg-red-50 text-red-700 border-red-200">Rejected</Badge>;
    case 'ON_HOLD': return <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">On Hold</Badge>;
    case 'PAID': return <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">Paid</Badge>;
    case 'CANCELLED': return <Badge variant="outline" className="bg-gray-50 text-gray-500 border-gray-200">Cancelled</Badge>;
    default: return <Badge variant="outline">{status}</Badge>;
  }
}

async function getNextRefNumber(orgId: string): Promise<string> {
  const { data } = await supabase
    .from('payment_requests')
    .select('ref_number')
    .eq('org_id', orgId)
    .not('ref_number', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  const last = data?.ref_number;
  if (last) {
    const m = last.match(/PAY-(\d+)/);
    if (m) return `PAY-${String(Number(m[1]) + 1).padStart(3, '0')}`;
  }
  return 'PAY-001';
}

/**
 * PDF: Amount matches on-screen formatter (₿ / $). CSV: plain number + Currency so Excel can SUM.
 */
function buildPaymentExportRows(
  list: DecryptedPayment[],
  formatAmount: (amount: number, currency?: string) => string,
  btcDisplay: BitcoinDisplay,
  spreadsheetNumeric: boolean,
): (string | number | null)[][] {
  return list.map((r) => [
    r.ref_number ?? '',
    r.status ?? '',
    r.request_type ?? '',
    r.payee ?? '',
    spreadsheetNumeric
      ? transactionAmountNumericForCsv(r.amount, r.currency, btcDisplay)
      : formatAmount(r.amount, r.currency),
    csvExportCurrencyLabel(r.currency, btcDisplay),
    r.vendor_ref ?? '',
    r.description ?? '',
    r.due_date ?? '',
    r.document_date ?? '',
    r.created_at ? format(new Date(r.created_at), 'yyyy-MM-dd HH:mm') : '',
    r.paid_at ? format(new Date(r.paid_at), 'yyyy-MM-dd HH:mm') : '',
  ]);
}

/* ───── component ───── */

export default function Payments() {
  const { orgId, loading: orgLoading } = useUserOrg();
  const { encryptText, decryptText, encryptBlob, decryptBlob } = useVault();
  // Capability gates — UI presence only; RLS still authoritative on writes.
  // The "View as" switcher in this page is a temporary dev affordance; the
  // available roles below are derived from the caller's actual capability
  // bundle so a PaymentsApprover never sees the Payer/Create controls.
  const canReadPayments = useCapability('payments.read', orgId);
  const canCreatePayments = useCapability('payments.create', orgId);
  const canApprovePayments = useCapability('payments.approve', orgId);
  const canPayPayments = useCapability('payments.pay', orgId);
  const canManageOrgForPayments = useCapability('org.manage', orgId);
  // "Admin" tab is shown to anyone with org.manage OR payments.create — the
  // existing UI uses it as a catch-all view. If the user has zero payment
  // capabilities at all we render an empty-state below.
  const availableViewRoles = useMemo(() => {
    const roles: Array<{ key: PaymentViewRole; label: string }> = [];
    // Anyone with payments.create can use the requester view.
    if (canCreatePayments) roles.push({ key: 'requester', label: 'Requester' });
    if (canApprovePayments) roles.push({ key: 'approver', label: 'Approver' });
    if (canPayPayments) roles.push({ key: 'payer', label: 'Payer' });
    if (canManageOrgForPayments) roles.push({ key: 'admin', label: 'Admin' });
    return roles;
  }, [canCreatePayments, canApprovePayments, canPayPayments, canManageOrgForPayments]);
  const hasAnyPaymentAccess = canReadPayments | canCreatePayments | canApprovePayments | canPayPayments;
  const { formatAmount: fmtPaymentAmount, settings: paymentFmtSettings } = useFormatCurrency();
  const [orgName, setOrgName] = useState('');

  const [rows, setRows] = useState<DecryptedPayment[]>([]);
  // Bulk-action selection state (Track 4 PR B).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabValue>('requests');
  // Default to the first role the caller actually has a capability for; fall
  // back to 'admin' (it will be hidden by the gates below when not authorized).
  const [viewRole, setViewRole] = useState<PaymentViewRole>('admin');
  // If the current viewRole drops off the available list (e.g. a role grant
  // was revoked in realtime), snap to the first available role.
  useEffect(() => {
    if (availableViewRoles.length === 0) return;
    if (!availableViewRoles.some((r) => r.key === viewRole)) {
      setViewRole(availableViewRoles[0].key);
    }
  }, [availableViewRoles, viewRole]);
  const [userId, setUserId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sortCol, setSortCol] = useState<SortCol>('created_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(1);
  const perPage = 25;
  const [datePreset, setDatePreset] = useState<DatePreset>('ytd');
  const [customFrom, setCustomFrom] = useState<Date | undefined>(undefined);
  const [customTo, setCustomTo] = useState<Date | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  // Modals
  const [newOpen, setNewOpen] = useState(false);
  const [reviewRow, setReviewRow] = useState<DecryptedPayment | null>(null);
  const [processRow, setProcessRow] = useState<DecryptedPayment | null>(null);
  const [rejectionRow, setRejectionRow] = useState<DecryptedPayment | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  // New request form
  const [formPayee, setFormPayee] = useState('');
  const [formAmount, setFormAmount] = useState('');
  const [formCurrency, setFormCurrency] = useState('USD');
  const [formType, setFormType] = useState('Invoice');
  const [formDesc, setFormDesc] = useState('');
  const [formDueDate, setFormDueDate] = useState<Date | undefined>();
  const [formDocDate, setFormDocDate] = useState<Date | undefined>(new Date());
  const [formVendorRef, setFormVendorRef] = useState('');
  const [formAddress, setFormAddress] = useState('');
  const [formSaving, setFormSaving] = useState(false);
  // T4 PR D — line items inline (D-2 lock). Each entry is local-only until
  // the parent request is saved; on save we insert them as a batch.
  interface LineItemDraft {
    clientId: string;
    description: string;
    amount: string;
    accountId: string;   // chart_of_accounts.id (D-1 lock)
    files: File[];        // staged uploads (D-3 lock) — uploaded after row insert
  }
  const [formLineItems, setFormLineItems] = useState<LineItemDraft[]>([]);
  // T4 PR E — email/phone snapshot fields (E-1 lock: auto + manual override).
  // Both default to "" and persist into payment_requests.encrypted_payee_email_snapshot
  // / encrypted_payee_phone_snapshot when the request is created.
  const [formPayeeEmail, setFormPayeeEmail] = useState('');
  const [formPayeePhone, setFormPayeePhone] = useState('');
  // Available chart-of-accounts for the line-item account picker. Decrypted
  // once on first form-open and cached for the session.
  interface AccountOpt { id: string; name: string; code: string | null; }
  const [accountOptions, setAccountOptions] = useState<AccountOpt[]>([]);

  // Line items shown inside the review / process dialogs. Loaded lazily when
  // a dialog opens for a request that has any. Cached per-request-id so
  // re-opening the same row is instant.
  interface DialogLineItem {
    id: string;
    description: string | null;
    amount: number;
    account_label: string;
    attachments: Array<{ id: string; file_name: string; storage_path: string; file_size: number; mime_type: string | null }>;
  }
  const [dialogLineItems, setDialogLineItems] = useState<Record<string, DialogLineItem[]>>({});

  const loadLineItemsForDialog = useCallback(async (paymentRequestId: string) => {
    if (dialogLineItems[paymentRequestId]) return; // cached
    try {
      const { data: lineRows, error } = await supabase
        .from('payment_request_line_items')
        .select('*')
        .eq('payment_request_id', paymentRequestId)
        .order('sort_order', { ascending: true });
      if (error | !lineRows | lineRows.length === 0) {
        setDialogLineItems(prev => ({ ...prev, [paymentRequestId]: [] }));
        return;
      }

      // Decrypt each line + its account label + its attachments.
      const items: DialogLineItem[] = [];
      const accountIds = Array.from(new Set(
        (lineRows as any[]).map(r => r.chart_of_accounts_id).filter(Boolean)
      ));
      const accountLabelMap: Record<string, string> = {};
      if (accountIds.length > 0) {
        const { data: accs } = await supabase
          .from('chart_of_accounts')
          .select('id, encrypted_name, encrypted_code')
          .in('id', accountIds);
        if (accs) {
          for (const a of accs as any[]) {
            try {
              const name = a.encrypted_name ? await decryptText(a.encrypted_name) : '(unnamed)';
              const code = a.encrypted_code ? await decryptText(a.encrypted_code).catch(() => '') : '';
              accountLabelMap[a.id] = code ? `${code} — ${name}` : name;
            } catch { accountLabelMap[a.id] = '(decrypt failed)'; }
          }
        }
      }
      // Per-line attachments — one query covers all lines.
      const lineIds = (lineRows as any[]).map(r => r.id);
      const { data: attRows } = await supabase
        .from('attachments')
        .select('id, file_name, storage_path, file_size, entity_id, key_version, mime_type')
        .eq('entity_type', 'payment_request_line_item')
        .in('entity_id', lineIds);
      const attByLine: Record<string, DialogLineItem['attachments']> = {};
      if (attRows) {
        for (const a of attRows as any[]) {
          let fname = '(file)';
          let mime: string | null = null;
          try { fname = a.key_version ? await decryptText(a.file_name) : a.file_name; } catch { /* keep fallback */ }
          try { mime = a.key_version && a.mime_type ? await decryptText(a.mime_type) : (a.mime_type ?? null); } catch { /* keep null */ }
          (attByLine[a.entity_id] ||= []).push({
            id: a.id, file_name: fname, storage_path: a.storage_path, file_size: a.file_size, mime_type: mime,
          });
        }
      }

      for (const row of lineRows as any[]) {
        const dec = await decryptPaymentRequestLineItem(row, decryptText);
        items.push({
          id: row.id,
          description: dec.description,
          amount: dec.amount,
          account_label: dec.chart_of_accounts_id ? (accountLabelMap[dec.chart_of_accounts_id] ?? '(account)') : '(uncategorized)',
          attachments: attByLine[row.id] ?? [],
        });
      }
      setDialogLineItems(prev => ({ ...prev, [paymentRequestId]: items }));
    } catch (err) {
      console.error('Failed to load line items:', err);
      setDialogLineItems(prev => ({ ...prev, [paymentRequestId]: [] }));
    }
  }, [dialogLineItems, decryptText]);

  // Download + decrypt a per-line attachment, then trigger a browser
  // download in the user's preferred file viewer. Decryption happens
  // client-side under the active MEK, same as every other read path.
  const downloadLineAttachment = useCallback(async (att: { storage_path: string; file_name: string; mime_type: string | null }) => {
    try {
      const { data, error } = await supabase.storage
        .from('attachments')
        .download(att.storage_path);
      if (error | !data) throw new Error(error?.message ?? 'No data returned');
      const decryptedBuf = await decryptBlob(data);
      const mime = att.mime_type | 'application/octet-stream';
      const blob = new Blob([decryptedBuf], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = att.file_name;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Line attachment download failed:', err);
      toast.error(`Could not download "${att.file_name}".`);
    }
  }, [decryptBlob]);

  // Trigger the loader whenever a dialog opens.
  useEffect(() => {
    if (reviewRow?.id) void loadLineItemsForDialog(reviewRow.id);
  }, [reviewRow?.id, loadLineItemsForDialog]);
  useEffect(() => {
    if (processRow?.id) void loadLineItemsForDialog(processRow.id);
  }, [processRow?.id, loadLineItemsForDialog]);

  // Review modal
  const [rejectReason, setRejectReason] = useState('');
  const [reviewSaving, setReviewSaving] = useState(false);

  /* ───── fetch ───── */

  const fetchPayments = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('payment_requests')
        .select('*')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false });
      if (error) throw error;

      // Per-row decrypt. A single corrupt row must not take down the whole list,
      // but we also must not silently surface ciphertext as real data (see
      // decryptPaymentRequest: it now throws on decrypt failure). We drop the
      // bad row from the UI and warn the user.
      let decryptFailures = 0;
      const decrypted: DecryptedPayment[] = [];
      for (const row of (data | []) as any[]) {
        try {
          const d = await decryptPaymentRequest(row, decryptText);
          // T4 PR E — decrypt frozen snapshots independently. Best-effort:
          // missing/old rows simply render with null fields, no toast spam.
          let payee_email_snapshot: string | null = null;
          let payee_phone_snapshot: string | null = null;
          try {
            if (row.encrypted_payee_email_snapshot) {
              payee_email_snapshot = await decryptText(row.encrypted_payee_email_snapshot);
            }
            if (row.encrypted_payee_phone_snapshot) {
              payee_phone_snapshot = await decryptText(row.encrypted_payee_phone_snapshot);
            }
          } catch { /* snapshots optional — old rows have none */ }
          decrypted.push({
            id: row.id,
            ref_number: row.ref_number,
            payee: d.payee,
            description: d.description,
            rejection_reason: d.rejection_reason,
            amount: d.amount,
            currency: d.currency,
            status: d.status,
            request_type: d.request_type,
            vendor_ref: d.vendor_ref,
            due_date: row.due_date,
            document_date: row.document_date,
            payment_address: d.payment_address,
            requested_by: row.requested_by ?? null,
            approved_by: row.approved_by,
            paid_at: row.paid_at,
            created_at: row.created_at,
            payee_email_snapshot,
            payee_phone_snapshot,
          } as DecryptedPayment);
        } catch (err) {
          decryptFailures++;
          console.error('[Payments] decrypt failed for row', row.id, err);
        }
      }
      if (decryptFailures > 0) {
        toast.error(
          `${decryptFailures} payment request${decryptFailures === 1 ? '' : 's'} could not be decrypted and ${decryptFailures === 1 ? 'was' : 'were'} hidden. Re-unlock your vault; if this keeps happening, contact support.`,
        );
      }
      setRows(decrypted);

      const { data: orgRow } = await supabase.from('organizations').select('name, key_version').eq('id', orgId).maybeSingle();
      if (orgRow) {
        const decOrg = await decryptOrganization(orgRow as any, decryptText);
        setOrgName((decOrg.name ?? '').trim());
      }
    } catch (err) {
      console.error('Failed to fetch payments:', err);
      setRows([]);
      toast.error('Could not load payment requests. Check that your vault is unlocked, then refresh.');
    } finally {
      setLoading(false);
    }
  }, [orgId, decryptText]);

  useEffect(() => { void fetchPayments(); }, [fetchPayments]);

  useEffect(() => {
    void supabase.auth.getUser().then(({ data }) => setUserId(data.user?.id ?? null));
  }, []);

  /* ───── filter / sort / paginate ───── */

  /** Visibility rule: requester mostly sees their own requests; other roles see the org. */
  const rowsForRole = useMemo(() => {
    if (viewRole === 'requester' && userId) {
      return rows.filter((r) => r.requested_by === userId);
    }
    return rows;
  }, [rows, viewRole, userId]);

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
    let list = rowsForRole;
    // Tabs: Requests (pipeline), Approvals (pending action), Payments (approved/paid)
    if (tab === 'requests') {
      list = list.filter((r) => ['DRAFT', 'PENDING', 'REJECTED', 'CANCELLED'].includes(r.status));
    } else if (tab === 'approvals') {
      list = list.filter((r) => r.status === 'PENDING');
    } else if (tab === 'payments') {
      list = list.filter((r) => r.status === 'APPROVED' | r.status === 'PAID');
    }
    // Date range — filter on document_date with fallback to created_at (same field the "Request date" column shows)
    list = list.filter((r) => {
      const raw = r.document_date ?? r.created_at;
      if (!raw) return true;
      const d = new Date(raw.includes('T') ? raw : `${raw}T12:00:00`);
      if (dateRange.from && d < dateRange.from) return false;
      if (dateRange.to) {
        const to = new Date(dateRange.to); to.setHours(23, 59, 59);
        if (d > to) return false;
      }
      return true;
    });
    // Status filter (applied on top of tab grouping)
    if (statusFilter !== 'all') {
      list = list.filter((r) => r.status === statusFilter);
    }
    // Search
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(r =>
        (r.payee | '').toLowerCase().includes(q) ||
        (r.description | '').toLowerCase().includes(q) ||
        (r.ref_number | '').toLowerCase().includes(q) ||
        (r.vendor_ref | '').toLowerCase().includes(q)
      );
    }
    // Sort
    list = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortCol === 'ref_number') cmp = (a.ref_number | '').localeCompare(b.ref_number | '');
      else if (sortCol === 'created_at') cmp = (a.created_at | '').localeCompare(b.created_at | '');
      else if (sortCol === 'amount') cmp = a.amount - b.amount;
      else if (sortCol === 'status') cmp = a.status.localeCompare(b.status);
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [rowsForRole, tab, search, sortCol, sortDir, dateRange, statusFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const pageRows = filtered.slice((page - 1) * perPage, page * perPage);

  /** Tab badges use org-wide counts. */
  const statusCounts = useMemo(() => {
    const c: Record<string, number> = {
      DRAFT: 0, PENDING: 0, APPROVED: 0, REJECTED: 0, PAID: 0, CANCELLED: 0,
    };
    rows.forEach((r) => {
      if (c[r.status] !== undefined) c[r.status]++;
    });
    return c;
  }, [rows]);

  const requestsTabBadge = statusCounts.DRAFT + statusCounts.PENDING;
  const approvalsTabBadge = statusCounts.PENDING;
  const paymentsTabBadge = statusCounts.APPROVED;

  const buildExportRows = useCallback(
    (spreadsheetNumeric: boolean) =>
      buildPaymentExportRows(
        filtered,
        fmtPaymentAmount,
        paymentFmtSettings.bitcoinDisplayPreference,
        spreadsheetNumeric,
      ),
    [filtered, fmtPaymentAmount, paymentFmtSettings.bitcoinDisplayPreference],
  );

  const exportPaymentsCsv = useCallback(() => {
    if (filtered.length === 0) {
      toast.error('Nothing to export.');
      return;
    }
    const dataRows = buildExportRows(true);
    exportToCsv(`owb-payments-${format(new Date(), 'yyyy-MM-dd')}`, [...PAYMENT_EXPORT_HEADERS], dataRows);
    toast.success(`Exported ${filtered.length} payment${filtered.length === 1 ? '' : 's'} to CSV.`);
  }, [filtered, buildExportRows]);

  const exportPaymentsPdf = useCallback(() => {
    if (filtered.length === 0) {
      toast.error('Nothing to export.');
      return;
    }
    const dataRows = buildExportRows(false);
    const title = `${orgName | 'Organization'} — Payments — ${format(new Date(), 'yyyy-MM-dd')}`;
    void printTable(title, [...PAYMENT_EXPORT_HEADERS], dataRows)
      .then((opened) => {
        if (opened) {
          toast.success('Use Print → Save as PDF in the preview window.');
        }
      })
      .catch(() => toast.error('Failed to generate PDF.'));
  }, [filtered, orgName, buildExportRows]);

  /* ───── sort toggle ───── */

  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortCol(col); setSortDir('desc'); }
  }

  function SortIcon({ col }: { col: SortCol }) {
    if (sortCol !== col) return <ArrowUpDown className="w-3 h-3 ml-1 opacity-40" />;
    return sortDir === 'asc' ? <ArrowUp className="w-3 h-3 ml-1" /> : <ArrowDown className="w-3 h-3 ml-1" />;
  }

  /* ───── create payment request ───── */

  async function handleCreate(isDraft: boolean) {
    if (!orgId) return;
    if (!formPayee.trim()) { toast.error('Payee is required'); return; }

    // T4 PR D — when line items exist, the parent amount is the sum of the
    // rows (single source of truth). When no line items, fall back to the
    // top-level formAmount input. Either way the request stores one `amount`.
    const hasLineItems = formLineItems.length > 0;
    const validLineItems = formLineItems.filter(li =>
      li.description.trim() && parseFloat(li.amount) > 0
    );
    if (hasLineItems && validLineItems.length === 0) {
      toast.error('Add at least one line item with description + amount, or remove all line rows.');
      return;
    }
    const amt = hasLineItems ? lineItemsTotal : parseFloat(formAmount);
    if (isNaN(amt) | amt <= 0) { toast.error('Valid amount is required'); return; }

    setFormSaving(true);
    try {
      // T4 PR C + PR F — approval threshold with cross-currency support.
      //
      // If the org has set an approval_threshold_amount, compare this
      // request's amount against it. Same-currency comparison is direct
      // (PR C). Cross-currency: convert the form amount to the threshold's
      // currency via resolvePinnedRate (PR F). If the rate is pending or
      // missing we skip enforcement and surface a warning toast — better to
      // let the user save the request than block on a rate fetch.
      let forcedToPending = false;
      let thresholdRatePending = false;
      let resolvedStatus: string = isDraft ? 'DRAFT' : 'PENDING';
      try {
        const { data: settingsRow } = await supabase
          .from('org_settings')
          .select('*')
          .eq('org_id', orgId)
          .maybeSingle();
        if (settingsRow) {
          const dec = await decryptOrgSettings(settingsRow as any, decryptText);
          const threshold = dec.approval_threshold_amount;
          const thresholdCurrency = dec.approval_threshold_currency;
          if (threshold != null && thresholdCurrency && resolvedStatus === 'DRAFT') {
            let amtInThresholdCurrency = amt;
            if (thresholdCurrency !== formCurrency) {
              // PR F — resolve rate from form currency to threshold currency.
              const rate = await resolvePinnedRate({
                source: formCurrency,
                target: thresholdCurrency,
                at: formDocDate ?? new Date(),
              });
              if (rate.pending | !rate.rate) {
                thresholdRatePending = true;
              } else {
                amtInThresholdCurrency = amt * rate.rate;
              }
            }
            if (!thresholdRatePending && amtInThresholdCurrency > threshold) {
              resolvedStatus = 'PENDING';
              forcedToPending = true;
            }
          }
        }
      } catch (thresholdErr) {
        // Threshold check is non-blocking — if the read fails, fall back to
        // the user's chosen status. The form still saves.
        console.warn('Approval threshold check skipped:', thresholdErr);
      }

      const refNum = await getNextRefNumber(orgId);
      const { data: { user } } = await supabase.auth.getUser();

      // T4 PR E — email/phone snapshots (E-1 lock: auto + override).
      // If the form fields are populated, those are the snapshot. If empty,
      // try to auto-fetch from a contact whose decrypted name matches the
      // payee (case-insensitive). The snapshot is written-once: even if the
      // contact's email later changes, this request preserves the original.
      let resolvedEmail = formPayeeEmail.trim() | null;
      let resolvedPhone = formPayeePhone.trim() | null;
      if (!resolvedEmail | !resolvedPhone) {
        try {
          const { data: cRows } = await supabase
            .from('contacts')
            .select('id, name, email, phone, key_version')
            .eq('org_id', orgId);
          if (cRows) {
            for (const c of cRows) {
              try {
                const decName = c.key_version ? await decryptText(c.name) : c.name;
                if (decName && decName.toLowerCase() === formPayee.trim().toLowerCase()) {
                  if (!resolvedEmail && c.email) {
                    resolvedEmail = c.key_version ? await decryptText(c.email) : c.email;
                  }
                  if (!resolvedPhone && c.phone) {
                    resolvedPhone = c.key_version ? await decryptText(c.phone) : c.phone;
                  }
                  break;
                }
              } catch { /* skip undecryptable rows */ }
            }
          }
        } catch (lookupErr) {
          console.warn('Contact auto-snapshot lookup skipped:', lookupErr);
        }
      }
      const encPayeeEmail = resolvedEmail ? await encryptText(resolvedEmail) : null;
      const encPayeePhone = resolvedPhone ? await encryptText(resolvedPhone) : null;

      const encrypted = await encryptPaymentRequest({
        payee: formPayee,
        description: formDesc | null,
        rejection_reason: null,
        amount: amt,
        currency: formCurrency,
        status: resolvedStatus,
        request_type: formType,
        vendor_ref: formVendorRef | null,
        payment_address: formAddress | null,
      }, encryptText);

      const { data: insertedReq, error } = await supabase.from('payment_requests').insert({
        org_id: orgId,
        ref_number: refNum,
        ...encrypted,
        due_date: formDueDate ? format(formDueDate, 'yyyy-MM-dd') : null,
        document_date: formDocDate ? format(formDocDate, 'yyyy-MM-dd') : null,
        requested_by: user?.id | null,
        encrypted_payee_email_snapshot: encPayeeEmail,
        encrypted_payee_phone_snapshot: encPayeePhone,
      } as any).select('id').single();

      if (error) throw error;
      const requestId = (insertedReq as any).id;

      // T4 PR D — line items + per-line attachments.
      if (validLineItems.length > 0) {
        const encLines = await Promise.all(validLineItems.map(async (li, idx) => {
          const enc = await encryptPaymentRequestLineItem({
            description: li.description.trim(),
            amount: parseFloat(li.amount),
            chart_of_accounts_id: li.accountId | null,
            sort_order: idx,
          }, encryptText);
          return { payment_request_id: requestId, ...enc };
        }));
        const { data: insertedLines, error: linesErr } = await supabase
          .from('payment_request_line_items')
          .insert(encLines as any)
          .select('id');
        if (linesErr) {
          console.error('Failed to insert line items:', linesErr);
        } else if (insertedLines) {
          // Upload attachments for each line that has files. Index order
          // preserved by the .select('id') return — match by position.
          await Promise.all(validLineItems.map(async (li, idx) => {
            if (!li.files.length) return;
            const lineId = (insertedLines as any)[idx]?.id;
            if (!lineId) return;
            for (const file of li.files) {
              try {
                const storagePath = `${orgId}/payment_request_line_item/${lineId}/${crypto.randomUUID()}`;
                const buf = await file.arrayBuffer();
                const encBlob = await encryptBlob(buf);
                const { error: upErr } = await supabase.storage
                  .from('attachments')
                  .upload(storagePath, encBlob, { contentType: 'application/octet-stream' });
                if (upErr) { console.warn('Line-item file upload failed:', upErr); continue; }
                const encFileName = await encryptText(file.name);
                const encMime = await encryptText(file.type | 'application/octet-stream');
                await supabase.from('attachments').insert({
                  org_id: orgId,
                  entity_type: 'payment_request_line_item',
                  entity_id: lineId,
                  file_name: encFileName,
                  file_size: file.size,
                  storage_path: storagePath,
                  mime_type: encMime,
                  key_version: 2,
                  uploaded_by: user?.id | null,
                } as any);
              } catch (attachErr) {
                console.warn('Line-item attachment processing failed:', attachErr);
              }
            }
          }));
        }
      }

      if (forcedToPending) {
        toast.success('Payment request created — exceeded approval threshold, moved to Pending for approval.');
      } else if (thresholdRatePending) {
        toast.warning('Payment request created. Approval threshold check skipped: exchange rate pending. Re-review once the rate resolves.');
      } else {
        toast.success(`Payment request created${validLineItems.length > 0 ? ` with ${validLineItems.length} line items` : ''}`);
      }
      resetForm();
      setNewOpen(false);
      void fetchPayments();
    } catch (err) {
      console.error(err);
      toast.error('Failed to create payment request');
    } finally {
      setFormSaving(false);
    }
  }

  function resetForm() {
    setFormPayee(''); setFormAmount(''); setFormCurrency('USD'); setFormType('Invoice');
    setFormDesc(''); setFormDueDate(undefined); setFormDocDate(new Date());
    setFormVendorRef(''); setFormAddress('');
    setFormLineItems([]);
    setFormPayeeEmail(''); setFormPayeePhone('');
  }

  /* ───── line items helpers (T4 PR D) ───── */

  function addLineItem() {
    setFormLineItems(prev => [
      ...prev,
      {
        clientId: `li-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        description: '',
        amount: '',
        accountId: '',
        files: [],
      },
    ]);
  }
  function removeLineItem(clientId: string) {
    setFormLineItems(prev => prev.filter(li => li.clientId !== clientId));
  }
  function updateLineItem(clientId: string, patch: Partial<LineItemDraft>) {
    setFormLineItems(prev => prev.map(li => li.clientId === clientId ? { ...li, ...patch } : li));
  }

  // Total auto-computed from line items (used when at least one row exists).
  // Falls back to the manual formAmount field when there are zero line rows.
  const lineItemsTotal = useMemo(() => {
    return formLineItems.reduce((sum, li) => {
      const n = parseFloat(li.amount);
      return Number.isFinite(n) ? sum + n : sum;
    }, 0);
  }, [formLineItems]);

  // Lazy-load chart-of-accounts on first form-open (account picker for D-1).
  const ensureAccountOptionsLoaded = useCallback(async () => {
    if (accountOptions.length > 0 | !orgId) return;
    const { data, error } = await supabase
      .from('chart_of_accounts')
      .select('id, encrypted_name, encrypted_code')
      .eq('org_id', orgId)
      .eq('is_archived', false);
    if (error | !data) return;
    const opts: AccountOpt[] = await Promise.all(
      data.map(async (a: any) => {
        try {
          const name = a.encrypted_name ? await decryptText(a.encrypted_name) : '(unnamed)';
          const code = a.encrypted_code ? await decryptText(a.encrypted_code).catch(() => null) : null;
          return { id: a.id, name, code };
        } catch {
          return { id: a.id, name: '(decrypt failed)', code: null };
        }
      })
    );
    opts.sort((a, b) => (a.code ?? '').localeCompare(b.code ?? '') | a.name.localeCompare(b.name));
    setAccountOptions(opts);
  }, [accountOptions.length, orgId, decryptText]);

  /* ───── status changes ───── */

  // Approve / reject go through SECURITY DEFINER RPCs (migration
  // 20260418000000_payment_requests_authorship_pin.sql). The RPC pins
  // approved_by to auth.uid() and enforces "ACCOUNTANT+ may approve" at
  // the DB layer — a VIEWER/MEMBER who guesses a request UUID cannot
  // approve via a hand-crafted HTTP call.
  async function handleApprove(id: string) {
    setReviewSaving(true);
    try {
      const encStatus = await encryptText('APPROVED');
      const { error } = await supabase.rpc('approve_payment_request' as never, {
        request_id: id, new_status_ciphertext: encStatus,
      } as never);
      if (error) throw error;
      toast.success('Request approved');
      setReviewRow(null);
      void fetchPayments();
    } catch { toast.error('Failed to approve'); }
    finally { setReviewSaving(false); }
  }

  async function handleReject(id: string) {
    if (!rejectReason.trim()) { toast.error('Rejection reason is required'); return; }
    setReviewSaving(true);
    try {
      const encReason = await encryptText(rejectReason);
      const encStatus = await encryptText('REJECTED');
      const { error } = await supabase.rpc('reject_payment_request' as never, {
        request_id: id,
        new_status_ciphertext: encStatus,
        rejection_reason_ciphertext: encReason,
      } as never);
      if (error) throw error;
      toast.success('Request rejected');
      setReviewRow(null); setRejectReason('');
      void fetchPayments();
    } catch { toast.error('Failed to reject'); }
    finally { setReviewSaving(false); }
  }

  async function handleMarkPaid(id: string) {
    try {
      const encStatus = await encryptText('PAID');
      const { error } = await supabase.from('payment_requests').update({
        status: encStatus, paid_at: new Date().toISOString(), key_version: 2,
      }).eq('id', id);
      if (error) throw error;
      toast.success('Marked as paid');
      setProcessRow(null);
      void fetchPayments();
    } catch { toast.error('Failed to update'); }
  }

  async function handleCancel(id: string) {
    try {
      const encStatus = await encryptText('CANCELLED');
      const { error } = await supabase.from('payment_requests').update({ status: encStatus, key_version: 2 }).eq('id', id);
      if (error) throw error;
      toast.success('Request cancelled');
      void fetchPayments();
    } catch { toast.error('Failed to cancel'); }
  }

  /**
   * Put a pending payment request on hold. The PaymentRequest model — used
   * when an approver needs more info but isn't outright rejecting. Status
   * moves PENDING → ON_HOLD; later the same approver can take it back to
   * PENDING (via reopen) or move it forward to APPROVED / REJECTED.
   */
  async function handleOnHold(id: string, reason: string) {
    if (!reason.trim()) { toast.error('On-hold reason is required'); return; }
    setReviewSaving(true);
    try {
      const encStatus = await encryptText('ON_HOLD');
      const encReason = await encryptText(reason);
      // We re-use the rejection_reason column for the on-hold note. Both
      // describe "why an approver paused this row," and reusing the column
      // avoids a migration. The status field distinguishes the meaning.
      const { error } = await supabase.from('payment_requests').update({
        status: encStatus,
        rejection_reason: encReason,
        key_version: 2,
      } as any).eq('id', id);
      if (error) throw error;
      toast.success('Request placed on hold');
      setReviewRow(null);
      setRejectReason('');
      void fetchPayments();
    } catch { toast.error('Failed to place on hold'); }
    finally { setReviewSaving(false); }
  }

  /**
   * Reopen an ON_HOLD payment back to PENDING. Clears the on-hold note.
   */
  async function handleReopenFromHold(id: string) {
    try {
      const encStatus = await encryptText('PENDING');
      const { error } = await supabase.from('payment_requests').update({
        status: encStatus,
        rejection_reason: null,
        key_version: 2,
      } as any).eq('id', id);
      if (error) throw error;
      toast.success('Request reopened');
      void fetchPayments();
    } catch { toast.error('Failed to reopen'); }
  }

  /* ───── selection + bulk actions (T4 PR B) ─────
   *
   * Mirrors the Transactions bulk-action pattern. Each bulk handler iterates
   * the selected set and only acts on rows whose status is compatible with
   * the action; incompatible rows are silently skipped and the toast reports
   * how many actually moved. RECONCILED guard does not apply here (Payments
   * has no reconciliation state).
   */
  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const toggleSelectAll = (pageIds: string[]) => {
    setSelected(prev => {
      const allOnPage = pageIds.every(id => prev.has(id));
      const next = new Set(prev);
      if (allOnPage) { pageIds.forEach(id => next.delete(id)); }
      else { pageIds.forEach(id => next.add(id)); }
      return next;
    });
  };

  async function handleBulkApprove() {
    if (selected.size === 0) return;
    setBulkActing(true);
    let moved = 0;
    try {
      const encStatus = await encryptText('APPROVED');
      for (const id of selected) {
        const r = rows.find(p => p.id === id);
        if (!r | (r.status !== 'PENDING' && r.status !== 'ON_HOLD')) continue;
        const { error } = await supabase.rpc('approve_payment_request' as never, {
          request_id: id, new_status_ciphertext: encStatus,
        } as never);
        if (!error) moved += 1;
      }
      toast.success(`${moved} request${moved === 1 ? '' : 's'} approved`);
      setSelected(new Set());
      void fetchPayments();
    } finally { setBulkActing(false); }
  }

  async function handleBulkMarkPaid() {
    if (selected.size === 0) return;
    setBulkActing(true);
    let moved = 0;
    try {
      const encStatus = await encryptText('PAID');
      const paidAt = new Date().toISOString();
      for (const id of selected) {
        const r = rows.find(p => p.id === id);
        if (!r | r.status !== 'APPROVED') continue;
        const { error } = await supabase.from('payment_requests').update({
          status: encStatus, paid_at: paidAt, key_version: 2,
        }).eq('id', id);
        if (!error) moved += 1;
      }
      toast.success(`${moved} request${moved === 1 ? '' : 's'} marked paid`);
      setSelected(new Set());
      void fetchPayments();
    } finally { setBulkActing(false); }
  }

  async function handleBulkCancel() {
    if (selected.size === 0) return;
    if (!confirm(`Cancel ${selected.size} selected request(s)?`)) return;
    setBulkActing(true);
    let moved = 0;
    try {
      const encStatus = await encryptText('CANCELLED');
      for (const id of selected) {
        const r = rows.find(p => p.id === id);
        if (!r | (r.status !== 'DRAFT' && r.status !== 'PENDING' && r.status !== 'ON_HOLD')) continue;
        const { error } = await supabase.from('payment_requests').update({
          status: encStatus, key_version: 2,
        }).eq('id', id);
        if (!error) moved += 1;
      }
      toast.success(`${moved} request${moved === 1 ? '' : 's'} cancelled`);
      setSelected(new Set());
      void fetchPayments();
    } finally { setBulkActing(false); }
  }

  /* ───── row click ───── */

  function handleRowClick(r: DecryptedPayment) {
    if (r.status === 'PENDING') setReviewRow(r);
    else if (r.status === 'ON_HOLD') setReviewRow(r); // same dialog as PENDING; surfaces Reopen + Approve + Reject
    else if (r.status === 'APPROVED') setProcessRow(r);
    else if (r.status === 'REJECTED') setRejectionRow(r);
    else if (r.status === 'PAID') setProcessRow(r);
  }

  /* ───── import ───── */

  const handleImportRows = useCallback(async (importRows: ImportPreviewRow[]): Promise<ImportResult> => {
    if (!orgId) return { created: 0, skipped: 0, failed: 0, errors: ['No org'] };
    let created = 0, skipped = 0, failed = 0;
    const errors: string[] = [];
    const warnings: string[] = [];

    for (const row of importRows) {
      try {
        const payee = row.data.contact | '';
        const amtRaw = String(row.data.amount ?? '').replace(/,/g, '').trim();
        const amt = Number.parseFloat(amtRaw);
        if (!payee | !Number.isFinite(amt) | amt <= 0) {
          failed++;
          errors.push(`Row ${row.rowIndex}: invalid payee or amount`);
          continue;
        }

        const refNum = await getNextRefNumber(orgId);
        const encrypted = await encryptPaymentRequest({
          payee,
          description: row.data.description | null,
          rejection_reason: null,
          amount: amt,
          currency: row.data.currency | 'USD',
          status: 'PENDING',
          request_type: row.data.type | 'Invoice',
          vendor_ref: row.data.vendor_ref | null,
          payment_address: null,
        }, encryptText);

        const { error } = await supabase.from('payment_requests').insert({
          org_id: orgId,
          ref_number: refNum,
          ...encrypted,
          due_date: row.data.due_date | null,
          document_date: format(new Date(), 'yyyy-MM-dd'),
        });
        if (error) throw error;
        created++;
      } catch (err) {
        failed++;
        errors.push(`Row ${row.rowIndex}: ${err instanceof Error ? err.message : 'Failed'}`);
      }
    }
    void fetchPayments();
    return { created, skipped, failed, errors, warnings };
  }, [orgId, encryptText, fetchPayments]);

  /* ───── render ───── */

  if (orgLoading | loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin" style={{ color: 'var(--color-gray-400)' }} />
      </div>
    );
  }

  // Friendly empty state when the calling user has no payment capabilities.
  // RLS still enforces this; the page just refuses to render a control surface.
  if (!hasAnyPaymentAccess) {
    return (
      <div className="p-6" data-testid="payments-no-access">
        <h1 className="text-2xl font-bold text-foreground">Payments</h1>
        <p className="text-sm text-muted-foreground mt-2">
          You don&apos;t have access to Payments in this organization. Ask an
          owner or admin to grant you the relevant role.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4" style={{ fontFamily: 'system-ui, -apple-system, sans-serif' }}>
      {/* Row 1 — title left, search + actions right (mirrors the Transactions header) */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Payments</h1>
          <p className="text-sm" style={{ color: 'var(--color-gray-500)' }}>
            {statusCounts.DRAFT > 0 && <>{statusCounts.DRAFT} draft · </>}
            {statusCounts.PENDING} pending · {statusCounts.APPROVED} approved · {statusCounts.PAID} paid
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] max-w-[280px] flex-1">
            <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="Search payments..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="pl-9 h-9"
            />
            {search && (
              <button type="button" className="absolute right-2 top-2.5 text-muted-foreground hover:text-foreground" onClick={() => setSearch('')} aria-label="Clear search">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
          <Button variant="outline" size="icon" className="h-9 w-9 shrink-0" onClick={() => void fetchPayments()} title="Refresh">
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
              <DropdownMenuItem onClick={() => void exportPaymentsPdf()}>PDF</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void exportPaymentsCsv()}>CSV</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {canCreatePayments && (
            <Button
              size="sm"
              className="h-9 bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white"
              onClick={() => { resetForm(); setNewOpen(true); }}
              data-testid="payments-new-request"
            >
              <Plus className="w-4 h-4 mr-1" />New Request
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
                setPage(1);
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
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v as StatusFilter); setPage(1); }}>
            <SelectTrigger className="h-9 w-[180px] text-sm">
              <SelectValue placeholder="All Statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="DRAFT">Draft</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
              <SelectItem value="ON_HOLD">On Hold</SelectItem>
              <SelectItem value="PAID">Paid</SelectItem>
              <SelectItem value="CANCELLED">Cancelled</SelectItem>
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
              datePreset === p.value && 'bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white border-0'
            )}
            onClick={() => { setDatePreset(p.value); setPage(1); }}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {/* Row 4 — VIEW AS (centered, temporary until user profiles ship).
          Roles available here are derived from the caller's actual capability
          bundle: a PaymentsApprover only sees the Approver tile, a Payer only
          sees Payer, etc. If the caller only has a single role we hide the
          whole switcher (it's a no-op affordance). */}
      {availableViewRoles.length > 1 && (
        <div className="flex justify-center" data-testid="payments-view-as">
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">View as</span>
            <div className="inline-flex flex-wrap rounded-lg border border-border bg-muted/40 p-0.5 gap-0.5">
              {availableViewRoles.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => { setViewRole(key); setPage(1); }}
                  className={cn(
                    'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
                    viewRole === key
                      ? 'bg-[var(--color-brand-orange)] text-white shadow-sm'
                      : 'text-muted-foreground hover:bg-background hover:text-foreground'
                  )}
                  data-testid={`payments-view-as-${key}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Row 5 — Tabs (search moved to Row 1) */}
      <Tabs value={tab} onValueChange={(v) => { setTab(v as TabValue); setPage(1); }}>
        <TabsList className="h-auto flex-wrap justify-start gap-1 p-1">
          <TabsTrigger value="requests" className="gap-1.5 px-3 py-2">
            Requests
            {requestsTabBadge > 0 && (
              <span className="min-w-[1.25rem] rounded-full bg-red-500 px-1 text-center text-[10px] font-bold text-white">{requestsTabBadge}</span>
            )}
          </TabsTrigger>
          {canApprovePayments && (
            <TabsTrigger value="approvals" className="gap-1.5 px-3 py-2" data-testid="payments-tab-approvals">
              Approvals
              {approvalsTabBadge > 0 && (
                <span className="min-w-[1.25rem] rounded-full bg-red-500 px-1 text-center text-[10px] font-bold text-white">{approvalsTabBadge}</span>
              )}
            </TabsTrigger>
          )}
          {canPayPayments && (
            <TabsTrigger value="payments" className="gap-1.5 px-3 py-2" data-testid="payments-tab-payments">
              Payments
              {paymentsTabBadge > 0 && (
                <span className="min-w-[1.25rem] rounded-full bg-red-500 px-1 text-center text-[10px] font-bold text-white">{paymentsTabBadge}</span>
              )}
            </TabsTrigger>
          )}
        </TabsList>
      </Tabs>

      {/* Bulk-action bar (T4 PR B) — appears when at least one row is selected.
          Mirrors the Transactions bulk-action UX: per-status guards inside the
          handlers mean clicking "Approve" with a CANCELLED row in selection
          just silently skips it. */}
      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
          <span className="font-medium text-blue-900">
            {selected.size} selected
          </span>
          <Button
            variant="outline"
            size="sm"
            className="border-green-300 text-green-700 hover:bg-green-50"
            disabled={bulkActing}
            onClick={() => void handleBulkApprove()}
          >
            <CheckCircle className="w-3.5 h-3.5 mr-1" /> Approve
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-blue-300 text-blue-700 hover:bg-blue-50"
            disabled={bulkActing}
            onClick={() => void handleBulkMarkPaid()}
          >
            <DollarSign className="w-3.5 h-3.5 mr-1" /> Mark paid
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-gray-300 text-gray-700 hover:bg-gray-50"
            disabled={bulkActing}
            onClick={() => void handleBulkCancel()}
          >
            <X className="w-3.5 h-3.5 mr-1" /> Cancel
          </Button>
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

      {/* Table — standard column order */}
      <div className="border rounded-lg overflow-x-auto" style={{ borderColor: 'var(--color-border)' }}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={pageRows.length > 0 && pageRows.every(r => selected.has(r.id))}
                  onCheckedChange={() => toggleSelectAll(pageRows.map(r => r.id))}
                  aria-label="Select all rows on this page"
                />
              </TableHead>
              <TableHead className="cursor-pointer select-none whitespace-nowrap" onClick={() => toggleSort('created_at')}>
                <span className="flex items-center">Request date <SortIcon col="created_at" /></span>
              </TableHead>
              <TableHead>Payee</TableHead>
              <TableHead className="cursor-pointer select-none text-right whitespace-nowrap" onClick={() => toggleSort('amount')}>
                <span className="flex items-center justify-end">Amount <SortIcon col="amount" /></span>
              </TableHead>
              <TableHead className="cursor-pointer select-none whitespace-nowrap" onClick={() => toggleSort('ref_number')}>
                <span className="flex items-center">Ref # <SortIcon col="ref_number" /></span>
              </TableHead>
              <TableHead>Due date</TableHead>
              <TableHead className="cursor-pointer select-none whitespace-nowrap" onClick={() => toggleSort('status')}>
                <span className="flex items-center">Status <SortIcon col="status" /></span>
              </TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="w-10 text-right"> </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pageRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center py-8 text-muted-foreground">
                  {search ? `No results for "${search}".` : 'No payment requests in this view yet.'}
                </TableCell>
              </TableRow>
            ) : (
              pageRows.map((r) => {
                const requestDate = r.document_date | (r.created_at ? format(new Date(r.created_at), 'yyyy-MM-dd') : null);
                const requestDateLabel = requestDate
                  ? format(new Date(requestDate.includes('T') ? requestDate : `${requestDate}T12:00:00`), 'MM-dd-yyyy')
                  : '—';
                return (
                  <TableRow key={r.id} className="cursor-pointer hover:bg-muted/50" onClick={() => handleRowClick(r)}>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(r.id)}
                        onCheckedChange={() => toggleSelect(r.id)}
                        aria-label="Select row"
                      />
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-sm font-mono">{requestDateLabel}</TableCell>
                    <TableCell className="font-medium text-sm">{r.payee | '—'}</TableCell>
                    <TableCell className="text-right font-mono text-sm">{fmtPaymentAmount(r.amount, r.currency)}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{r.vendor_ref | r.ref_number | '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {r.due_date ? format(new Date(r.due_date), 'MM-dd-yyyy') : '—'}
                    </TableCell>
                    <TableCell>{statusBadge(r.status)}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.request_type}</TableCell>
                    <TableCell className="text-right">
                      {r.status === 'PENDING' && (
                        <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setReviewRow(r); }}>
                          <Eye className="w-4 h-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm" style={{ color: 'var(--color-gray-500)' }}>
          <span>{filtered.length} request{filtered.length !== 1 ? 's' : ''}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Prev</Button>
            <span>Page {page} of {totalPages}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      {/* ───── New Request Modal ───── */}
      <Dialog open={newOpen} onOpenChange={setNewOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Payment Request</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Payee *</Label>
              <Input placeholder="Contact or company name" value={formPayee} onChange={e => setFormPayee(e.target.value)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Amount *</Label>
                <Input type="number" placeholder="0.00" min="0" step="any" value={formAmount} onChange={e => setFormAmount(e.target.value)} />
              </div>
              <div>
                <Label>Currency</Label>
                <Select value={formCurrency} onValueChange={setFormCurrency}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Request Type</Label>
                <Select value={formType} onValueChange={setFormType}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {['Invoice', 'Transfer', 'Reimbursement', 'Other'].map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Vendor Ref</Label>
                <Input placeholder="INV-2026-001" value={formVendorRef} onChange={e => setFormVendorRef(e.target.value)} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Document Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className={cn('w-full justify-start text-left font-normal', !formDocDate && 'text-muted-foreground')}>
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {formDocDate ? format(formDocDate, 'MMM d, yyyy') : 'Pick a date'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0"><Calendar mode="single" selected={formDocDate} onSelect={setFormDocDate} /></PopoverContent>
                </Popover>
              </div>
              <div>
                <Label>Due Date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className={cn('w-full justify-start text-left font-normal', !formDueDate && 'text-muted-foreground')}>
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {formDueDate ? format(formDueDate, 'MMM d, yyyy') : 'Pick a date'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0"><Calendar mode="single" selected={formDueDate} onSelect={setFormDueDate} /></PopoverContent>
                </Popover>
              </div>
            </div>
            <div>
              <Label>Payment Address</Label>
              <Input placeholder="BTC address, Lightning address, or bank details" value={formAddress} onChange={e => setFormAddress(e.target.value)} />
            </div>
            <div>
              <Label>Description</Label>
              <Textarea placeholder="Business justification for this payment..." value={formDesc} onChange={e => setFormDesc(e.target.value)} rows={3} />
            </div>

            {/* T4 PR E — Email/phone snapshot fields (auto-populated from
                Contacts on save when blank; whatever's typed here wins as
                the audit-frozen snapshot.) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Payee Email <span className="text-xs text-muted-foreground">(snapshot at creation)</span></Label>
                <Input
                  type="email"
                  placeholder="Leave blank to auto-fill from Contacts"
                  value={formPayeeEmail}
                  onChange={e => setFormPayeeEmail(e.target.value)}
                />
              </div>
              <div>
                <Label>Payee Phone <span className="text-xs text-muted-foreground">(snapshot at creation)</span></Label>
                <Input
                  type="tel"
                  placeholder="Leave blank to auto-fill from Contacts"
                  value={formPayeePhone}
                  onChange={e => setFormPayeePhone(e.target.value)}
                />
              </div>
            </div>

            {/* T4 PR D — Line items. Each row carries
                its own description, amount, chart-of-accounts FK, and
                optional file attachments. Total auto-sums from rows when
                ≥1 line exists; otherwise the parent "Amount" field is the
                single value. */}
            <div className="border-t pt-3 space-y-2">
              <div className="flex items-center justify-between">
                <Label className="font-semibold">Line items</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={async () => { await ensureAccountOptionsLoaded(); addLineItem(); }}
                >
                  <Plus className="w-3.5 h-3.5 mr-1" /> Add line
                </Button>
              </div>
              {formLineItems.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No line items — the request uses the top-level Amount above. Add a row to itemize across multiple accounts (e.g. "Internet $80, Electricity $150, Water $40").
                </p>
              ) : (
                <>
                  <div className="space-y-2">
                    {formLineItems.map((li) => (
                      <div key={li.clientId} className="grid grid-cols-12 gap-2 items-start border rounded-md p-2 bg-muted/30">
                        <Input
                          className="col-span-4"
                          placeholder="Description (e.g. Electricity)"
                          value={li.description}
                          onChange={e => updateLineItem(li.clientId, { description: e.target.value })}
                        />
                        <Input
                          className="col-span-2"
                          type="number"
                          placeholder="0.00"
                          min="0"
                          step="any"
                          value={li.amount}
                          onChange={e => updateLineItem(li.clientId, { amount: e.target.value })}
                        />
                        <Select
                          value={li.accountId | ''}
                          onValueChange={v => updateLineItem(li.clientId, { accountId: v })}
                        >
                          <SelectTrigger className="col-span-4">
                            <SelectValue placeholder="Account" />
                          </SelectTrigger>
                          <SelectContent>
                            {accountOptions.map(a => (
                              <SelectItem key={a.id} value={a.id}>
                                {a.code ? `${a.code} — ${a.name}` : a.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <div className="col-span-2 flex flex-col gap-1">
                          <label className="text-[10px] text-blue-700 underline-offset-2 hover:underline cursor-pointer">
                            <input
                              type="file"
                              multiple
                              className="hidden"
                              onChange={e => {
                                const files = Array.from(e.target.files ?? []);
                                if (files.length > 0) {
                                  updateLineItem(li.clientId, {
                                    files: [...li.files, ...files],
                                  });
                                }
                                e.target.value = '';
                              }}
                            />
                            {li.files.length > 0 ? `${li.files.length} file(s) attached` : 'Attach file…'}
                          </label>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 self-end text-destructive"
                            onClick={() => removeLineItem(li.clientId)}
                            title="Remove line"
                          >
                            <X className="w-3.5 h-3.5" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="text-sm text-right font-medium pr-2">
                    Total: <span className="font-mono">{lineItemsTotal.toFixed(2)} {formCurrency}</span>
                    {Math.abs(lineItemsTotal - (parseFloat(formAmount) | 0)) > 0.01 && parseFloat(formAmount) > 0 && (
                      <span className="text-xs text-amber-700 ml-2">
                        (overrides the "Amount" field above)
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setNewOpen(false)} disabled={formSaving}>Cancel</Button>
            <Button onClick={() => void handleCreate(false)} disabled={formSaving}>
              {formSaving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <Plus className="w-4 h-4 mr-1" />}
              Submit Request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ───── Review Request Modal ───── */}
      <Dialog open={!!reviewRow} onOpenChange={open => { if (!open) { setReviewRow(null); setRejectReason(''); } }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Review Payment Request</DialogTitle>
          </DialogHeader>
          {reviewRow && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-gray-500">Ref:</span> <span className="font-mono">{reviewRow.ref_number}</span></div>
                <div><span className="text-gray-500">Type:</span> {reviewRow.request_type}</div>
                <div><span className="text-gray-500">Payee:</span> <span className="font-medium">{reviewRow.payee | '—'}</span></div>
                <div><span className="text-gray-500">Amount:</span> <span className="font-mono">{fmtPaymentAmount(reviewRow.amount, reviewRow.currency)}</span></div>
                {reviewRow.due_date && <div><span className="text-gray-500">Due:</span> {format(new Date(reviewRow.due_date), 'MMM d, yyyy')}</div>}
                {reviewRow.vendor_ref && <div><span className="text-gray-500">Vendor Ref:</span> {reviewRow.vendor_ref}</div>}
              </div>
              {reviewRow.description && (
                <div className="text-sm p-3 bg-gray-50 rounded-md">
                  <span className="text-gray-500 block mb-1">Description:</span>
                  {reviewRow.description}
                </div>
              )}
              {(reviewRow.payee_email_snapshot | reviewRow.payee_phone_snapshot) && (
                <div className="text-xs p-2 bg-slate-50 border border-slate-200 rounded-md flex flex-wrap gap-x-4 gap-y-1">
                  {reviewRow.payee_email_snapshot && (
                    <span><span className="text-slate-500">📧 Email at creation:</span> <span className="font-mono">{reviewRow.payee_email_snapshot}</span></span>
                  )}
                  {reviewRow.payee_phone_snapshot && (
                    <span><span className="text-slate-500">📞 Phone at creation:</span> <span className="font-mono">{reviewRow.payee_phone_snapshot}</span></span>
                  )}
                </div>
              )}
              {(dialogLineItems[reviewRow.id]?.length ?? 0) > 0 && (
                <div className="border rounded-md text-sm">
                  <div className="px-3 py-1.5 bg-gray-50 border-b text-xs font-semibold text-gray-700">
                    Line items ({dialogLineItems[reviewRow.id]?.length})
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="h-8 text-[11px]">Description</TableHead>
                        <TableHead className="h-8 text-[11px]">Account</TableHead>
                        <TableHead className="h-8 text-[11px] text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dialogLineItems[reviewRow.id]?.map(li => (
                        <TableRow key={li.id}>
                          <TableCell className="py-1.5 text-xs">
                            {li.description | '—'}
                            {li.attachments.length > 0 && (
                              <Popover>
                                <PopoverTrigger asChild>
                                  <button
                                    type="button"
                                    className="ml-1 text-blue-700 hover:text-blue-900 hover:underline cursor-pointer text-xs"
                                    data-testid={`line-attachments-${li.id}`}
                                  >
                                    📎 {li.attachments.length}
                                  </button>
                                </PopoverTrigger>
                                <PopoverContent className="w-72 p-2" align="start">
                                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5 px-1">
                                    Attachments
                                  </p>
                                  <ul className="space-y-1">
                                    {li.attachments.map((a) => (
                                      <li key={a.id}>
                                        <button
                                          type="button"
                                          onClick={() => void downloadLineAttachment(a)}
                                          className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-muted/60 text-left text-xs"
                                        >
                                          <Download className="w-3.5 h-3.5 shrink-0 text-blue-700" />
                                          <span className="truncate flex-1">{a.file_name}</span>
                                          <span className="text-[10px] text-muted-foreground tabular-nums">
                                            {(a.file_size / 1024).toFixed(0)} KB
                                          </span>
                                        </button>
                                      </li>
                                    ))}
                                  </ul>
                                </PopoverContent>
                              </Popover>
                            )}
                          </TableCell>
                          <TableCell className="py-1.5 text-xs text-muted-foreground">{li.account_label}</TableCell>
                          <TableCell className="py-1.5 text-xs text-right font-mono">{fmtPaymentAmount(li.amount, reviewRow.currency)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {reviewRow.status === 'ON_HOLD' && reviewRow.rejection_reason && (
                <div className="text-sm p-3 bg-purple-50 border border-purple-200 rounded-md">
                  <span className="text-purple-700 font-medium block mb-1">On Hold:</span>
                  {reviewRow.rejection_reason}
                </div>
              )}
              <div>
                <Label>Rejection / On-Hold Reason</Label>
                <Textarea placeholder="Why is this being rejected or placed on hold?" value={rejectReason} onChange={e => setRejectReason(e.target.value)} rows={2} />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => { setReviewRow(null); setRejectReason(''); }} disabled={reviewSaving}>Cancel</Button>
            {reviewRow?.status === 'ON_HOLD' && (
              <Button
                variant="outline"
                onClick={() => reviewRow && void handleReopenFromHold(reviewRow.id)}
                disabled={reviewSaving}
                title="Move this request back to Pending."
              >
                <RotateCcw className="w-4 h-4 mr-1" /> Reopen
              </Button>
            )}
            <Button
              variant="outline"
              className="border-purple-300 text-purple-700 hover:bg-purple-50"
              onClick={() => reviewRow && void handleOnHold(reviewRow.id, rejectReason)}
              disabled={reviewSaving | !rejectReason.trim()}
              title="Pause the request (e.g. need more info). Reason required; reuses the rejection textarea."
            >
              <Clock className="w-4 h-4 mr-1" /> On Hold
            </Button>
            <Button variant="destructive" onClick={() => reviewRow && void handleReject(reviewRow.id)} disabled={reviewSaving | !rejectReason.trim()}>
              <XCircle className="w-4 h-4 mr-1" /> Reject
            </Button>
            <Button onClick={() => reviewRow && void handleApprove(reviewRow.id)} disabled={reviewSaving}>
              {reviewSaving ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : <CheckCircle className="w-4 h-4 mr-1" />}
              Approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ───── Process Payment Modal ───── */}
      <Dialog open={!!processRow} onOpenChange={open => { if (!open) setProcessRow(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Process Payment</DialogTitle>
          </DialogHeader>
          {processRow && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-gray-500">Ref:</span> <span className="font-mono">{processRow.ref_number}</span></div>
                <div><span className="text-gray-500">Status:</span> {statusBadge(processRow.status)}</div>
                <div><span className="text-gray-500">Payee:</span> <span className="font-medium">{processRow.payee | '—'}</span></div>
                <div><span className="text-gray-500">Amount:</span> <span className="font-mono">{fmtPaymentAmount(processRow.amount, processRow.currency)}</span></div>
              </div>
              {(processRow.payee_email_snapshot | processRow.payee_phone_snapshot) && (
                <div className="text-xs p-2 bg-slate-50 border border-slate-200 rounded-md flex flex-wrap gap-x-4 gap-y-1">
                  {processRow.payee_email_snapshot && (
                    <span><span className="text-slate-500">📧 Email at creation:</span> <span className="font-mono">{processRow.payee_email_snapshot}</span></span>
                  )}
                  {processRow.payee_phone_snapshot && (
                    <span><span className="text-slate-500">📞 Phone at creation:</span> <span className="font-mono">{processRow.payee_phone_snapshot}</span></span>
                  )}
                </div>
              )}
              {(dialogLineItems[processRow.id]?.length ?? 0) > 0 && (
                <div className="border rounded-md text-sm">
                  <div className="px-3 py-1.5 bg-gray-50 border-b text-xs font-semibold text-gray-700">
                    Line items ({dialogLineItems[processRow.id]?.length})
                  </div>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="h-8 text-[11px]">Description</TableHead>
                        <TableHead className="h-8 text-[11px]">Account</TableHead>
                        <TableHead className="h-8 text-[11px] text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {dialogLineItems[processRow.id]?.map(li => (
                        <TableRow key={li.id}>
                          <TableCell className="py-1.5 text-xs">
                            {li.description | '—'}
                            {li.attachments.length > 0 && (
                              <Popover>
                                <PopoverTrigger asChild>
                                  <button
                                    type="button"
                                    className="ml-1 text-blue-700 hover:text-blue-900 hover:underline cursor-pointer text-xs"
                                    data-testid={`line-attachments-${li.id}`}
                                  >
                                    📎 {li.attachments.length}
                                  </button>
                                </PopoverTrigger>
                                <PopoverContent className="w-72 p-2" align="start">
                                  <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5 px-1">
                                    Attachments
                                  </p>
                                  <ul className="space-y-1">
                                    {li.attachments.map((a) => (
                                      <li key={a.id}>
                                        <button
                                          type="button"
                                          onClick={() => void downloadLineAttachment(a)}
                                          className="w-full flex items-center gap-2 px-2 py-1 rounded hover:bg-muted/60 text-left text-xs"
                                        >
                                          <Download className="w-3.5 h-3.5 shrink-0 text-blue-700" />
                                          <span className="truncate flex-1">{a.file_name}</span>
                                          <span className="text-[10px] text-muted-foreground tabular-nums">
                                            {(a.file_size / 1024).toFixed(0)} KB
                                          </span>
                                        </button>
                                      </li>
                                    ))}
                                  </ul>
                                </PopoverContent>
                              </Popover>
                            )}
                          </TableCell>
                          <TableCell className="py-1.5 text-xs text-muted-foreground">{li.account_label}</TableCell>
                          <TableCell className="py-1.5 text-xs text-right font-mono">{fmtPaymentAmount(li.amount, processRow.currency)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              {processRow.paid_at && (
                <div className="text-sm p-3 bg-green-50 rounded-md text-green-700">
                  Paid on {format(new Date(processRow.paid_at), 'MMM d, yyyy h:mm a')}
                </div>
              )}
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setProcessRow(null)}>Close</Button>
            {processRow?.status === 'APPROVED' && (
              <Button onClick={() => processRow && void handleMarkPaid(processRow.id)}>
                <DollarSign className="w-4 h-4 mr-1" /> Mark as Paid
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ───── Rejection Details Modal ───── */}
      <Dialog open={!!rejectionRow} onOpenChange={open => { if (!open) setRejectionRow(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Rejection Details</DialogTitle>
          </DialogHeader>
          {rejectionRow && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><span className="text-gray-500">Ref:</span> <span className="font-mono">{rejectionRow.ref_number}</span></div>
                <div><span className="text-gray-500">Payee:</span> {rejectionRow.payee | '—'}</div>
                <div><span className="text-gray-500">Amount:</span> <span className="font-mono">{fmtPaymentAmount(rejectionRow.amount, rejectionRow.currency)}</span></div>
              </div>
              <div className="p-3 bg-red-50 rounded-md text-sm">
                <span className="text-red-600 font-medium block mb-1">Rejection Reason:</span>
                <span className="text-red-800">{rejectionRow.rejection_reason | 'No reason provided'}</span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectionRow(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ───── Import ───── */}
      <ImportPopup
        open={importOpen}
        onClose={() => {
          setImportOpen(false);
          void fetchPayments();
        }}
        entityName="Payment Requests"
        sampleCsvContent={PAYMENT_SAMPLE_CSV}
        sampleFileName="owb-payment-requests-sample.csv"
        columns={PAYMENT_COLUMNS}
        tips={[
          'Contact and Amount are required.',
          'Imported payments are created as Pending.',
          'Currency defaults to USD. Type defaults to Invoice.',
          'Due Date format: YYYY-MM-DD.',
        ]}
        parseCsv={parseCsvPayments}
        onImportRows={handleImportRows}
      />
    </div>
  );
}
