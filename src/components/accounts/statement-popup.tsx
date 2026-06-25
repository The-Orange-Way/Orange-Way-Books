import { useState, useEffect, useMemo, useCallback } from 'react';
import { Loader2, CheckCircle2, Undo2 } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import { decryptTransaction, decryptAuditLog } from '@/lib/crypto-fields';
import { writeAuditLog } from '@/lib/audit-logger';
import { useFormatCurrency } from '@/hooks/useOrgSettings';
import { useToast } from '@/hooks/use-toast';
import { generateDatePresets, computeDateRange } from '@/lib/date-presets';
import { exportToCsv } from '@/lib/exports/csv';
import { printTable } from '@/lib/exports/print-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent } from '@/components/ui/dialog';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { cn } from '@/lib/utils';

export interface StatementWallet {
  id: string;
  encrypted_name?: string | null;
  asset: string;
  account_type: string | null;
  institution?: string | null;
  initial_balance: number;
}

interface DecryptedTx {
  id: string;
  date: string;
  amount: number;
  type: string;
  memo: string | null;
  asset: string;
  cleared_status: string | null;
  status: string | null;
}

interface StatementPopupProps {
  open: boolean;
  onClose: () => void;
  wallet: StatementAccount | null;
  orgId: string;
}

const PER_PAGE_OPTIONS = [20, 50, 100];
const BALANCED_EPSILON = 0.000000005;

const ALL_PRESETS = [{ value: 'all', label: 'All Time' }, ...generateDatePresets()];

export function StatementPopup({ open, onClose, wallet, orgId }: StatementPopupProps) {
  const { decryptText, encryptText } = useVault();
  const { formatAmount } = useFormatCurrency();
  const { toast } = useToast();

  const [txs, setTxs] = useState<DecryptedTx[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  const [datePreset, setDatePreset] = useState('all');
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(20);
  // Track 5A — DRAFT visibility toggle. Defaults to "on" (the
  // wallet-statement behavior). When off, DRAFT rows
  // are hidden from the statement and excluded from the running balance.
  // Reports stay POSTED-only regardless of this toggle.
  const [includeDrafts, setIncludeDrafts] = useState(true);

  // Reconcile state
  const [reconcileMode, setReconcileMode] = useState(false);
  const [reconcileBalance, setReconcileBalance] = useState('');
  const [reconcileDate, setReconcileDate] = useState('');
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [reconciling, setReconciling] = useState(false);
  const [undoing, setUndoing] = useState(false);

  // Undo dialog state
  const [undoDialogOpen, setUndoDialogOpen] = useState(false);
  const [undoMode, setUndoMode] = useState<
    null | { kind: 'batch'; auditEntry: any } | { kind: 'all'; txIds: string[] }
  >(null);

  // Reset all local state when the wallet changes or popup opens
  useEffect(() => {
    if (!open) return;
    setDatePreset('all');
    setCustomStart('');
    setCustomEnd('');
    setPage(1);
    setReconcileMode(false);
    setReconcileBalance('');
    setReconcileDate('');
    setCheckedIds(new Set());
  }, [open, wallet?.id]);

  // Fetch + decrypt transactions whenever popup opens or refresh is requested
  useEffect(() => {
    if (!open || !wallet) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      const { data, error } = await supabase
        .from('transactions')
        .select('*')
        .eq('account_id', wallet.id)
        .order('date', { ascending: true });
      if (error) {
        console.error('Failed to load transactions', error);
        if (!cancelled) setLoading(false);
        return;
      }
      const decrypted: DecryptedTx[] = await Promise.all(
        ((data as any[]) ?? []).map(async (row) => {
          const fields = await decryptTransaction(row, decryptText);
          return {
            id: row.id,
            date: row.date,
            amount: Number(fields.amount) || 0,
            type: fields.type ?? '',
            memo: fields.memo,
            asset: fields.asset ?? row.asset,
            cleared_status: fields.cleared_status ?? null,
            status: fields.status ?? null,
          };
        }),
      );
      if (!cancelled) {
        setTxs(decrypted);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, wallet?.id, refreshKey, decryptText]);

  // Compute effective date range from preset
  const dateRange = useMemo(() => {
    if (datePreset === 'all') return { start: '', end: '' };
    if (datePreset === 'custom') return { start: customStart, end: customEnd };
    const { startDate, endDate } = computeDateRange(datePreset);
    return { start: startDate, end: endDate };
  }, [datePreset, customStart, customEnd]);

  // Split transactions: those before the period (feed starting balance) vs within period.
  // T5A — DRAFT visibility: when includeDrafts is false, treat DRAFT rows as
  // if they don't exist for both the running balance and the inPeriod list.
  const visibleTxs = useMemo(() => {
    return includeDrafts ? txs : txs.filter((t) => t.status !== 'DRAFT');
  }, [txs, includeDrafts]);

  const { inPeriod, startingBalance } = useMemo(() => {
    const start = dateRange.start;
    const end = dateRange.end;
    const priorSum = visibleTxs
      .filter((t) => (start ? t.date < start : false))
      .reduce((s, t) => s + (t.amount || 0), 0);
    const within = visibleTxs.filter((t) => {
      if (start && t.date < start) return false;
      if (end && t.date > end) return false;
      return true;
    });
    return {
      inPeriod: within,
      startingBalance: (wallet?.initial_balance ?? 0) + priorSum,
    };
  }, [visibleTxs, dateRange.start, dateRange.end, wallet?.initial_balance]);

  // Enrich with running balance
  const withRunning = useMemo(() => {
    let running = startingBalance;
    return inPeriod.map((t) => {
      running += t.amount || 0;
      const amt = t.amount || 0;
      return {
        ...t,
        debit: amt > 0 ? amt : null,
        credit: amt < 0 ? Math.abs(amt) : null,
        runningBalance: running,
      };
    });
  }, [inPeriod, startingBalance]);

  const endingBalance =
    withRunning.length > 0 ? withRunning[withRunning.length - 1].runningBalance : startingBalance;

  const total = withRunning.length;
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const pageSafe = Math.min(page, totalPages);
  const startIdx = (pageSafe - 1) * perPage;
  const pageRows = withRunning.slice(startIdx, startIdx + perPage);
  const showingStart = total === 0 ? 0 : startIdx + 1;
  const showingEnd = Math.min(startIdx + perPage, total);

  const fmtAmt = useCallback(
    (amount: number) => {
      const currency = wallet?.asset ?? 'USD';
      return formatAmount(amount, currency);
    },
    [wallet?.asset, formatAmount],
  );

  // Reconciliation computed values
  const checkedTotal = useMemo(() => {
    if (!reconcileMode) return 0;
    return withRunning.filter((t) => checkedIds.has(t.id)).reduce((s, t) => s + (t.amount || 0), 0);
  }, [withRunning, checkedIds, reconcileMode]);

  const reconcileBalanceNum = useMemo(() => {
    const raw = reconcileBalance.trim();
    if (!raw) return null;
    const n = parseFloat(raw.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }, [reconcileBalance]);

  const reconcileDifference = useMemo(() => {
    if (reconcileBalanceNum === null) return null;
    return reconcileBalanceNum - startingBalance - checkedTotal;
  }, [reconcileBalanceNum, startingBalance, checkedTotal]);

  const isBalanced =
    reconcileDifference !== null && Math.abs(reconcileDifference) < BALANCED_EPSILON;

  const handleToggleCheck = useCallback((id: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setCheckedIds(new Set(withRunning.map((t) => t.id)));
  }, [withRunning]);

  const handleDeselectAll = useCallback(() => {
    setCheckedIds(new Set());
  }, []);

  const handleExitReconcile = useCallback(() => {
    setReconcileMode(false);
    setReconcileBalance('');
    setReconcileDate('');
    setCheckedIds(new Set());
  }, []);

  const handleCompleteReconciliation = useCallback(async () => {
    if (!wallet || !isBalanced || reconciling) return;
    setReconciling(true);
    try {
      const ids = Array.from(checkedIds);
      const encStatus = await encryptText('RECONCILED');
      const { error } = await supabase
        .from('transactions')
        .update({ cleared_status: encStatus, key_version: 2 } as any)
        .in('id', ids);
      if (error) throw error;
      if (orgId) {
        await writeAuditLog({
          orgId,
          action: 'RECONCILE',
          entityType: 'wallet',
          entityId: wallet.id,
          summary: `Reconciled ${ids.length} transaction(s) through ${reconcileDate || 'today'} — statement balance ${reconcileBalanceNum}`,
          after: {
            transactionIds: ids,
            statementBalance: reconcileBalanceNum,
            statementDate: reconcileDate,
          },
          encrypt: encryptText,
        });
      }
      toast({
        title: 'Reconciled',
        description: `${ids.length} transaction${ids.length === 1 ? '' : 's'} reconciled through ${reconcileDate || 'today'}.`,
      });
      handleExitReconcile();
      setRefreshKey((k) => k + 1);
    } catch (err: any) {
      toast({
        title: 'Reconciliation failed',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setReconciling(false);
    }
  }, [
    wallet,
    isBalanced,
    reconciling,
    checkedIds,
    encryptText,
    reconcileDate,
    reconcileBalanceNum,
    orgId,
    toast,
    handleExitReconcile,
  ]);

  const handleOpenUndoDialog = useCallback(async () => {
    if (!wallet || undoing) return;
    if (!orgId) {
      toast({
        title: 'Cannot undo',
        description: 'Missing organization context.',
        variant: 'destructive',
      });
      return;
    }
    setUndoing(true);
    try {
      const { data: logRows, error: logErr } = await supabase
        .from('audit_logs')
        .select('*')
        .eq('org_id', orgId)
        .eq('entity_type', 'wallet')
        .eq('entity_id', wallet.id)
        .eq('action', 'RECONCILE')
        .order('created_at', { ascending: false })
        .limit(1);
      if (logErr) throw logErr;
      const lastLog = (logRows as any[])?.[0];
      const reconciledTxs = txs.filter((t) => t.cleared_status === 'RECONCILED');

      if (lastLog) {
        setUndoMode({ kind: 'batch', auditEntry: lastLog });
        setUndoDialogOpen(true);
      } else if (reconciledTxs.length > 0) {
        setUndoMode({ kind: 'all', txIds: reconciledTxs.map((t) => t.id) });
        setUndoDialogOpen(true);
      } else {
        toast({
          title: 'Nothing to undo',
          description: 'No reconciliation to undo for this wallet.',
        });
      }
    } catch (err: any) {
      toast({
        title: 'Undo failed',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setUndoing(false);
    }
  }, [wallet, undoing, orgId, txs, toast]);

  const handleConfirmUndo = useCallback(async () => {
    if (!wallet || !undoMode || !orgId) return;
    setUndoing(true);
    try {
      const encCleared = await encryptText('CLEARED');
      let ids: string[] = [];

      if (undoMode.kind === 'batch') {
        const decrypted = await decryptAuditLog(undoMode.auditEntry, decryptText);
        try {
          const parsed = decrypted.after_snapshot ? JSON.parse(decrypted.after_snapshot) : null;
          if (parsed && Array.isArray(parsed.transactionIds))
            ids = parsed.transactionIds as string[];
        } catch {
          ids = [];
        }
        if (ids.length === 0) {
          toast({
            title: 'Nothing to undo',
            description: 'Could not read prior reconciliation snapshot.',
            variant: 'destructive',
          });
          return;
        }
        const { error: updErr } = await supabase
          .from('transactions')
          .update({ cleared_status: encCleared, key_version: 2 } as any)
          .in('id', ids);
        if (updErr) throw updErr;
        await writeAuditLog({
          orgId,
          action: 'UPDATE',
          entityType: 'wallet',
          entityId: wallet.id,
          summary: `Undid reconciliation of ${ids.length} transaction(s)`,
          after: { transactionIds: ids, undoOf: undoMode.auditEntry.id },
          encrypt: encryptText,
        });
      } else {
        ids = undoMode.txIds;
        if (ids.length === 0) {
          toast({
            title: 'Nothing to undo',
            description: 'No reconciled transactions found.',
          });
          return;
        }
        const { error: updErr } = await supabase
          .from('transactions')
          .update({ cleared_status: encCleared, key_version: 2 } as any)
          .in('id', ids);
        if (updErr) throw updErr;
        await writeAuditLog({
          orgId,
          action: 'UPDATE',
          entityType: 'wallet',
          entityId: wallet.id,
          summary: `Undid reconciliation of ${ids.length} pre-audit-log transaction(s)`,
          after: { transactionIds: ids, mode: 'legacy_undo' },
          encrypt: encryptText,
        });
      }

      toast({
        title: 'Undone',
        description: `${ids.length} transaction${ids.length === 1 ? '' : 's'} returned to Cleared.`,
      });
      setRefreshKey((k) => k + 1);
      setUndoDialogOpen(false);
      setUndoMode(null);
    } catch (err: any) {
      toast({
        title: 'Undo failed',
        description: err?.message ?? 'Please try again.',
        variant: 'destructive',
      });
    } finally {
      setUndoing(false);
    }
  }, [wallet, undoMode, orgId, decryptText, encryptText, toast]);

  const exportRows = useMemo(
    () =>
      withRunning.map((t) => [
        t.date,
        t.id.slice(0, 8),
        t.memo ?? t.type,
        t.debit != null ? String(t.debit) : '',
        t.credit != null ? String(t.credit) : '',
        String(t.runningBalance),
      ]),
    [withRunning],
  );

  const handleExport = useCallback(
    (format: 'csv' | 'pdf') => {
      if (!wallet) return;
      const headers = ['Date', 'Ref#', 'Description', 'Debit', 'Credit', 'Running Balance'];
      const name = wallet.encrypted_name || 'Wallet';
      if (format === 'csv') {
        exportToCsv(`${name}-statement`, headers, exportRows);
      } else {
        void printTable(`${name} — Statement`, headers, exportRows);
      }
    },
    [wallet, exportRows],
  );

  const statusBadge = (status: string | null) => {
    if (status === 'RECONCILED') {
      return (
        <Badge className="bg-green-100 text-green-800 hover:bg-green-100 gap-1">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Reconciled
        </Badge>
      );
    }
    if (status === 'CLEARED') {
      return (
        <Badge variant="outline" className="border-blue-300 text-blue-700">
          Cleared
        </Badge>
      );
    }
    return null;
  };

  if (!wallet) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        className="sm:max-w-5xl max-h-[90vh] flex flex-col p-0 overflow-hidden"
        aria-describedby={undefined}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-6 pt-5 pb-3 border-b">
          <div>
            <h2 className="text-xl font-semibold">
              {wallet.encrypted_name || '[Encrypted]'} — {reconcileMode ? 'Reconcile' : 'Statement'}
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              {wallet.asset} / {wallet.institution || 'N/A'} / {wallet.account_type || 'N/A'}
            </p>
          </div>
          <div className="flex items-center gap-2 pr-8">
            {!reconcileMode && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleOpenUndoDialog}
                disabled={undoing}
                title="Undo Last Reconciliation"
              >
                {undoing ? (
                  <Loader2 className="w-4 h-4 mr-1 animate-spin" />
                ) : (
                  <Undo2 className="w-4 h-4 mr-1" />
                )}
                Undo Last Reconciliation
              </Button>
            )}
            <Button
              variant={reconcileMode ? 'default' : 'outline'}
              size="sm"
              onClick={() => (reconcileMode ? handleExitReconcile() : setReconcileMode(true))}
            >
              {reconcileMode ? 'Exit Reconcile' : 'Reconcile'}
            </Button>
          </div>
        </div>

        {/* Reconcile inputs row */}
        {reconcileMode && (
          <div className="flex flex-wrap items-center gap-3 px-6 py-3 border-b bg-muted/30">
            <label className="text-xs font-medium text-muted-foreground">Statement Balance</label>
            <Input
              type="text"
              className="h-8 w-[180px] font-mono"
              value={reconcileBalance}
              onChange={(e) => setReconcileBalance(e.target.value)}
              placeholder={`0.00 ${wallet.asset}`}
            />
            <label className="text-xs font-medium text-muted-foreground">As of</label>
            <Input
              type="date"
              className="h-8 w-[160px]"
              value={reconcileDate}
              onChange={(e) => setReconcileDate(e.target.value)}
            />
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onClick={handleSelectAll}>
              Select All
            </Button>
            <Button variant="ghost" size="sm" onClick={handleDeselectAll}>
              Deselect All
            </Button>
          </div>
        )}

        {/* Filter bar */}
        <div className="flex flex-wrap items-center gap-3 px-6 py-3 border-b">
          <label className="text-xs font-medium text-muted-foreground">PERIOD</label>
          <Select
            value={datePreset}
            onValueChange={(v) => {
              setDatePreset(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="h-8 w-[160px] text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ALL_PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {datePreset === 'custom' && (
            <>
              <label className="text-xs text-muted-foreground">From</label>
              <Input
                type="date"
                className="h-8 w-[150px]"
                value={customStart}
                onChange={(e) => {
                  setCustomStart(e.target.value);
                  setPage(1);
                }}
              />
              <label className="text-xs text-muted-foreground">To</label>
              <Input
                type="date"
                className="h-8 w-[150px]"
                value={customEnd}
                onChange={(e) => {
                  setCustomEnd(e.target.value);
                  setPage(1);
                }}
              />
            </>
          )}

          <div className="flex-1" />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                Export ▾
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => handleExport('csv')}>Export as CSV</DropdownMenuItem>
              <DropdownMenuItem onClick={() => handleExport('pdf')}>Export as PDF</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* T5A — DRAFT visibility toggle. Inline left of the date filter
              so it's discoverable but doesn't dominate. When off, DRAFT
              transactions vanish from the list AND from the running balance. */}
          <label className="ml-auto inline-flex items-center gap-2 text-xs select-none cursor-pointer text-muted-foreground hover:text-foreground">
            <input
              type="checkbox"
              checked={includeDrafts}
              onChange={(e) => {
                setIncludeDrafts(e.target.checked);
                setPage(1);
              }}
              className="h-3.5 w-3.5"
            />
            Include drafts in balance
          </label>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Balance cards */}
              <div className="grid grid-cols-2 gap-4 mb-4">
                <div className="border rounded-lg px-4 py-3 bg-card">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Starting Balance
                  </p>
                  <p className="text-lg font-mono mt-1">{fmtAmt(startingBalance)}</p>
                </div>
                <div className="border rounded-lg px-4 py-3 bg-card">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Ending Balance
                  </p>
                  <p className="text-lg font-mono mt-1">{fmtAmt(endingBalance)}</p>
                </div>
              </div>

              {/* Transactions table */}
              <div className="border rounded-lg overflow-hidden">
                <Table>
                  <TableHeader>
                    <TableRow>
                      {reconcileMode && <TableHead className="w-[40px]" />}
                      <TableHead>Date</TableHead>
                      <TableHead>Ref#</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="text-right">Credit</TableHead>
                      <TableHead className="text-right">Running Balance</TableHead>
                      <TableHead className="w-[130px]">Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pageRows.length === 0 ? (
                      <TableRow>
                        <TableCell
                          colSpan={reconcileMode ? 8 : 7}
                          className="text-center text-muted-foreground py-10 text-sm"
                        >
                          No transactions found for the selected period.
                        </TableCell>
                      </TableRow>
                    ) : (
                      pageRows.map((t) => {
                        const isChecked = checkedIds.has(t.id);
                        return (
                          <TableRow
                            key={t.id}
                            className={cn(reconcileMode && isChecked && 'bg-green-50/50')}
                          >
                            {reconcileMode && (
                              <TableCell>
                                <Checkbox
                                  checked={isChecked}
                                  onCheckedChange={() => handleToggleCheck(t.id)}
                                />
                              </TableCell>
                            )}
                            <TableCell className="font-mono text-xs">{t.date}</TableCell>
                            <TableCell className="font-mono text-xs text-muted-foreground">
                              {t.id.slice(0, 8)}
                            </TableCell>
                            <TableCell className="text-sm">{t.memo || t.type || '—'}</TableCell>
                            <TableCell className="text-right font-mono text-sm text-green-700">
                              {t.debit != null ? fmtAmt(t.debit) : ''}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm text-red-700">
                              {t.credit != null ? fmtAmt(t.credit) : ''}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {fmtAmt(t.runningBalance)}
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-1.5">
                                {t.status === 'DRAFT' && (
                                  <Badge className="bg-slate-100 text-slate-700 hover:bg-slate-100 text-[10px]">
                                    Draft
                                  </Badge>
                                )}
                                {statusBadge(t.cleared_status)}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </div>

              {/* Pagination */}
              {total > 0 && (
                <div className="flex items-center justify-between mt-3 text-xs text-muted-foreground">
                  <span>
                    Showing {showingStart}–{showingEnd} of {total}
                  </span>
                  <div className="flex items-center gap-2">
                    <span>Per page:</span>
                    <Select
                      value={String(perPage)}
                      onValueChange={(v) => {
                        setPerPage(Number(v));
                        setPage(1);
                      }}
                    >
                      <SelectTrigger className="h-7 w-[70px] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {PER_PAGE_OPTIONS.map((n) => (
                          <SelectItem key={n} value={String(n)}>
                            {n}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pageSafe <= 1}
                      onClick={() => setPage(pageSafe - 1)}
                    >
                      ‹
                    </Button>
                    <span className="px-2">
                      {pageSafe} / {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pageSafe >= totalPages}
                      onClick={() => setPage(pageSafe + 1)}
                    >
                      ›
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Reconciliation bottom bar */}
        {reconcileMode && reconcileBalance && (
          <div
            className={cn(
              'flex items-center gap-6 px-6 py-3 border-t',
              isBalanced ? 'bg-green-50' : 'bg-amber-50',
            )}
          >
            <div className="flex gap-6 text-xs flex-1">
              <div>
                <p className="uppercase tracking-wide text-muted-foreground">Statement</p>
                <p className="font-mono text-sm mt-0.5">
                  {reconcileBalanceNum !== null ? fmtAmt(reconcileBalanceNum) : '—'}
                </p>
              </div>
              <div>
                <p className="uppercase tracking-wide text-muted-foreground">Starting + Checked</p>
                <p className="font-mono text-sm mt-0.5">{fmtAmt(startingBalance + checkedTotal)}</p>
              </div>
              <div>
                <p className="uppercase tracking-wide text-muted-foreground">Difference</p>
                <p
                  className={cn(
                    'font-mono text-sm mt-0.5 flex items-center gap-1',
                    isBalanced ? 'text-green-700' : 'text-amber-700',
                  )}
                >
                  {isBalanced ? (
                    <>
                      <CheckCircle2 className="w-4 h-4" /> Balanced!
                    </>
                  ) : (
                    fmtAmt(reconcileDifference ?? 0)
                  )}
                </p>
              </div>
            </div>
            <Button disabled={!isBalanced || reconciling} onClick={handleCompleteReconciliation}>
              {reconciling && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              {reconciling ? 'Saving...' : isBalanced ? 'Complete Reconciliation' : 'Not Balanced'}
            </Button>
          </div>
        )}
      </DialogContent>

      <AlertDialog
        open={undoDialogOpen}
        onOpenChange={(o) => {
          setUndoDialogOpen(o);
          if (!o) setUndoMode(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Undo last reconciliation?</AlertDialogTitle>
            <AlertDialogDescription>
              {undoMode?.kind === 'all'
                ? `No reconciliation history found, but this wallet has ${undoMode.txIds.length} reconciled transaction${undoMode.txIds.length === 1 ? '' : 's'}. This will unreconcile ALL of them (they predate audit logging). Reconciled transactions will return to Cleared status. This action is logged to the audit trail.`
                : 'This will unreconcile the most recent reconciliation batch for this wallet. Reconciled transactions will return to Cleared status. This action is logged to the audit trail.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={undoing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void handleConfirmUndo();
              }}
              disabled={undoing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {undoing && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              Undo Reconciliation
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
