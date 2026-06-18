/**
 * QuickBooks Import Wizard — Track C of the importer (#30).
 *
 * Three-step flow that wires Track A's parsers + Track B's commit orchestrator
 * into a UI:
 *
 *   1. Upload — drop a QB .zip OR the 8 .xlsx files individually. Each file is
 *      fingerprinted; user sees what was detected.
 *   2. Review — auto-classified accounts shown editable, ambiguous ones MUST
 *      be classified before import. Adaptive button copy reflects what's in
 *      the bundle (transactions / contacts / accounts).
 *   3. Committing — drives a progress bar from Track B's onProgress, then
 *      shows a summary on success.
 *
 * All parsing + encryption + writes happen client-side. The wizard never
 * sends raw QB data, plaintext amounts, or contact PII to the server.
 */

import { useCallback, useMemo, useRef, useState } from 'react';
import JSZip from 'jszip';
import { Upload, FileText, AlertTriangle, CheckCircle2, X, Loader2 } from 'lucide-react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { supabase } from '@/lib/supabase';

import { useVault } from '@/context/VaultContext';
import { useUserOrg } from '@/hooks/useUserOrg';
import { useOrgSettings } from '@/hooks/useOrgSettings';

import {
  fingerprintQuickBooksWorkbook,
  parseTrialBalance,
  parseContacts,
  parseJournal,
  parseValidationReport,
  classifyQuickBooksAccounts,
  commitQuickBooksImport,
  type QuickBooksFileType,
  type QuickBooksParsedData,
  type QuickBooksClassificationResult,
  type QuickBooksClassification,
  type AccountType,
  type AccountSubType,
  type CommitProgress,
  type CommitQuickBooksImportResult,
} from '@/lib/imports/quickbooks';

// ── Catalogues ────────────────────────────────────────────────────────────

const ACCOUNT_TYPES: AccountType[] = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];

const SUBTYPES_BY_TYPE: Record<AccountType, AccountSubType[]> = {
  ASSET: ['WALLETS', 'OTHER_CURRENT_ASSETS', 'FIXED_ASSETS', 'SUSPENSE'],
  LIABILITY: ['CURRENT_LIABILITIES', 'LONG_TERM_LIABILITIES'],
  EQUITY: ['OWNERS_EQUITY', 'RETAINED_EARNINGS'],
  INCOME: ['SALES'],
  EXPENSE: ['COST_OF_SALES', 'SALES_AND_MARKETING', 'LABOR', 'GENERAL_AND_ADMINISTRATIVE'],
};

const NORMAL_BALANCE_BY_TYPE: Record<AccountType, 'DEBIT' | 'CREDIT'> = {
  ASSET: 'DEBIT',
  LIABILITY: 'CREDIT',
  EQUITY: 'CREDIT',
  INCOME: 'CREDIT',
  EXPENSE: 'DEBIT',
};

const TYPE_LABEL: Record<QuickBooksFileType, string> = {
  TRIAL_BALANCE: 'Trial Balance',
  JOURNAL: 'Journal',
  CUSTOMERS: 'Customers',
  VENDORS: 'Vendors',
  EMPLOYEES: 'Employees',
  BALANCE_SHEET: 'Balance Sheet',
  PROFIT_AND_LOSS: 'Profit & Loss',
  GENERAL_LEDGER: 'General Ledger',
  UNKNOWN: 'Unknown',
};

function prettySubType(s: AccountSubType): string {
  return s
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ── Types ────────────────────────────────────────────────────────────────

type WizardStep = 'upload' | 'review' | 'committing' | 'done';

interface DetectedFile {
  name: string;
  size: number;
  type: QuickBooksFileType;
  buffer: ArrayBuffer;
}

interface AccountOverride {
  accountType: AccountType;
  accountSubType: AccountSubType;
  edited: boolean;
}

export interface QuickBooksImportWizardProps {
  open: boolean;
  onClose: () => void;
  /** Called once a successful import completes — Admin uses this to refetch. */
  onImported?: (result: CommitQuickBooksImportResult) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error | new Error('Could not read file'));
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.readAsArrayBuffer(file);
  });
}

async function expandQuickBooksZip(file: File): Promise<Array<{ name: string; buffer: ArrayBuffer }>> {
  const buf = await readFileAsArrayBuffer(file);
  const zip = await JSZip.loadAsync(buf);
  const out: Array<{ name: string; buffer: ArrayBuffer }> = [];
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    if (!/\.xlsx$/i.test(entry.name)) continue;
    const innerBuf = await entry.async('arraybuffer');
    // Strip directory prefix QB sometimes adds (e.g. "Quickbooks-Export/Trial_balance.xlsx").
    const name = entry.name.split('/').pop() | entry.name;
    out.push({ name, buffer: innerBuf });
  }
  return out;
}

// ── Component ────────────────────────────────────────────────────────────

export function QuickBooksImportWizard({ open, onClose, onImported }: QuickBooksImportWizardProps) {
  const { orgId } = useUserOrg();
  const { encryptText, decryptText } = useVault();
  const { settings } = useOrgSettings();

  const [step, setStep] = useState<WizardStep>('upload');
  const [files, setFiles] = useState<DetectedFile[]>([]);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<QuickBooksParsedData | null>(null);
  const [classifications, setClassifications] = useState<QuickBooksClassificationResult | null>(null);
  const [overrides, setOverrides] = useState<Record<string, AccountOverride>>({});
  const [autoOpen, setAutoOpen] = useState(false);
  const [progress, setProgress] = useState<CommitProgress | null>(null);
  const [result, setResult] = useState<CommitQuickBooksImportResult | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // ── Reset on close ──
  const reset = useCallback(() => {
    setStep('upload');
    setFiles([]);
    setParsing(false);
    setParseError(null);
    setParsed(null);
    setClassifications(null);
    setOverrides({});
    setAutoOpen(false);
    setProgress(null);
    setResult(null);
    setCommitError(null);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [onClose, reset]);

  // ── Upload step ──
  const handleFiles = useCallback(async (raw: FileList | File[]) => {
    setParseError(null);
    setParsing(true);
    try {
      const expanded: Array<{ name: string; buffer: ArrayBuffer }> = [];
      for (const file of Array.from(raw)) {
        if (/\.zip$/i.test(file.name)) {
          const inner = await expandQuickBooksZip(file);
          expanded.push(...inner);
        } else if (/\.xlsx$/i.test(file.name)) {
          expanded.push({ name: file.name, buffer: await readFileAsArrayBuffer(file) });
        }
      }
      const detected: DetectedFile[] = [];
      for (const item of expanded) {
        const type = await fingerprintQuickBooksWorkbook(item.buffer);
        detected.push({ name: item.name, size: item.buffer.byteLength, type, buffer: item.buffer });
      }
      // Merge: keep newest entry per filename so re-dropping replaces the prior copy.
      setFiles((prev) => {
        const byName = new Map<string, DetectedFile>();
        for (const f of [...prev, ...detected]) byName.set(f.name, f);
        return Array.from(byName.values());
      });
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
    }
  }, []);

  const removeFile = useCallback((name: string) => {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  }, []);

  // ── Continue → parse + classify ──
  const continueToReview = useCallback(async () => {
    if (files.length === 0) return;
    setParsing(true);
    setParseError(null);
    try {
      const out: QuickBooksParsedData = {
        trialBalanceAccounts: [],
        journalEntries: [],
        contacts: [],
        balanceSheetLines: [],
        profitLossLines: [],
        errors: [],
      };

      // Prefer JOURNAL over GENERAL_LEDGER when both are present.
      const hasJournal = files.some((f) => f.type === 'JOURNAL');
      for (const f of files) {
        try {
          if (f.type === 'TRIAL_BALANCE') {
            const r = await parseTrialBalance(f.buffer, f.name);
            out.trialBalanceAccounts.push(...r.accounts);
            out.errors.push(...r.errors);
          } else if (f.type === 'JOURNAL' | (f.type === 'GENERAL_LEDGER' && !hasJournal)) {
            const r = await parseJournal(f.buffer, f.name);
            out.journalEntries.push(...r.journalEntries);
            out.errors.push(...r.errors);
          } else if (f.type === 'CUSTOMERS') {
            const r = await parseContacts(f.buffer, 'CUSTOMER', f.name);
            out.contacts.push(...r.contacts);
            out.errors.push(...r.errors);
          } else if (f.type === 'VENDORS') {
            const r = await parseContacts(f.buffer, 'VENDOR', f.name);
            out.contacts.push(...r.contacts);
            out.errors.push(...r.errors);
          } else if (f.type === 'EMPLOYEES') {
            const r = await parseContacts(f.buffer, 'EMPLOYEE', f.name);
            out.contacts.push(...r.contacts);
            out.errors.push(...r.errors);
          } else if (f.type === 'BALANCE_SHEET') {
            const r = await parseValidationReport(f.buffer, f.name);
            out.balanceSheetLines.push(...r.lines);
            out.errors.push(...r.errors);
          } else if (f.type === 'PROFIT_AND_LOSS') {
            const r = await parseValidationReport(f.buffer, f.name);
            out.profitLossLines.push(...r.lines);
            out.errors.push(...r.errors);
          }
        } catch (err) {
          out.errors.push({
            file: f.name,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }

      const cls = classifyQuickBooksAccounts(out.trialBalanceAccounts.map((a) => a.name));

      // Seed overrides for ambiguous accounts so the dropdown has a starting
      // value (user must still confirm it). Default to ASSET / OTHER_CURRENT_ASSETS.
      const seed: Record<string, AccountOverride> = {};
      for (const name of cls.ambiguous) {
        seed[name] = { accountType: 'ASSET', accountSubType: 'OTHER_CURRENT_ASSETS', edited: false };
      }
      setOverrides(seed);
      setParsed(out);
      setClassifications(cls);
      setStep('review');
    } catch (err) {
      setParseError(err instanceof Error ? err.message : String(err));
    } finally {
      setParsing(false);
    }
  }, [files]);

  // ── Review step ──
  const setOverride = useCallback((name: string, patch: Partial<AccountOverride>) => {
    setOverrides((prev) => {
      const cur = prev[name] ?? { accountType: 'ASSET', accountSubType: 'OTHER_CURRENT_ASSETS', edited: false };
      const next: AccountOverride = { ...cur, ...patch, edited: true };
      // If type changed, reset subtype to a valid option for the new type.
      if (patch.accountType && patch.accountType !== cur.accountType) {
        const subs = SUBTYPES_BY_TYPE[patch.accountType];
        if (!subs.includes(next.accountSubType)) {
          next.accountSubType = subs[0];
        }
      }
      return { ...prev, [name]: next };
    });
  }, []);

  const ambiguousNames = useMemo(() => classifications?.ambiguous ?? [], [classifications]);

  const allAmbiguousResolved = useMemo(() => {
    return ambiguousNames.every((name) => overrides[name]?.edited);
  }, [ambiguousNames, overrides]);

  // Adaptive Import button copy.
  const importLabel = useMemo(() => {
    if (!parsed) return 'Import';
    const je = parsed.journalEntries.length;
    const c = parsed.contacts.length;
    const a = parsed.trialBalanceAccounts.length;
    if (je > 0) return `Import ${je} transactions as drafts`;
    if (c > 0 && a > 0) return `Import ${a} accounts and ${c} contacts`;
    if (c > 0) return `Import ${c} contacts`;
    if (a > 0) return `Import ${a} accounts`;
    return 'Nothing to import';
  }, [parsed]);

  // ── Commit ──
  const handleCommit = useCallback(async () => {
    if (!orgId | !parsed | !classifications) return;
    setStep('committing');
    setProgress({ stage: 'preparing', done: 0, total: 1 });
    setCommitError(null);

    // Build commit-shape overrides — only the accounts with edits should make
    // it across. Everything else uses the confident classification.
    const commitOverrides: Record<string, QuickBooksClassification> = {};
    for (const [name, ovr] of Object.entries(overrides)) {
      if (!ovr.edited) continue;
      commitOverrides[name] = {
        accountType: ovr.accountType,
        accountSubType: ovr.accountSubType,
        normalBalance: NORMAL_BALANCE_BY_TYPE[ovr.accountType],
        isWallet: ovr.accountSubType === 'WALLETS',
        isSystem: false,
      };
    }

    try {
      const res = await commitQuickBooksImport({
        orgId,
        primaryCurrency: settings.primaryCurrency,
        parsed,
        classifications,
        accountOverrides: commitOverrides,
        encryptText,
        decryptText,
        onProgress: (p) => setProgress(p),
      });
      setResult(res);
      setStep('done');
      // Fire-and-forget notification — failure here doesn't block the
      // import success path. Body stays generic enough that nothing
      // sensitive lands on the server (counts are not PII).
      const totalCreated = res.accountsCreated + res.contactsCreated + res.journalEntriesCreated;
      const body = totalCreated > 0
        ? `QuickBooks import complete: ${res.journalEntriesCreated} journal entries, ${res.contactsCreated} contacts, ${res.accountsCreated} accounts.`
        : 'QuickBooks import complete — nothing new to add (everything already imported).';
      void (supabase as any).rpc('emit_self_notification', {
        p_org_id: orgId,
        p_kind: 'import.completed',
        p_body: body,
        p_action_href: '/app/journal',
      }).then(({ error }: { error: { message: string } | null }) => {
        if (error) console.warn('[QbImport] notification emit failed:', error.message);
      });
      onImported?.(res);
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err));
      setStep('review');
    }
  }, [orgId, parsed, classifications, overrides, settings.primaryCurrency, encryptText, decryptText, onImported]);

  // ── Render ──

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent className="sm:max-w-[840px] max-h-[88vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Import from QuickBooks</DialogTitle>
        </DialogHeader>

        {/* UPLOAD */}
        {step === 'upload' && (
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="flex-1 min-h-0 overflow-auto space-y-4 pr-1">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
                <p className="font-medium mb-1">How to export from QuickBooks Online</p>
                <ol className="list-decimal pl-5 space-y-0.5">
                  <li>Reports → run Trial Balance, Journal, Customer / Vendor / Employee Lists, Balance Sheet, Profit & Loss</li>
                  <li>Export each as Excel (.xlsx)</li>
                  <li>Drop the 8 files (or a .zip) below</li>
                </ol>
                <p className="mt-2 text-blue-700/90">Everything is encrypted in your browser before it reaches our servers.</p>
              </div>

              <div
                className={cn(
                  'border-2 border-dashed rounded-lg p-10 text-center cursor-pointer transition-colors',
                  dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
                )}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragOver(false);
                  if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
                }}
                onClick={() => fileRef.current?.click()}
              >
                <Upload className="w-8 h-8 mx-auto mb-2 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">Drag & drop your QuickBooks .xlsx files (or a .zip), or click to browse</p>
                <input
                  ref={fileRef}
                  type="file"
                  multiple
                  accept=".xlsx,.zip"
                  className="hidden"
                  onChange={(e) => { if (e.target.files?.length) handleFiles(e.target.files); }}
                />
              </div>

              {files.length > 0 && (
                <div className="border border-border rounded-lg divide-y divide-border">
                  {files.map((f) => (
                    <div key={f.name} className="flex items-center justify-between px-3 py-2 text-sm">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="w-4 h-4 text-muted-foreground shrink-0" />
                        <span className="truncate">{f.name}</span>
                        <Badge variant={f.type === 'UNKNOWN' ? 'destructive' : 'secondary'} className="text-[10px]">
                          {TYPE_LABEL[f.type]}
                        </Badge>
                      </div>
                      <Button variant="ghost" size="icon" onClick={() => removeFile(f.name)} aria-label="Remove file">
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}

              {parseError && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">{parseError}</div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-4 mt-2 border-t border-border">
              <Button variant="outline" onClick={handleClose}>Cancel</Button>
              <Button
                onClick={continueToReview}
                disabled={parsing | files.length === 0}
                className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white"
              >
                {parsing ? <><Loader2 className="w-4 h-4 mr-1 animate-spin" />Reading…</> : 'Continue to review'}
              </Button>
            </div>
          </div>
        )}

        {/* REVIEW */}
        {step === 'review' && parsed && classifications && (
          <div className="space-y-4 flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900">
              <p className="font-medium">Re-imports are safe.</p>
              <p className="mt-0.5 text-emerald-800">
                If you've already imported some of these rows before, the importer skips the
                duplicates and only writes what's genuinely new. You can re-run this as many
                times as you need without doubling up.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3 text-center">
              <SummaryCard label="Accounts" value={parsed.trialBalanceAccounts.length} />
              <SummaryCard label="Contacts" value={parsed.contacts.length} />
              <SummaryCard label="Journal entries" value={parsed.journalEntries.length} />
            </div>

            {commitError && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                <p className="font-medium">Last import attempt failed</p>
                <p>{commitError}</p>
              </div>
            )}

            <div className="flex-1 min-h-0 overflow-auto space-y-4">
              {/* Ambiguous accounts — must be classified */}
              {ambiguousNames.length > 0 && (
                <div className="border border-amber-200 bg-amber-50 rounded-lg">
                  <div className="px-3 py-2 border-b border-amber-200 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600" />
                    <span className="text-sm font-medium text-amber-900">
                      {ambiguousNames.length} account{ambiguousNames.length === 1 ? '' : 's'} need classification
                    </span>
                  </div>
                  <AccountTable
                    accountNames={ambiguousNames}
                    overrides={overrides}
                    confident={null}
                    onChange={setOverride}
                    requireExplicit
                  />
                </div>
              )}

              {/* Auto-classified — collapsible */}
              {classifications.confident && Object.keys(classifications.confident).length > 0 && (
                <Collapsible open={autoOpen} onOpenChange={setAutoOpen}>
                  <div className="border border-border rounded-lg">
                    <CollapsibleTrigger asChild>
                      <button className="w-full px-3 py-2 flex items-center justify-between text-sm">
                        <span className="font-medium">
                          {Object.keys(classifications.confident).length} accounts auto-classified
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {autoOpen ? 'Hide' : 'Review'}
                        </span>
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <AccountTable
                        accountNames={Object.keys(classifications.confident)}
                        overrides={overrides}
                        confident={classifications.confident}
                        onChange={setOverride}
                      />
                    </CollapsibleContent>
                  </div>
                </Collapsible>
              )}

              {parsed.errors.length > 0 && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-700 space-y-1 max-h-[120px] overflow-auto">
                  <p className="font-medium uppercase">Parse warnings</p>
                  {parsed.errors.slice(0, 12).map((e, i) => (
                    <p key={i}>{e.file ? `${e.file}: ` : ''}{e.message}</p>
                  ))}
                  {parsed.errors.length > 12 && <p>… and {parsed.errors.length - 12} more</p>}
                </div>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setStep('upload')}>← Back</Button>
              <Button
                onClick={handleCommit}
                disabled={!allAmbiguousResolved | (parsed.trialBalanceAccounts.length + parsed.contacts.length + parsed.journalEntries.length === 0)}
                className="bg-[var(--color-brand-orange)] hover:bg-[var(--color-brand-orange-hover)] text-white"
              >
                {importLabel}
              </Button>
            </div>
          </div>
        )}

        {/* COMMITTING */}
        {step === 'committing' && (
          <div className="py-8 space-y-3">
            <p className="text-sm text-center text-muted-foreground">
              {progressMessage(progress)}
            </p>
            <Progress
              value={progress && progress.total > 0 ? (progress.done / progress.total) * 100 : 5}
              className="h-2"
            />
            <p className="text-xs text-center text-muted-foreground">
              Encrypting and saving — your data never leaves the browser as plaintext.
            </p>
          </div>
        )}

        {/* DONE */}
        {step === 'done' && result && (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              {result.errors.length === 0 ? (
                <CheckCircle2 className="w-8 h-8 text-green-500" />
              ) : (
                <AlertTriangle className="w-8 h-8 text-amber-500" />
              )}
              <div>
                <p className="font-medium">
                  {result.errors.length === 0 ? 'Import complete' : 'Import completed with issues'}
                </p>
                <p className="text-sm text-muted-foreground">
                  {result.accountsCreated} accounts · {result.contactsCreated} contacts · {result.journalEntriesCreated} journal entries
                  {(result.accountsSkipped + result.contactsSkipped + result.journalEntriesSkipped) > 0 && (
                    <> · {result.accountsSkipped + result.contactsSkipped + result.journalEntriesSkipped} skipped (already imported)</>
                  )}
                </p>
              </div>
            </div>

            {result.accountsFallback > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-sm text-amber-900">
                <p className="font-medium mb-1">{result.accountsFallback} {result.accountsFallback === 1 ? 'account' : 'accounts'} couldn&apos;t be classified — landed in Uncategorized</p>
                <p className="text-xs">
                  Their journal-entry lines were routed to <strong>Uncategorized Expense</strong> or <strong>Uncategorized Revenue</strong> based on whether the account was debit- or credit-balanced. The original QuickBooks account name is preserved in each line&apos;s description as a <code className="bg-amber-100 px-1 rounded">[QB: name]</code> prefix. Open Admin → Chart of Accounts and look under the <strong>Uncategorized Expenses</strong> / <strong>Uncategorized Income</strong> groups to re-classify when ready.
                </p>
              </div>
            )}

            {result.linesPending > 0 && (
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-900">
                <p className="font-medium mb-1">{result.linesPending} {result.linesPending === 1 ? 'line needs' : 'lines need'} a manual exchange rate</p>
                <p className="text-xs">
                  Some imported lines were in a currency we don&apos;t have a rate for at their date. They&apos;re saved with the original amounts but excluded from reports until you enter a rate. Open <strong>Admin → Rates</strong> to fill them in.
                </p>
              </div>
            )}

            {result.errors.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs space-y-1 max-h-[200px] overflow-auto">
                <p className="font-medium text-red-700 uppercase">Errors</p>
                {result.errors.map((e, i) => (
                  <p key={i} className="text-red-600">
                    [{e.phase}] {e.item}: {e.error}
                  </p>
                ))}
              </div>
            )}

            <div className="flex justify-end">
              <Button onClick={handleClose}>Done</Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Subcomponents ────────────────────────────────────────────────────────

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-border rounded-lg p-3">
      <p className="text-2xl font-semibold">{value}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

interface AccountTableProps {
  accountNames: string[];
  overrides: Record<string, AccountOverride>;
  confident: Record<string, QuickBooksClassification> | null;
  onChange: (name: string, patch: Partial<AccountOverride>) => void;
  requireExplicit?: boolean;
}

function AccountTable({ accountNames, overrides, confident, onChange, requireExplicit }: AccountTableProps) {
  if (accountNames.length === 0) return null;

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead className="bg-muted/50">
          <tr className="text-left text-muted-foreground uppercase text-[10px]">
            <th className="px-3 py-2">Account</th>
            <th className="px-3 py-2">Type</th>
            <th className="px-3 py-2">SubType</th>
            <th className="px-3 py-2 w-16"></th>
          </tr>
        </thead>
        <tbody>
          {accountNames.map((name) => {
            const baseline = confident?.[name];
            const ovr = overrides[name];
            const accountType: AccountType = ovr?.accountType ?? baseline?.accountType ?? 'ASSET';
            const accountSubType: AccountSubType = ovr?.accountSubType ?? baseline?.accountSubType ?? 'OTHER_CURRENT_ASSETS';
            const edited = !!ovr?.edited;
            const needsAttention = requireExplicit && !edited;

            return (
              <tr key={name} className={cn('border-t border-border', needsAttention && 'bg-amber-100/40')}>
                <td className="px-3 py-1.5 font-medium">{name}</td>
                <td className="px-3 py-1.5">
                  <Select
                    value={accountType}
                    onValueChange={(v) => onChange(name, { accountType: v as AccountType })}
                  >
                    <SelectTrigger className="h-7 text-xs w-[130px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {ACCOUNT_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{t}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-3 py-1.5">
                  <Select
                    value={accountSubType}
                    onValueChange={(v) => onChange(name, { accountSubType: v as AccountSubType })}
                  >
                    <SelectTrigger className="h-7 text-xs w-[200px]"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {SUBTYPES_BY_TYPE[accountType].map((s) => (
                        <SelectItem key={s} value={s}>{prettySubType(s)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </td>
                <td className="px-3 py-1.5">
                  {edited && (
                    <Badge variant="secondary" className="text-[10px]">edited</Badge>
                  )}
                  {needsAttention && (
                    <Badge variant="destructive" className="text-[10px]">required</Badge>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Helpers ──

function progressMessage(p: CommitProgress | null): string {
  if (!p) return 'Preparing…';
  switch (p.stage) {
    case 'preparing':       return 'Preparing…';
    case 'accounts':        return `Saving accounts (${p.done}/${p.total})…`;
    case 'contacts':        return `Saving contacts (${p.done}/${p.total})…`;
    case 'journal-entries': return `Saving journal entries (${p.done}/${p.total})…`;
    case 'finalizing':      return 'Finishing up…';
  }
}
