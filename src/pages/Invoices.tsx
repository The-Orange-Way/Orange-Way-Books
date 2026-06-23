/**
 * OWB Invoicing module — Invoices page
 *
 * AR mirror of Payments.tsx (which is AP). Lists, creates, and edits
 * customer invoices. ZKA Level 2 throughout — server cannot read
 * customer names, amounts, memos, or addresses.
 *
 * Week 1 scaffold ships: list view + filters + create/edit dialog + line
 * items + status badges. Send / PDF / hosted view ship in Week 2.
 * Deposit auto-match ships in Week 3.
 *
 * Internal design notes live alongside the module source.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { format } from 'date-fns';
import {
  Plus,
  Search,
  RefreshCw,
  Loader2,
  ArrowUpDown,
  Eye,
  X,
  CalendarIcon,
  Trash2,
  Send,
  Copy,
  Printer,
  ExternalLink,
  Check,
  DollarSign,
} from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useVault } from '@/context/VaultContext';
import { useCapability } from '@/hooks/useCapability';
import {
  encryptInvoice,
  decryptInvoice,
  encryptInvoiceLineItem,
  decryptInvoiceLineItem,
  decryptWallet,
  decryptChartOfAccount,
  type InvoiceFields,
  type InvoiceLineItemFields,
} from '@/lib/crypto-fields';
import {
  recordPlaceholderPayment,
  ArNotConfiguredWarning,
  AmountExceedsRemainingError,
} from '@/lib/invoices/recordPlaceholderPayment';
import { buildInvoiceShare, type InvoiceSharePayload } from '@/lib/invoiceShare';
import { openInvoicePrint } from '@/lib/invoicePdf';
import { useFormatCurrency } from '@/hooks/useOrgSettings';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { Checkbox } from '@/components/ui/checkbox';
import { exportToCsv } from '@/lib/exports/csv';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

// ── Email template defaults + substitution ──

const DEFAULT_INVOICE_EMAIL_BODY =
  `Hi {{customer_name}},\n\n` +
  `Your invoice {{invoice_number}} for {{amount}} is ready.\n` +
  `Due: {{due_date}}.\n\n` +
  `View and pay:\n{{share_url}}\n\n` +
  `Thanks,\n{{org_name}}\n`;

function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? vars[key] : '',
  );
}

// ── Types ──

const INVOICE_STATUSES = [
  'DRAFT',
  'SENT',
  'VIEWED',
  'PARTIAL',
  'PAID',
  'OVERDUE',
  'VOIDED',
  'WRITTEN_OFF',
] as const;
type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

interface InvoiceRow {
  id: string;
  invoice_number: string;
  status: InvoiceStatus;
  amount: number;
  currency: string;
  issue_date: string | null;
  due_date: string | null;
  sent_at: string | null;
  paid_at: string | null;
  // Decrypted display values
  customer_name: string;
  memo: string | null;
  // Original encrypted row preserved for edits
  raw: any;
}

interface LineDraft {
  id?: string;
  description: string;
  amount: string; // string for input control
  chart_of_accounts_id: string | null;
  sort_order: number;
}

interface AccountOption {
  id: string;
  name: string;
  code: string | null;
  type: string;
}

// ── Status presentation ──

function statusBadge(status: InvoiceStatus) {
  const variants: Record<InvoiceStatus, string> = {
    DRAFT: 'bg-slate-100 text-slate-700 border-slate-200',
    SENT: 'bg-blue-100 text-blue-800 border-blue-200',
    VIEWED: 'bg-indigo-100 text-indigo-800 border-indigo-200',
    PARTIAL: 'bg-amber-100 text-amber-800 border-amber-200',
    PAID: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    OVERDUE: 'bg-red-100 text-red-800 border-red-200',
    VOIDED: 'bg-zinc-100 text-zinc-600 border-zinc-200',
    WRITTEN_OFF: 'bg-purple-100 text-purple-800 border-purple-200',
  };
  return (
    <Badge variant="outline" className={cn('font-medium', variants[status])}>
      {status.replace('_', ' ')}
    </Badge>
  );
}

// ── Main page ──

interface WalletOption {
  id: string;
  name: string;
  asset: string;
  external_account_id: string | null;
}

export default function Invoices() {
  const { orgId } = useUserOrg();
  const { encryptText, decryptText, isUnlocked, loadOrgSigningKey, signMutation } = useVault();
  const { formatAmount } = useFormatCurrency();

  // I16 producer — gate the "Mark paid" affordance on payments.create
  // capability. Matches the RLS check inside the merge_invoice_payment
  // RPC so users who can't merge can't produce placeholders
  // they couldn't later reconcile.
  const canCreatePayments = useCapability('payments.create', orgId);

  // Data state
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [wallets, setWallets] = useState<WalletOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshTick, setRefreshTick] = useState(0);

  // "Record payment" placeholder dialog (I16 producer).
  const [recordPayRow, setRecordPayRow] = useState<InvoiceRow | null>(null);
  const [recordPayAmount, setRecordPayAmount] = useState('');
  const [recordPayWalletId, setRecordPayWalletId] = useState<string>('');
  const [recordPayDate, setRecordPayDate] = useState<Date>(new Date());
  const [recordPayMemo, setRecordPayMemo] = useState('');
  const [recordPaySaving, setRecordPaySaving] = useState(false);

  // Filters
  const [statusFilter, setStatusFilter] = useState<'ALL' | InvoiceStatus>('ALL');
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);

  // Sort
  const [sortBy, setSortBy] = useState<'invoice_number' | 'issue_date' | 'due_date' | 'amount'>(
    'issue_date',
  );
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Dialogs
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState<InvoiceRow | null>(null);

  // Create / edit form
  const [formCustomerName, setFormCustomerName] = useState('');
  const [formCustomerEmail, setFormCustomerEmail] = useState('');
  const [formCustomerPhone, setFormCustomerPhone] = useState('');
  const [formCustomerAddress, setFormCustomerAddress] = useState('');
  const [formCurrency, setFormCurrency] = useState('USD');
  const [formIssueDate, setFormIssueDate] = useState<Date>(new Date());
  const [formDueDate, setFormDueDate] = useState<Date | undefined>(undefined);
  const [formMemo, setFormMemo] = useState('');
  const [formInternalNotes, setFormInternalNotes] = useState('');
  const [formPaymentInstructions, setFormPaymentInstructions] = useState('');
  const [formLines, setFormLines] = useState<LineDraft[]>([
    { description: '', amount: '', chart_of_accounts_id: null, sort_order: 0 },
  ]);
  const [saving, setSaving] = useState(false);

  // Bulk-action selection state (I4 — mirrors Payments.tsx pattern).
  // Status filter is plaintext on invoices, so we can guard each handler by
  // row.status without exposing any encrypted columns. Every CSV cell is
  // sourced from already-decrypted row state — no new server-side reads.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkActing, setBulkActing] = useState(false);

  // ── Data load ──

  const load = useCallback(async () => {
    if (!orgId || !isUnlocked) return;
    setLoading(true);
    try {
      // Pull invoices
      const { data: rows, error } = await (supabase as any)
        .from('invoices')
        .select('*')
        .eq('org_id', orgId)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;

      // Decrypt customer-facing fields (failsafe per row)
      const decrypted: InvoiceRow[] = await Promise.all(
        (rows ?? []).map(async (r: any) => {
          let dec: InvoiceFields | null = null;
          try {
            dec = await decryptInvoice(r, decryptText);
          } catch (err) {
            console.warn('[invoices] decrypt failed', r.id, err);
          }
          return {
            id: r.id,
            invoice_number: r.invoice_number,
            status: r.status as InvoiceStatus,
            amount: dec?.amount ?? r.amount ?? 0,
            currency: r.currency,
            issue_date: r.issue_date,
            due_date: r.due_date,
            sent_at: r.sent_at,
            paid_at: r.paid_at,
            customer_name: dec?.customer_name ?? '[Decryption failed]',
            memo: dec?.memo ?? null,
            raw: r,
          };
        }),
      );
      setInvoices(decrypted);

      // Pull accounts for per-line GL routing (Income accounts only). Columns
      // `encrypted_account_name/code/type` were never created — the canonical
      // schema uses `account_name`/`account_code`/`account_type` (plaintext)
      // plus an optional `encrypted_name` blob for vault-encrypted display.
      // Reuse decryptChartOfAccount so legacy + encrypted rows both work.
      const { data: acctRows } = await (supabase as any)
        .from('chart_of_accounts')
        .select('*')
        .eq('org_id', orgId);
      const decAccounts: AccountOption[] = await Promise.all(
        (acctRows ?? []).map(async (a: any) => {
          const fields = await decryptChartOfAccount(a, decryptText);
          return {
            id: a.id,
            name: fields.account_name || '',
            code: fields.account_code || null,
            type: fields.account_type || '',
          };
        }),
      );
      // Filter to revenue accounts for invoice line routing (Income type)
      setAccounts(decAccounts.filter((a) => a.type === 'Income'));

      // Pull wallets for the "Record payment" placeholder dialog. We
      // surface every account so the operator can pick whichever account
      // the customer paid to (BTC, fiat, etc.). Each wallet's
      // external_account_id drives the Dr leg of the auto-posted JE.
      const { data: walletRows } = await (supabase as any)
        .from('accounts')
        .select('id, encrypted_name, asset, key_version, external_account_id')
        .eq('org_id', orgId);
      const decWallets: WalletOption[] = await Promise.all(
        ((walletRows ?? []) as any[]).map(async (w) => {
          const fields = await decryptWallet(w, decryptText).catch(() => null);
          return {
            id: w.id,
            name: (fields?.encrypted_name as string | null) ?? '[?]',
            asset: (fields?.asset as string | null) ?? w.asset ?? '',
            external_account_id: w.external_account_id ?? null,
          };
        }),
      );
      setWallets(decWallets);
    } catch (err) {
      console.error('[invoices] load failed', err);
      toast.error(err instanceof Error ? err.message : 'Failed to load invoices');
    } finally {
      setLoading(false);
    }
  }, [orgId, isUnlocked, decryptText, refreshTick]);

  useEffect(() => {
    void load();
  }, [load]);

  // ── Filtering + sorting ──

  const filtered = useMemo(() => {
    let rows = invoices;
    if (statusFilter !== 'ALL') {
      rows = rows.filter((r) => r.status === statusFilter);
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rows = rows.filter(
        (r) =>
          r.invoice_number.toLowerCase().includes(q) ||
          r.customer_name.toLowerCase().includes(q) ||
          (r.memo ?? '').toLowerCase().includes(q),
      );
    }
    if (dateFrom) {
      rows = rows.filter((r) => r.issue_date && r.issue_date >= format(dateFrom, 'yyyy-MM-dd'));
    }
    if (dateTo) {
      rows = rows.filter((r) => r.issue_date && r.issue_date <= format(dateTo, 'yyyy-MM-dd'));
    }
    return [...rows].sort((a, b) => {
      let cmp = 0;
      if (sortBy === 'invoice_number') cmp = a.invoice_number.localeCompare(b.invoice_number);
      else if (sortBy === 'amount') cmp = a.amount - b.amount;
      else {
        const av = sortBy === 'issue_date' ? a.issue_date : a.due_date;
        const bv = sortBy === 'issue_date' ? b.issue_date : b.due_date;
        if (av && bv) cmp = av.localeCompare(bv);
        else if (av) cmp = -1;
        else if (bv) cmp = 1;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [invoices, statusFilter, search, dateFrom, dateTo, sortBy, sortDir]);

  // ── Tab counts ──

  const counts = useMemo(() => {
    const c: Record<'ALL' | InvoiceStatus, number> = {
      ALL: invoices.length,
      DRAFT: 0,
      SENT: 0,
      VIEWED: 0,
      PARTIAL: 0,
      PAID: 0,
      OVERDUE: 0,
      VOIDED: 0,
      WRITTEN_OFF: 0,
    };
    invoices.forEach((r) => {
      c[r.status] += 1;
    });
    return c;
  }, [invoices]);

  // ── Form helpers ──

  const resetForm = () => {
    setFormCustomerName('');
    setFormCustomerEmail('');
    setFormCustomerPhone('');
    setFormCustomerAddress('');
    setFormCurrency('USD');
    setFormIssueDate(new Date());
    setFormDueDate(undefined);
    setFormMemo('');
    setFormInternalNotes('');
    setFormPaymentInstructions('');
    setFormLines([{ description: '', amount: '', chart_of_accounts_id: null, sort_order: 0 }]);
  };

  const formTotal = useMemo(() => {
    return formLines.reduce((acc, l) => acc + (parseFloat(l.amount) || 0), 0);
  }, [formLines]);

  const addLine = () => {
    setFormLines((ls) => [
      ...ls,
      { description: '', amount: '', chart_of_accounts_id: null, sort_order: ls.length },
    ]);
  };
  const removeLine = (i: number) => {
    setFormLines((ls) =>
      ls.filter((_, idx) => idx !== i).map((l, idx) => ({ ...l, sort_order: idx })),
    );
  };
  const updateLine = (i: number, patch: Partial<LineDraft>) => {
    setFormLines((ls) => ls.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  };

  // ── Save (create or update) ──

  const handleSave = async (asDraft: boolean) => {
    if (!orgId) return;
    if (!formCustomerName.trim()) {
      toast.error('Customer name is required');
      return;
    }
    if (formLines.length === 0 || formLines.every((l) => !l.description.trim() && !l.amount)) {
      toast.error('Add at least one line item');
      return;
    }
    setSaving(true);
    try {
      // Mint a fresh invoice number from the RPC (atomic + auth-scoped)
      let invoice_number: string;
      if (editOpen) {
        invoice_number = editOpen.invoice_number;
      } else {
        const { data: numRes, error: numErr } = await (supabase as any).rpc('next_invoice_number', {
          p_org_id: orgId,
        });
        if (numErr) throw new Error(`Couldn't mint invoice number: ${numErr.message}`);
        invoice_number = numRes as string;
      }

      const {
        data: { user },
      } = await supabase.auth.getUser();
      const issue_date_iso = format(formIssueDate, 'yyyy-MM-dd');
      const due_date_iso = formDueDate ? format(formDueDate, 'yyyy-MM-dd') : null;

      const enc = await encryptInvoice(
        {
          customer_name: formCustomerName,
          customer_email_snapshot: formCustomerEmail || null,
          customer_phone_snapshot: formCustomerPhone || null,
          customer_address: formCustomerAddress || null,
          memo: formMemo || null,
          internal_notes: formInternalNotes || null,
          payment_instructions: formPaymentInstructions || null,
          void_reason: null,
          write_off_reason: null,
          amount: formTotal,
        },
        encryptText,
      );

      const insertRow: any = {
        ...enc,
        org_id: orgId,
        created_by: user?.id ?? null,
        invoice_number,
        status: asDraft ? 'DRAFT' : 'SENT',
        amount: formTotal, // plaintext-for-filter mirror
        currency: formCurrency,
        issue_date: issue_date_iso,
        due_date: due_date_iso,
        sent_at: asDraft ? null : new Date().toISOString(),
      };

      let invoiceId: string;
      if (editOpen) {
        const { error } = await (supabase as any)
          .from('invoices')
          .update(insertRow)
          .eq('id', editOpen.id);
        if (error) throw error;
        invoiceId = editOpen.id;
        // Replace line items for simplicity in the scaffold; Week 2 will do
        // a real diff to preserve attachments.
        await (supabase as any).from('invoice_line_items').delete().eq('invoice_id', invoiceId);
      } else {
        const { data, error } = await (supabase as any)
          .from('invoices')
          .insert(insertRow)
          .select('id')
          .single();
        if (error) throw error;
        invoiceId = (data as any).id;
      }

      // Insert line items
      for (const l of formLines) {
        if (!l.description.trim() && !l.amount) continue;
        const lineEnc = await encryptInvoiceLineItem(
          {
            description: l.description,
            amount: parseFloat(l.amount) || 0,
            quantity: null,
            unit_price: null,
            chart_of_accounts_id: l.chart_of_accounts_id,
            sort_order: l.sort_order,
          },
          encryptText,
        );
        await (supabase as any).from('invoice_line_items').insert({
          ...lineEnc,
          invoice_id: invoiceId,
        });
      }

      toast.success(
        editOpen ? `Invoice ${invoice_number} updated` : `Invoice ${invoice_number} created`,
      );
      setCreateOpen(false);
      setEditOpen(null);
      resetForm();
      setRefreshTick((t) => t + 1);
    } catch (err) {
      console.error('[invoices] save failed', err);
      toast.error(err instanceof Error ? err.message : 'Failed to save invoice');
    } finally {
      setSaving(false);
    }
  };

  // ── Void / delete ──

  // ── Send / generate share link ──
  const [shareDialog, setShareDialog] = useState<{ row: InvoiceRow; url: string } | null>(null);
  const [shareCopied, setShareCopied] = useState(false);
  const [sharePayload, setSharePayload] = useState<InvoiceSharePayload | null>(null);
  const [orgPublicName, setOrgPublicName] = useState<string | null>(null);
  const [emailSubjectTemplate, setEmailSubjectTemplate] = useState<string | null>(null);
  const [emailBodyTemplate, setEmailBodyTemplate] = useState<string | null>(null);

  // Email form state — populated when the Share dialog opens.
  const [emailTo, setEmailTo] = useState('');
  const [emailSubject, setEmailSubject] = useState('');
  const [emailBody, setEmailBody] = useState('');
  const [emailSending, setEmailSending] = useState(false);
  const [emailSentAt, setEmailSentAt] = useState<Date | null>(null);

  // Pull org public name + email templates once.
  useEffect(() => {
    if (!orgId) return;
    (async () => {
      const { data } = await (supabase as any)
        .from('org_settings')
        .select('public_org_name, invoice_email_subject_template, invoice_email_body_template')
        .eq('org_id', orgId)
        .maybeSingle();
      setOrgPublicName((data as any)?.public_org_name ?? null);
      setEmailSubjectTemplate((data as any)?.invoice_email_subject_template ?? null);
      setEmailBodyTemplate((data as any)?.invoice_email_body_template ?? null);
    })();
  }, [orgId]);

  const handleSend = async (row: InvoiceRow) => {
    if (!orgId) return;
    try {
      // 1. Decrypt the full invoice including line items
      const inv = await decryptInvoice(row.raw, decryptText);
      const { data: rawLines } = await (supabase as any)
        .from('invoice_line_items')
        .select('*')
        .eq('invoice_id', row.id)
        .order('sort_order');
      const decLines = await Promise.all(
        (rawLines ?? []).map(async (l: any) => {
          const d = await decryptInvoiceLineItem(l, decryptText);
          return {
            description: d.description ?? '',
            amount: d.amount ?? 0,
            quantity: d.quantity,
            unit_price: d.unit_price,
          };
        }),
      );

      // 2. Build the payload + encrypt under a fresh per-share key
      const payload: InvoiceSharePayload = {
        invoice_number: row.invoice_number,
        status: 'SENT',
        currency: row.currency,
        amount: inv.amount,
        issue_date: row.issue_date,
        due_date: row.due_date,
        customer_name: inv.customer_name ?? '',
        customer_email: inv.customer_email_snapshot,
        customer_phone: inv.customer_phone_snapshot,
        customer_address: inv.customer_address,
        memo: inv.memo,
        payment_instructions: inv.payment_instructions,
        lines: decLines,
      };
      const baseUrl = window.location.origin;
      const share = await buildInvoiceShare(payload, baseUrl);

      // 3. Persist (encrypted blob + url id + status SENT)
      const now = new Date();
      const expires = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000); // 90 days
      const { error } = await (supabase as any)
        .from('invoices')
        .update({
          status: row.status === 'DRAFT' ? 'SENT' : row.status,
          sent_at: row.sent_at ?? now.toISOString(),
          public_url_id: share.publicUrlId,
          encrypted_share_blob: share.encryptedShareBlob,
          public_share_created_at: now.toISOString(),
          public_share_expires_at: expires.toISOString(),
        })
        .eq('id', row.id);
      if (error) throw error;

      setShareDialog({ row, url: share.shareUrl });
      setSharePayload(payload);
      setShareCopied(false);
      setEmailSentAt(null);

      // Prefill the email form with the customer's email + the org's
      // template substitutions. Falls back to sensible defaults so the
      // operator can send without configuring templates first.
      const vars = {
        customer_name: payload.customer_name || 'there',
        invoice_number: payload.invoice_number,
        amount: formatAmount(payload.amount, payload.currency),
        currency: payload.currency,
        due_date: payload.due_date ? format(new Date(payload.due_date), 'PP') : 'on receipt',
        share_url: share.shareUrl,
        org_name: orgPublicName || 'Orange Way Books',
        memo: payload.memo ?? '',
      };
      setEmailTo(payload.customer_email ?? '');
      setEmailSubject(
        renderTemplate(
          emailSubjectTemplate ?? `Invoice ${vars.invoice_number} from {{org_name}}`,
          vars,
        ),
      );
      setEmailBody(renderTemplate(emailBodyTemplate ?? DEFAULT_INVOICE_EMAIL_BODY, vars));

      toast.success(`Share link ready for ${row.invoice_number}`);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      console.error('[invoices] send failed', err);
      toast.error(err instanceof Error ? err.message : 'Send failed');
    }
  };

  const handleSendEmail = async () => {
    if (!shareDialog) return;
    if (!emailTo.trim()) {
      toast.error('Recipient email is required');
      return;
    }
    setEmailSending(true);
    try {
      const { data, error } = await (supabase.functions as any).invoke('send-invoice-email', {
        body: {
          invoice_id: shareDialog.row.id,
          to: emailTo.trim(),
          subject: emailSubject,
          body_text: emailBody,
        },
      });
      if (error) throw error;
      if (!(data as any)?.sent) throw new Error((data as any)?.error ?? 'Send failed');
      setEmailSentAt(new Date());
      toast.success(`Sent to ${emailTo.trim()}`);
    } catch (err) {
      console.error('[invoices] email send failed', err);
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err && 'message' in err
            ? String((err as { message: unknown }).message)
            : 'Email failed';
      toast.error(msg);
    } finally {
      setEmailSending(false);
    }
  };

  const handleCopyShare = async () => {
    if (!shareDialog) return;
    try {
      await navigator.clipboard.writeText(shareDialog.url);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const handlePrintFromShare = () => {
    if (!sharePayload) return;
    try {
      openInvoicePrint(sharePayload, { orgPublicName });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Print failed');
    }
  };

  const handleVoid = async (row: InvoiceRow) => {
    if (
      !window.confirm(
        `Void invoice ${row.invoice_number}? This preserves it for audit but marks it cancelled.`,
      )
    )
      return;
    const reason = window.prompt('Reason (audit-logged):') ?? '';
    try {
      const enc = await encryptText(reason);
      const { error } = await (supabase as any)
        .from('invoices')
        .update({
          status: 'VOIDED',
          encrypted_void_reason: enc,
          voided_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      if (error) throw error;
      toast.success(`Invoice ${row.invoice_number} voided`);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Void failed');
    }
  };

  const handleDelete = async (row: InvoiceRow) => {
    if (row.status !== 'DRAFT' && row.status !== 'VOIDED') {
      toast.error('Only DRAFT or VOIDED invoices can be deleted');
      return;
    }
    if (!window.confirm(`Delete invoice ${row.invoice_number}? This cannot be undone.`)) return;
    try {
      const { error } = await (supabase as any).from('invoices').delete().eq('id', row.id);
      if (error) throw error;
      toast.success('Invoice deleted');
      setRefreshTick((t) => t + 1);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  // ── Mark invoice paid → placeholder invoice_payments row (I16) ──
  //
  // Producer end of the merge UX. Inserts a placeholder
  // invoice_payments row (anchored to a synthetic transactions row) so
  // the invoice flips PARTIAL/PAID immediately and the JE posts. Later,
  // when the real bank deposit lands, the InvoiceMatchPanel offers to
  // MERGE the placeholder + deposit into one canonical record.

  const recordPayStatusesAllowed: InvoiceStatus[] = ['SENT', 'VIEWED', 'PARTIAL', 'OVERDUE'];

  // Sum of placeholder + applied payments already recorded against an
  // invoice. Used to default the dialog's amount to the remaining
  // balance — the operator rarely needs anything else.
  const [recordPayRemaining, setRecordPayRemaining] = useState<number>(0);

  const openRecordPay = async (row: InvoiceRow) => {
    // Pull current sum of applied (encrypted-mirror plaintext column)
    // so we can default the input to remaining = invoice.amount − sum.
    let applied = 0;
    try {
      const { data: paymentRows } = await (supabase as any)
        .from('invoice_payments')
        .select('amount_applied')
        .eq('invoice_id', row.id);
      applied = ((paymentRows ?? []) as Array<{ amount_applied: number }>).reduce(
        (acc, r) => acc + Number(r.amount_applied ?? 0),
        0,
      );
    } catch (err) {
      console.warn('[invoices] remaining-balance lookup failed', err);
    }
    const remaining = Math.max(0, row.amount - applied);
    setRecordPayRemaining(remaining);
    setRecordPayAmount(remaining > 0 ? String(remaining) : String(row.amount));
    // Default wallet: first wallet whose asset matches the invoice
    // currency, else the first wallet.
    const matchAsset = wallets.find((w) => w.asset?.toUpperCase() === row.currency.toUpperCase());
    setRecordPayWalletId((matchAsset ?? wallets[0])?.id ?? '');
    setRecordPayDate(new Date());
    setRecordPayMemo('');
    setRecordPayRow(row);
  };

  const handleRecordPay = async () => {
    if (!recordPayRow || !orgId) return;
    const amt = parseFloat(recordPayAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error('Amount must be a positive number');
      return;
    }
    if (!recordPayWalletId) {
      toast.error('Pick the wallet that received the payment');
      return;
    }
    const wallet = wallets.find((w) => w.id === recordPayWalletId);
    if (!wallet) {
      toast.error('Selected wallet not found');
      return;
    }
    setRecordPaySaving(true);
    try {
      const result = await recordPlaceholderPayment({
        invoiceId: recordPayRow.id,
        amount: amt,
        walletId: wallet.id,
        walletLegacyAccountId: wallet.external_account_id,
        asset: wallet.asset || recordPayRow.currency,
        appliedAt: format(recordPayDate, 'yyyy-MM-dd'),
        memo: recordPayMemo.trim() || null,
        orgId,
        invoiceAmount: recordPayRow.amount,
        invoiceNumber: recordPayRow.invoice_number,
        encryptText,
        decryptText,
        loadOrgSigningKey,
        signMutation,
      });

      if (result.reused) {
        toast.message(
          `Payment already recorded — invoice ${recordPayRow.invoice_number} is ${result.invoiceStatus.toLowerCase()}.`,
        );
      } else if (result.warnArMissing) {
        // Surface the A/R warning loud-but-recoverable: the row is
        // there, the merge will still work, but no JE posted.
        toast.warning(
          `Payment recorded on ${recordPayRow.invoice_number}, but no A/R account is set. ` +
            'Configure A/R in Settings so the journal entry can post.',
          { duration: 8000 },
        );
      } else {
        toast.success(
          `Recorded ${formatAmount(amt, recordPayRow.currency)} on ${recordPayRow.invoice_number}` +
            (result.jePosted ? ' — JE posted.' : '.'),
        );
      }
      setRecordPayRow(null);
      setRefreshTick((t) => t + 1);
    } catch (err) {
      if (err instanceof AmountExceedsRemainingError) {
        toast.error(err.message);
      } else if (err instanceof ArNotConfiguredWarning) {
        toast.warning(err.message);
      } else {
        console.error('[invoices] record-payment failed', err);
        toast.error(err instanceof Error ? err.message : 'Mark paid failed');
      }
    } finally {
      setRecordPaySaving(false);
    }
  };

  // ── Open edit dialog (loads decrypted line items) ──

  const openEdit = async (row: InvoiceRow) => {
    const dec = await decryptInvoice(row.raw, decryptText).catch(() => null);
    if (!dec) {
      toast.error('Could not decrypt invoice');
      return;
    }
    setFormCustomerName(dec.customer_name ?? '');
    setFormCustomerEmail(dec.customer_email_snapshot ?? '');
    setFormCustomerPhone(dec.customer_phone_snapshot ?? '');
    setFormCustomerAddress(dec.customer_address ?? '');
    setFormCurrency(row.currency);
    setFormIssueDate(row.issue_date ? new Date(row.issue_date) : new Date());
    setFormDueDate(row.due_date ? new Date(row.due_date) : undefined);
    setFormMemo(dec.memo ?? '');
    setFormInternalNotes(dec.internal_notes ?? '');
    setFormPaymentInstructions(dec.payment_instructions ?? '');

    // Load + decrypt line items
    const { data: rawLines } = await (supabase as any)
      .from('invoice_line_items')
      .select('*')
      .eq('invoice_id', row.id)
      .order('sort_order');
    const decLines: LineDraft[] = await Promise.all(
      (rawLines ?? []).map(async (l: any, idx: number) => {
        const d = await decryptInvoiceLineItem(l, decryptText);
        return {
          id: l.id,
          description: d.description ?? '',
          amount: String(d.amount ?? 0),
          chart_of_accounts_id: d.chart_of_accounts_id,
          sort_order: idx,
        };
      }),
    );
    setFormLines(
      decLines.length
        ? decLines
        : [{ description: '', amount: '', chart_of_accounts_id: null, sort_order: 0 }],
    );
    setEditOpen(row);
  };

  // ── Selection + bulk actions (I4) ──
  //
  // Mirrors the Transactions / Payments bulk-action pattern. Each handler
  // iterates the selected set and only acts on rows whose plaintext status
  // is compatible with the action (Send → DRAFT only, Void → not VOIDED /
  // PAID / WRITTEN_OFF). Incompatible rows are silently skipped; the toast
  // reports how many actually moved. CSV export operates on the currently
  // filtered view (already decrypted, browser-side only — no encrypted
  // columns ever leave the org's encryption boundary).

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = (pageIds: string[]) => {
    setSelected((prev) => {
      const allOnPage = pageIds.length > 0 && pageIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allOnPage) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  };

  const handleBulkSend = async () => {
    if (selected.size === 0) return;
    setBulkActing(true);
    let moved = 0;
    try {
      for (const id of selected) {
        const row = invoices.find((r) => r.id === id);
        if (!row || row.status !== 'DRAFT') continue;
        try {
          await handleSend(row);
          moved += 1;
        } catch (err) {
          console.warn('[invoices] bulk send skipped', id, err);
        }
      }
      toast.success(`${moved} invoice${moved === 1 ? '' : 's'} sent`);
      setSelected(new Set());
    } finally {
      setBulkActing(false);
    }
  };

  const handleBulkVoid = async () => {
    if (selected.size === 0) return;
    if (
      !window.confirm(`Void ${selected.size} selected invoice(s)? This preserves them for audit.`)
    )
      return;
    setBulkActing(true);
    let moved = 0;
    try {
      // Single encryption of a shared bulk reason — ZKA invariant preserved
      // (server still sees ciphertext only).
      const enc = await encryptText('Bulk void');
      const nowIso = new Date().toISOString();
      for (const id of selected) {
        const row = invoices.find((r) => r.id === id);
        if (!row) continue;
        if (row.status === 'VOIDED' || row.status === 'PAID' || row.status === 'WRITTEN_OFF')
          continue;
        const { error } = await (supabase as any)
          .from('invoices')
          .update({ status: 'VOIDED', encrypted_void_reason: enc, voided_at: nowIso })
          .eq('id', id);
        if (!error) moved += 1;
      }
      toast.success(`${moved} invoice${moved === 1 ? '' : 's'} voided`);
      setSelected(new Set());
      setRefreshTick((t) => t + 1);
    } finally {
      setBulkActing(false);
    }
  };

  const handleBulkExportCsv = () => {
    const targets = selected.size > 0 ? filtered.filter((r) => selected.has(r.id)) : filtered;
    if (targets.length === 0) {
      toast.error('Nothing to export.');
      return;
    }
    const headers = [
      'Invoice #',
      'Status',
      'Issue date',
      'Due date',
      'Customer',
      'Currency',
      'Amount',
      'Sent at',
      'Paid at',
    ];
    const rows = targets.map((r) => [
      r.invoice_number,
      r.status,
      r.issue_date ?? '',
      r.due_date ?? '',
      r.customer_name,
      r.currency,
      r.amount,
      r.sent_at ?? '',
      r.paid_at ?? '',
    ]);
    exportToCsv(`owb-invoices-${format(new Date(), 'yyyy-MM-dd')}`, headers, rows);
    toast.success(`Exported ${targets.length} invoice${targets.length === 1 ? '' : 's'} to CSV.`);
  };

  // ── Render ──

  if (!isUnlocked) {
    return (
      <div className="p-6">
        <div className="max-w-2xl rounded-lg border border-border bg-card p-5">
          <p className="text-sm text-muted-foreground">Unlock your vault to view invoices.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Invoices</h1>
          <p className="text-sm text-muted-foreground">
            Bill your customers — zero-knowledge end-to-end.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleBulkExportCsv}
            data-testid="invoice-export-csv"
            disabled={filtered.length === 0}
            title="Export current view to CSV"
          >
            Export CSV
          </Button>
          <Button
            onClick={() => {
              resetForm();
              setCreateOpen(true);
            }}
            data-testid="new-invoice-button"
          >
            <Plus className="w-4 h-4 mr-1" /> New invoice
          </Button>
        </div>
      </div>

      {/* Status filter buttons */}
      <div className="flex flex-wrap gap-2" data-testid="invoice-status-filter">
        {(['ALL', ...INVOICE_STATUSES] as Array<'ALL' | InvoiceStatus>).map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            className={cn(
              'px-3 py-1.5 text-sm rounded-md border transition-colors',
              statusFilter === s
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-card text-muted-foreground border-border hover:border-primary/40',
            )}
          >
            {s === 'ALL' ? 'All' : s.replace('_', ' ')}
            <span className="ml-1.5 text-xs opacity-70">{counts[s]}</span>
          </button>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search invoice #, customer, memo…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
            data-testid="invoice-search"
          />
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <CalendarIcon className="w-4 h-4 mr-1" />
              {dateFrom && dateTo
                ? `${format(dateFrom, 'MMM d')} – ${format(dateTo, 'MMM d')}`
                : dateFrom
                  ? `From ${format(dateFrom, 'MMM d')}`
                  : 'Date range'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="range"
              selected={{ from: dateFrom, to: dateTo }}
              onSelect={(r) => {
                setDateFrom(r?.from);
                setDateTo(r?.to);
              }}
              initialFocus
            />
            <div className="p-2 border-t flex justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setDateFrom(undefined);
                  setDateTo(undefined);
                }}
              >
                <X className="w-3 h-3 mr-1" /> Clear
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <Button variant="ghost" size="sm" onClick={() => setRefreshTick((t) => t + 1)}>
          <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
        </Button>
      </div>

      {/* Bulk-action bar (I4) — appears when at least one row is selected.
          Per-status guards inside the handlers mean clicking "Send" with a
          non-DRAFT row in selection just silently skips it. */}
      {selected.size > 0 && (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm"
          data-testid="invoice-bulk-bar"
        >
          <span className="font-medium text-blue-900">{selected.size} selected</span>
          <Button
            variant="outline"
            size="sm"
            className="border-blue-300 text-blue-700 hover:bg-blue-50"
            disabled={bulkActing}
            onClick={() => void handleBulkSend()}
            data-testid="invoice-bulk-send"
          >
            <Send className="w-3.5 h-3.5 mr-1" /> Send drafts
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="border-gray-300 text-gray-700 hover:bg-gray-50"
            disabled={bulkActing}
            onClick={() => void handleBulkVoid()}
            data-testid="invoice-bulk-void"
          >
            <X className="w-3.5 h-3.5 mr-1" /> Void
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={bulkActing}
            onClick={handleBulkExportCsv}
            data-testid="invoice-bulk-export"
          >
            Export CSV
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

      {/* Table */}
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading invoices…
        </div>
      ) : filtered.length === 0 ? (
        <div
          className="rounded-lg border border-dashed border-border p-12 text-center"
          data-testid="invoice-empty-state"
        >
          <p className="text-sm font-medium">No invoices yet</p>
          <p className="text-xs text-muted-foreground mt-1 mb-4">
            Bill your first customer — zero-knowledge end-to-end.
          </p>
          <Button
            onClick={() => {
              resetForm();
              setCreateOpen(true);
            }}
            data-testid="invoice-empty-cta"
          >
            <Plus className="w-4 h-4 mr-1" /> Create your first invoice
          </Button>
        </div>
      ) : (
        <>
          {/* Desktop / tablet table (>= md). Card list below covers mobile. */}
          <Table className="hidden md:table">
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={filtered.length > 0 && filtered.every((r) => selected.has(r.id))}
                    onCheckedChange={() => toggleSelectAll(filtered.map((r) => r.id))}
                    aria-label="Select all rows"
                    data-testid="invoice-select-all"
                  />
                </TableHead>
                <TableHead
                  className="cursor-pointer"
                  onClick={() => {
                    setSortBy('invoice_number');
                    setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                  }}
                >
                  Invoice # <ArrowUpDown className="inline w-3 h-3 opacity-60" />
                </TableHead>
                <TableHead
                  className="cursor-pointer"
                  onClick={() => {
                    setSortBy('issue_date');
                    setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                  }}
                >
                  Issued
                </TableHead>
                <TableHead>Customer</TableHead>
                <TableHead
                  className="cursor-pointer"
                  onClick={() => {
                    setSortBy('due_date');
                    setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                  }}
                >
                  Due
                </TableHead>
                <TableHead
                  className="cursor-pointer text-right"
                  onClick={() => {
                    setSortBy('amount');
                    setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                  }}
                >
                  Amount
                </TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-32 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => (
                <TableRow key={row.id} data-testid="invoice-row">
                  <TableCell onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected.has(row.id)}
                      onCheckedChange={() => toggleSelect(row.id)}
                      aria-label={`Select invoice ${row.invoice_number}`}
                      data-testid={`invoice-select-${row.invoice_number}`}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.invoice_number}</TableCell>
                  <TableCell className="text-xs">{row.issue_date ?? '—'}</TableCell>
                  <TableCell className="text-sm">{row.customer_name}</TableCell>
                  <TableCell className="text-xs">{row.due_date ?? '—'}</TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {formatAmount(row.amount, row.currency)}
                  </TableCell>
                  <TableCell>{statusBadge(row.status)}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void openEdit(row)}
                      title="View / edit"
                    >
                      <Eye className="w-3.5 h-3.5" />
                    </Button>
                    {row.status !== 'VOIDED' && row.status !== 'WRITTEN_OFF' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleSend(row)}
                        title={row.status === 'DRAFT' ? 'Send' : 'Get new share link'}
                        data-testid="invoice-send-button"
                      >
                        <Send className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    {canCreatePayments && recordPayStatusesAllowed.includes(row.status) && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void openRecordPay(row)}
                        title="Mark paid (records a placeholder payment)"
                        data-testid="invoice-mark-paid-button"
                      >
                        <DollarSign className="w-3.5 h-3.5 text-emerald-600" />
                      </Button>
                    )}
                    {row.status !== 'VOIDED' && row.status !== 'PAID' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void handleVoid(row)}
                        title="Void"
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    )}
                    {row.status === 'DRAFT' ||
                      (row.status === 'VOIDED' && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void handleDelete(row)}
                          title="Delete"
                        >
                          <Trash2 className="w-3.5 h-3.5 text-destructive" />
                        </Button>
                      ))}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {/* Mobile: card list (< md). Tap row body opens view/edit. */}
          <div className="md:hidden space-y-2">
            {filtered.map((row) => (
              <div
                key={row.id}
                className="bg-card border border-border rounded-lg p-3 cursor-pointer active:bg-muted/40"
                onClick={() => void openEdit(row)}
                data-testid="invoice-row-mobile"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2 min-w-0 flex-1">
                    <div onClick={(e) => e.stopPropagation()} className="pt-0.5">
                      <Checkbox
                        checked={selected.has(row.id)}
                        onCheckedChange={() => toggleSelect(row.id)}
                        aria-label={`Select invoice ${row.invoice_number}`}
                        data-testid={`invoice-select-mobile-${row.invoice_number}`}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="font-mono">{row.invoice_number}</span>
                        {statusBadge(row.status)}
                      </div>
                      <div className="mt-1 text-sm truncate">{row.customer_name}</div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        Issued {row.issue_date ?? '—'} · Due {row.due_date ?? '—'}
                      </div>
                    </div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-mono text-sm tabular-nums">
                      {formatAmount(row.amount, row.currency)}
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => void openEdit(row)}
                    title="View / edit"
                  >
                    <Eye className="w-3.5 h-3.5" />
                  </Button>
                  {row.status !== 'VOIDED' && row.status !== 'WRITTEN_OFF' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => void handleSend(row)}
                      title={row.status === 'DRAFT' ? 'Send' : 'Get new share link'}
                      data-testid="invoice-send-button"
                    >
                      <Send className="w-3.5 h-3.5" />
                    </Button>
                  )}
                  {canCreatePayments && recordPayStatusesAllowed.includes(row.status) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => void openRecordPay(row)}
                      title="Mark paid"
                      data-testid="invoice-mark-paid-button"
                    >
                      <DollarSign className="w-3.5 h-3.5 text-emerald-600" />
                    </Button>
                  )}
                  {row.status !== 'VOIDED' && row.status !== 'PAID' && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => void handleVoid(row)}
                      title="Void"
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  )}
                  {row.status === 'DRAFT' ||
                    (row.status === 'VOIDED' && (
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => void handleDelete(row)}
                        title="Delete"
                      >
                        <Trash2 className="w-3.5 h-3.5 text-destructive" />
                      </Button>
                    ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Create / edit dialog */}
      <Dialog
        open={createOpen || editOpen !== null}
        onOpenChange={(o) => {
          if (!o) {
            setCreateOpen(false);
            setEditOpen(null);
            resetForm();
          }
        }}
      >
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editOpen ? `Edit invoice ${editOpen.invoice_number}` : 'New invoice'}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            {/* Customer block */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Customer name *</Label>
                <Input
                  value={formCustomerName}
                  onChange={(e) => setFormCustomerName(e.target.value)}
                  data-testid="invoice-customer-name"
                />
              </div>
              <div>
                <Label>Email</Label>
                <Input
                  value={formCustomerEmail}
                  onChange={(e) => setFormCustomerEmail(e.target.value)}
                  type="email"
                />
              </div>
              <div>
                <Label>Phone</Label>
                <Input
                  value={formCustomerPhone}
                  onChange={(e) => setFormCustomerPhone(e.target.value)}
                />
              </div>
              <div>
                <Label>Currency</Label>
                <Select value={formCurrency} onValueChange={setFormCurrency}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'BTC'].map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="col-span-2">
                <Label>Billing address</Label>
                <Textarea
                  rows={2}
                  value={formCustomerAddress}
                  onChange={(e) => setFormCustomerAddress(e.target.value)}
                />
              </div>
            </div>

            {/* Dates */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Issue date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-start">
                      <CalendarIcon className="w-4 h-4 mr-2" />
                      {format(formIssueDate, 'PPP')}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={formIssueDate}
                      onSelect={(d) => d && setFormIssueDate(d)}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
              <div>
                <Label>Due date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="outline" className="w-full justify-start">
                      <CalendarIcon className="w-4 h-4 mr-2" />
                      {formDueDate ? format(formDueDate, 'PPP') : 'No due date'}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0">
                    <Calendar
                      mode="single"
                      selected={formDueDate}
                      onSelect={setFormDueDate}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            {/* Line items */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <Label>Line items</Label>
                <Button type="button" variant="ghost" size="sm" onClick={addLine}>
                  <Plus className="w-3 h-3 mr-1" /> Add line
                </Button>
              </div>
              <div className="space-y-2">
                {formLines.map((l, i) => (
                  <div key={i} className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-5">
                      <Input
                        placeholder="Description"
                        value={l.description}
                        onChange={(e) => updateLine(i, { description: e.target.value })}
                      />
                    </div>
                    <div className="col-span-3">
                      <Select
                        value={l.chart_of_accounts_id ?? '__none__'}
                        onValueChange={(v) =>
                          updateLine(i, { chart_of_accounts_id: v === '__none__' ? null : v })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Account" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">— Uncategorized —</SelectItem>
                          {accounts.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.code ? `${a.code} ` : ''}
                              {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="col-span-3">
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="Amount"
                        value={l.amount}
                        onChange={(e) => updateLine(i, { amount: e.target.value })}
                      />
                    </div>
                    <div className="col-span-1">
                      <Button type="button" variant="ghost" size="sm" onClick={() => removeLine(i)}>
                        <X className="w-3 h-3" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex justify-end mt-2 text-sm">
                <span className="font-medium">Total: {formatAmount(formTotal, formCurrency)}</span>
              </div>
            </div>

            {/* Memo + notes + payment instructions */}
            <div className="grid grid-cols-1 gap-3">
              <div>
                <Label>Customer memo (shown on invoice)</Label>
                <Textarea rows={2} value={formMemo} onChange={(e) => setFormMemo(e.target.value)} />
              </div>
              <div>
                <Label>Payment instructions</Label>
                <Textarea
                  rows={2}
                  value={formPaymentInstructions}
                  onChange={(e) => setFormPaymentInstructions(e.target.value)}
                  placeholder="BTC address, Lightning invoice, bank wire details…"
                />
              </div>
              <div>
                <Label>Internal notes (not shown to customer)</Label>
                <Textarea
                  rows={2}
                  value={formInternalNotes}
                  onChange={(e) => setFormInternalNotes(e.target.value)}
                />
              </div>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setCreateOpen(false);
                setEditOpen(null);
                resetForm();
              }}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button variant="outline" onClick={() => void handleSave(true)} disabled={saving}>
              Save as draft
            </Button>
            <Button onClick={() => void handleSave(false)} disabled={saving}>
              {saving ? 'Saving…' : editOpen ? 'Update' : 'Create + mark sent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Mark-paid placeholder dialog (I16) — produces the rows that the
          InvoiceMatchPanel's merge UX later folds into the real deposit. */}
      <Dialog
        open={recordPayRow !== null}
        onOpenChange={(o) => {
          if (!o) setRecordPayRow(null);
        }}
      >
        <DialogContent className="max-w-md" data-testid="invoice-mark-paid-dialog">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <DollarSign className="w-5 h-5 text-emerald-600" />
              Record payment on {recordPayRow?.invoice_number}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-900 dark:text-emerald-200">
              We record this as a <strong>placeholder</strong> payment now so bookkeeping is correct
              immediately. When the real bank deposit lands later, the Transactions screen will
              offer to merge it with this placeholder — no duplicate counted.
            </div>

            <div>
              <Label>Amount</Label>
              <Input
                type="number"
                step="0.01"
                value={recordPayAmount}
                onChange={(e) => setRecordPayAmount(e.target.value)}
                data-testid="invoice-mark-paid-amount"
              />
              {recordPayRow && recordPayRemaining > 0 && (
                <p className="text-xs text-muted-foreground mt-1">
                  Remaining balance: {formatAmount(recordPayRemaining, recordPayRow.currency)}
                </p>
              )}
            </div>

            <div>
              <Label>Wallet that received payment</Label>
              <Select value={recordPayWalletId} onValueChange={setRecordPayWalletId}>
                <SelectTrigger data-testid="invoice-mark-paid-wallet">
                  <SelectValue placeholder="Pick a wallet" />
                </SelectTrigger>
                <SelectContent>
                  {wallets.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name} {w.asset ? `(${w.asset})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <Label>Date received</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start">
                    <CalendarIcon className="w-4 h-4 mr-2" />
                    {format(recordPayDate, 'PPP')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar
                    mode="single"
                    selected={recordPayDate}
                    onSelect={(d) => d && setRecordPayDate(d)}
                    initialFocus
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div>
              <Label>Memo (optional, encrypted)</Label>
              <Textarea
                rows={2}
                value={recordPayMemo}
                onChange={(e) => setRecordPayMemo(e.target.value)}
                data-testid="invoice-mark-paid-memo"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setRecordPayRow(null)}
              disabled={recordPaySaving}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleRecordPay()}
              disabled={recordPaySaving}
              data-testid="invoice-mark-paid-submit"
            >
              {recordPaySaving ? (
                <>
                  <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Recording
                </>
              ) : (
                <>Record payment</>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share dialog — appears after Send creates the encrypted share */}
      <Dialog
        open={shareDialog !== null}
        onOpenChange={(o) => {
          if (!o) {
            setShareDialog(null);
            setSharePayload(null);
          }
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="w-5 h-5 text-primary" />
              Share invoice {shareDialog?.row.invoice_number}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="rounded-md border border-primary/40 bg-primary/5 p-3 space-y-2">
              <p className="text-xs font-medium text-primary uppercase tracking-wider">
                Share link
              </p>
              <div
                className="font-mono text-xs break-all bg-background border border-border rounded p-2"
                data-testid="invoice-share-url"
              >
                {shareDialog?.url}
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={handleCopyShare}>
                  {shareCopied ? (
                    <>
                      <Check className="w-3 h-3 mr-1" /> Copied
                    </>
                  ) : (
                    <>
                      <Copy className="w-3 h-3 mr-1" /> Copy link
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(shareDialog?.url, '_blank', 'noopener')}
                >
                  <ExternalLink className="w-3 h-3 mr-1" /> Open in new tab
                </Button>
                <Button variant="outline" size="sm" onClick={handlePrintFromShare}>
                  <Printer className="w-3 h-3 mr-1" /> Print / Save PDF
                </Button>
              </div>
            </div>

            <div className="rounded-md border border-border bg-card p-3 space-y-3">
              <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Send by email
              </p>
              <div className="space-y-2">
                <Label htmlFor="invoice-email-to" className="text-xs">
                  To
                </Label>
                <Input
                  id="invoice-email-to"
                  type="email"
                  value={emailTo}
                  onChange={(e) => setEmailTo(e.target.value)}
                  placeholder="customer@example.com"
                  data-testid="invoice-email-to"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invoice-email-subject" className="text-xs">
                  Subject
                </Label>
                <Input
                  id="invoice-email-subject"
                  value={emailSubject}
                  onChange={(e) => setEmailSubject(e.target.value)}
                  data-testid="invoice-email-subject"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="invoice-email-body" className="text-xs">
                  Message
                </Label>
                <Textarea
                  id="invoice-email-body"
                  value={emailBody}
                  onChange={(e) => setEmailBody(e.target.value)}
                  rows={8}
                  className="font-mono text-xs"
                  data-testid="invoice-email-body"
                />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  onClick={handleSendEmail}
                  disabled={emailSending || !emailTo.trim()}
                  data-testid="invoice-email-send"
                >
                  {emailSending ? (
                    <>
                      <Loader2 className="w-3 h-3 mr-1 animate-spin" /> Sending
                    </>
                  ) : (
                    <>
                      <Send className="w-3 h-3 mr-1" /> Send email
                    </>
                  )}
                </Button>
                {emailSentAt && (
                  <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                    <Check className="w-3 h-3" /> Sent {format(emailSentAt, 'p')}
                  </span>
                )}
              </div>
            </div>

            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-900 dark:text-amber-200 flex items-start gap-2">
              <Send className="w-4 h-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium mb-1">Zero-knowledge link</p>
                <p>
                  The decryption key is in the part after <code>#</code>. It never reaches our
                  servers. Send the full URL to your customer (email, chat, SMS).
                </p>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Link expires 90 days from now. Generating a new share link rotates the key — older
              links stop working.
            </p>
          </div>

          <DialogFooter>
            <Button
              onClick={() => {
                setShareDialog(null);
                setSharePayload(null);
              }}
            >
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
