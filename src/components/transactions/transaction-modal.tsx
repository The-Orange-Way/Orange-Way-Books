/**
 * Transaction Modal — OWB smart-transaction-modal UX.
 *
 * Three modes:
 *   - STANDARD  : wallet ↔ account/contact, single amount
 *   - SPLIT     : wallet with N account rows summing to total
 *   - TRANSFER  : wallet ↔ other wallet (linked_transfer_id pairing)
 *
 * Preserves existing plumbing:
 *   - ZKA encrypt on save via encryptTransaction
 *   - legacy ledger backend blind-proxy post via postTransaction (Standard only, new tx only)
 *   - Audit logging via writeAuditLog
 *   - Exchange rate via useExchangeRate
 *   - Attachment encryption via encryptAttachment
 *
 * The parent (Transactions.tsx) still owns the reconciliation edit-lock —
 * we simply never open this modal when tx.cleared_status === 'RECONCILED'.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { format } from 'date-fns';
import { ArrowLeft, ArrowRight, CalendarIcon, Clock, Loader2, Minus, Plus, Trash2, X } from 'lucide-react';
import { supabase } from '@/lib/supabase';
import { AttachmentList } from "@/components/attachments/AttachmentList";
import { useVault } from '@/context/VaultContext';
import {
  encryptTransaction,
  encryptAttachment,
  encryptJournalEntry,
  decryptChartOfAccount,
  decryptJournalEntryLine,
  encryptContact,
  decryptContact,
} from '@/lib/crypto-fields';
import { buildJournalEntryLineInsert } from '@/lib/exchange/build-je-line-insert';
// Phase 2 removal: legacy-ledger dual-write deleted. Transactions land in Postgres only.
import {
  ensureTransferClearingAccount,
  TRANSFER_CLEARING_NAME,
} from '@/lib/transactions/transfer-clearing';
import { writeAuditLog } from '@/lib/audit-logger';
import { useExchangeRate } from '@/lib/exchange/hooks';
import { useFormatCurrency } from '@/hooks/useOrgSettings';
import { InvoiceMatchPanel } from '@/components/transactions/InvoiceMatchPanel';
import {
  ALLOWED_EXTENSIONS,
  MAX_FILES_PER_ENTITY,
  formatFileSize,
  validateAttachmentName,
  validateAttachmentSize,
} from '@/lib/attachment-rules';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  Select, SelectContent, SelectGroup, SelectItem, SelectLabel,
  SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Popover, PopoverContent, PopoverTrigger,
} from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

// ── Types ────────────────────────────────────────────────────────────────────

export interface WalletOption {
  id: string;
  encrypted_name: string; // already decrypted plaintext name (field name kept for back-compat)
  asset: string;
  external_account_id?: string | null;
}

export interface AccountOption {
  id: string;
  external_account_id: string;
  name: string;
  code: string | null;
}

export interface ContactOption {
  id: string;
  name: string;
  /** CUSTOMER | VENDOR | EMPLOYEE | OTHER — surfaced as a dropdown group label. */
  kind: string | null;
}

export interface TxEditInput {
  id: string;
  account_id: string | null;
  type: string;
  asset: string;
  amount: number;
  usd_value: number | null;
  exchange_rate: number | null;
  date: string;
  memo: string | null;
  status?: string | null;
  cleared_status?: string | null;
  linked_transfer_id?: string | null;
  /** chart_of_accounts.id (PK) of the account this transaction was assigned to.
   *  Null for legacy rows created before the account_id column landed; those
   *  show "Select account" in the dropdown until the user picks one + saves. */
  account_id?: string | null;
  /** contacts.id of the customer / vendor / employee. Independent of
   *  account_id — a single tx has BOTH a chart bucket and a contact. */
  contact_id?: string | null;
  /** journal_entries.id wrapper for split + transfer modes. NULL for standard
   *  transactions that post directly to legacy ledger backend without a JE wrapper. */
  journal_entry_id?: string | null;
}

export interface TransactionModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  editingTx: TxEditInput | null;
  orgId: string;
  legacyJournalId: string | null;
  wallets: WalletOption[];
  accounts: AccountOption[];
  contacts?: ContactOption[];
  /** Called after the modal creates a new contact inline so the caller
   *  can refetch the contacts list. */
  onContactsChanged?: () => void;
}

type TxMode = 'standard' | 'split' | 'transfer';
type Direction = 'IN' | 'OUT';

interface SplitLine {
  clientId: string;
  accountId: string; // AccountOption.id (Supabase PK)
  amount: string;
  /** Optional per-row memo. T1.b locked 2026-05-11 supports this; the UI
   *  control (small pencil icon per row) lands as a follow-up. The write
   *  path already stores it on the JE line so the schema is forward-compatible. */
  memo?: string;
}

interface ReceiptDraft {
  file: File;
  name: string;
  size: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let splitCounter = 0;
const nextSplitId = () => `split-${++splitCounter}`;

function getCurrencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case 'EUR': return '€';
    case 'GBP': return '£';
    case 'CAD': return 'C$';
    case 'AUD': return 'A$';
    case 'BTC': return '₿';
    case 'ETH': return 'Ξ';
    case 'USDC':
    case 'USD':
    default:    return '$';
  }
}

function parseAmount(raw: string): number | null {
  const trimmed = raw.trim().replace(/,/g, '');
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// String(0.00000006) returns "6e-8" — JS switches to scientific notation for
// values < 1e-6, which is normal for sat-sized BTC amounts and unreadable in
// an editable input. Round-trip through toFixed(8) and strip trailing zeros.
function formatAmountForInput(n: number): string {
  if (!Number.isFinite(n) | n === 0) return '0';
  return n.toFixed(8).replace(/\.?0+$/, '') | '0';
}

function createBlankSplitLines(): SplitLine[] {
  return [
    { clientId: nextSplitId(), accountId: '', amount: '' },
    { clientId: nextSplitId(), accountId: '', amount: '' },
  ];
}

// ── Component ────────────────────────────────────────────────────────────────

export default function TransactionModal({
  open,
  onClose,
  onSaved,
  editingTx,
  orgId,
  legacyJournalId,
  wallets,
  accounts,
  contacts = [],
  onContactsChanged,
}: TransactionModalProps): React.ReactElement {
  const { encryptText, decryptText, encryptBlob, loadOrgSigningKey, signMutation } = useVault();
  const { formatAmount } = useFormatCurrency();

  // ── Form state ─────────────────────────────────────────────────────────────
  const [mode, setMode] = useState<TxMode>('standard');
  const [walletId, setWalletId] = useState('');
  const [direction, setDirection] = useState<Direction>('OUT');
  const [accountId, setAccountId] = useState(''); // Standard mode: destination account
  const [contactId, setContactId] = useState(''); // Standard mode: customer / vendor on the right-side picker
  const [counterpartyWalletId, setCounterpartyWalletId] = useState(''); // Transfer mode
  // Inline new-contact dialog state. Triggered by the "+ New contact" item in
  // the right-side picker.
  const [newContactDialogOpen, setNewContactDialogOpen] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [newContactKind, setNewContactKind] = useState('CUSTOMER');
  const [newContactSaving, setNewContactSaving] = useState(false);
  const [amount, setAmount] = useState(''); // Standard + Split (total)
  const [sentAmount, setSentAmount] = useState(''); // Transfer
  const [receivedAmount, setReceivedAmount] = useState(''); // Transfer
  const [feeAmount, setFeeAmount] = useState(''); // Transfer
  const [showFeeSection, setShowFeeSection] = useState(false); // Transfer fee UX toggle
  const [feeSide, setFeeSide] = useState<'source' | 'dest' | ''>(''); // Which wallet the fee comes out of
  const [feeAccountId, setFeeAccountId] = useState(''); // Expense account for the fee
  const [splitLines, setSplitLines] = useState<SplitLine[]>(createBlankSplitLines);
  const [date, setDate] = useState<Date>(new Date());
  const [showTime, setShowTime] = useState(false);
  const [time, setTime] = useState('');
  const [memo, setMemo] = useState('');
  const [receipts, setReceipts] = useState<ReceiptDraft[]>([]);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [draggingReceipt, setDraggingReceipt] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Reset form on open ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    if (editingTx) {
      // ── Synchronous seed: standard-mode defaults from the row itself ──
      // The async detector below upgrades to split/transfer if the row has
      // a journal_entry_id pointing at a multi-leg JE or a linked_transfer_id
      // pointing at a sibling row.
      setMode('standard');
      setWalletId(editingTx.account_id | '');
      setDirection(Number(editingTx.amount) >= 0 ? 'IN' : 'OUT');
      // Restore the account picked when this row was created. Falls back to
      // empty string for legacy rows (account_id null) — those still show
      // "Select account" until the user picks one + saves.
      setAccountId(editingTx.account_id ?? '');
      setContactId(editingTx.contact_id ?? '');
      setCounterpartyWalletId('');
      setAmount(formatAmountForInput(Math.abs(Number(editingTx.amount))));
      setSentAmount('');
      setReceivedAmount('');
      setFeeAmount('');
      setShowFeeSection(false);
      setFeeSide('');
      setFeeAccountId('');
      setSplitLines(createBlankSplitLines());
      setDate(editingTx.date ? new Date(`${editingTx.date}T12:00:00`) : new Date());
      setTime('');
      setShowTime(false);
      setMemo(editingTx.memo | '');
      setReceipts([]);
      setErrors({});

      // ── Async detection: split (JE with N+1 lines) or transfer (linked) ─
      // We query journal_entry_lines once and shape the form to match the
      // existing JE so the user doesn't accidentally drop the split rows
      // or counterparty wallet on save. Failures fall back to standard mode
      // with a warning toast so the user knows we're creating a fresh JE.
      let cancelled = false;
      const detectMode = async (): Promise<void> => {
        const isTransfer = !!editingTx.linked_transfer_id;
        if (!editingTx.journal_entry_id && !isTransfer) return;
        try {
          if (isTransfer) {
            const { data: linkedRow, error: linkedErr } = await supabase
              .from('transactions')
              .select('id, account_id, amount, asset')
              .eq('id', editingTx.linked_transfer_id!)
              .maybeSingle();
            if (linkedErr | !linkedRow | cancelled) {
              if (!cancelled) toast.warning(
                "Couldn't load the other side of this transfer; saving will create a fresh entry.",
              );
              return;
            }
            // Direction is from this side's perspective. If editingTx.amount is
            // negative the user picked the source side; positive = destination.
            const editingIsSource = Number(editingTx.amount) < 0;
            setMode('transfer');
            // walletId stays as editingTx.account_id (the user's left-side pick);
            // counterparty is the other leg.
            setCounterpartyWalletId(linkedRow.account_id as string);
            setDirection(editingIsSource ? 'OUT' : 'IN');
            setSentAmount(
              formatAmountForInput(
                Math.abs(editingIsSource ? Number(editingTx.amount) : Number(linkedRow.amount)),
              ),
            );
            setReceivedAmount(
              formatAmountForInput(
                Math.abs(editingIsSource ? Number(linkedRow.amount) : Number(editingTx.amount)),
              ),
            );
            return;
          }

          // Split detection via JE lines. A split JE has:
          //   - 1 wallet leg (account_name = wallet name, debit XOR credit > 0)
          //   - N account legs (account_name = chart-of-accounts name, N >= 2)
          const { data: linesRaw, error: linesErr } = await supabase
            .from('journal_entry_lines')
            .select('*')
            .eq('journal_entry_id', editingTx.journal_entry_id!);
          if (linesErr | !linesRaw | cancelled) {
            if (!cancelled) toast.warning(
              "Couldn't load split lines; saving will create a fresh entry.",
            );
            return;
          }
          const decryptedLines = await Promise.all(
            (linesRaw as any[]).map((l) => decryptJournalEntryLine(l, decryptText)),
          );
          if (cancelled) return;

          // Resolve wallet name (plaintext on WalletOption.encrypted_name field).
          const walletName = wallets.find((w) => w.id === editingTx.account_id)
            ?.encrypted_name;
          const accountLegs = decryptedLines.filter(
            (l) => !walletName | (l.account_name | '').trim() !== walletName.trim(),
          );
          if (accountLegs.length >= 2) {
            // Map account_name back to AccountOption.id via the prop list.
            const namedAccounts = accountLegs
              .map((leg) => {
                const acct = accounts.find(
                  (a) => a.name.trim() === (leg.account_name | '').trim(),
                );
                if (!acct) return null;
                const lineAmt = Math.max(leg.debit ?? 0, leg.credit ?? 0);
                return {
                  clientId: nextSplitId(),
                  accountId: acct.id,
                  amount: formatAmountForInput(lineAmt),
                  memo: leg.description ?? undefined,
                } satisfies SplitLine;
              })
              .filter((l): l is SplitLine => !!l);

            if (namedAccounts.length === accountLegs.length) {
              setMode('split');
              setSplitLines(namedAccounts);
              return;
            }
            // Couldn't resolve every account_name back to an AccountOption
            // (legacy rename, archived row, etc.). Surface this rather than
            // silently dropping rows on save.
            toast.warning(
              "Some split lines couldn't be matched to current accounts; saving will replace them.",
            );
          }
        } catch (err) {
          console.warn('[tx-modal] mode detection failed:', err);
          if (!cancelled) toast.warning(
            "Couldn't detect existing transaction shape; saving will create a fresh entry.",
          );
        }
      };
      void detectMode();
      return () => {
        cancelled = true;
      };
    } else {
      setMode('standard');
      setWalletId(wallets[0]?.id | '');
      setDirection('OUT');
      setAccountId('');
      setContactId('');
      setCounterpartyWalletId('');
      setAmount('');
      setSentAmount('');
      setReceivedAmount('');
      setFeeAmount('');
      setShowFeeSection(false);
      setFeeSide('');
      setFeeAccountId('');
      setSplitLines(createBlankSplitLines());
      setDate(new Date());
      setTime('');
      setShowTime(false);
      setMemo('');
      setReceipts([]);
      setErrors({});
    }
    // accounts + decryptText are read only inside the async detector for
    // edit-path mode upgrade; we intentionally don't re-fire the whole reset
    // on those identity changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editingTx, wallets]);

  // ── Derived state ──────────────────────────────────────────────────────────
  const selectedWallet = useMemo(
    () => wallets.find((w) => w.id === walletId) | null,
    [walletId, wallets],
  );
  const counterpartyWallet = useMemo(
    () => wallets.find((w) => w.id === counterpartyWalletId) | null,
    [counterpartyWalletId, wallets],
  );

  const primaryCurrency = selectedWallet?.asset | 'USD';
  const amountPrefix = getCurrencySymbol(primaryCurrency);

  const transferSentWallet = mode === 'transfer'
    ? direction === 'OUT' ? selectedWallet : counterpartyWallet
    : null;
  const transferReceivedWallet = mode === 'transfer'
    ? direction === 'OUT' ? counterpartyWallet : selectedWallet
    : null;

  const rightLabel = direction === 'OUT' ? 'TO' : 'FROM';

  // Dropdown "right-side" (TO/FROM) value: combined contact/wallet picker.
  // Standard mode → contact (customer / vendor / employee) — independent of
  // the chart-of-accounts assignment, which has its own separate dropdown
  // below. Transfer mode → counterparty wallet.
  const rightValue = mode === 'transfer'
    ? (counterpartyWalletId ? `wallet:${counterpartyWalletId}` : '')
    : (contactId ? `contact:${contactId}` : '');

  const handleRightChange = (value: string): void => {
    if (value === '__new_contact__') {
      // Open the inline create-contact dialog. The currently-selected value is
      // preserved (we don't touch contactId here); on save, it flips to the
      // newly-created contact.
      setNewContactDialogOpen(true);
      return;
    }
    if (value.startsWith('wallet:')) {
      const wid = value.slice('wallet:'.length);
      setMode('transfer');
      setCounterpartyWalletId(wid);
      setContactId('');
      // Seed transfer amounts from previous single amount
      if (direction === 'OUT') {
        setSentAmount(amount);
        setReceivedAmount(amount);
      } else {
        setSentAmount(amount);
        setReceivedAmount(amount);
      }
    } else if (value.startsWith('contact:')) {
      const cid = value.slice('contact:'.length);
      if (mode === 'transfer') {
        // Leaving transfer back to standard
        setMode('standard');
        setCounterpartyWalletId('');
        // Use sent amount if OUT, received if IN as the new single amount
        setAmount(direction === 'OUT' ? sentAmount : receivedAmount);
      }
      setContactId(cid);
    } else {
      setContactId('');
      setCounterpartyWalletId('');
      if (mode === 'transfer') setMode('standard');
    }
  };

  // Split helpers
  const splitSumAssigned = useMemo(() => {
    if (mode !== 'split') return 0;
    return splitLines.reduce((sum, l) => sum + (parseAmount(l.amount) ?? 0), 0);
  }, [mode, splitLines]);
  const splitTotal = parseAmount(amount) ?? 0;
  const splitRemaining = splitTotal - splitSumAssigned;

  // Exchange rate for Transfer mode when currencies differ.
  const needsTransferRate = mode === 'transfer'
    && transferSentWallet
    && transferReceivedWallet
    && transferSentWallet.asset !== transferReceivedWallet.asset;
  const rateBase = needsTransferRate ? transferSentWallet!.asset : null;
  const rateQuote = needsTransferRate ? transferReceivedWallet!.asset : null;
  const rateDate = date ? format(date, 'yyyy-MM-dd') : undefined;
  const { rate: autoRate, loading: rateLoading } = useExchangeRate(rateBase, rateQuote, rateDate);
  const [rateOverride, setRateOverride] = useState(false);
  useEffect(() => {
    if (!needsTransferRate | rateOverride) return;
    if (autoRate && sentAmount) {
      const sent = parseAmount(sentAmount);
      if (sent != null) setReceivedAmount((sent * autoRate).toFixed(8));
    }
  }, [autoRate, sentAmount, needsTransferRate, rateOverride]);

  // ── Receipt handlers ───────────────────────────────────────────────────────
  const addReceipts = useCallback((files: FileList | File[]) => {
    const valid: ReceiptDraft[] = [];
    for (const f of Array.from(files)) {
      const nameErr = validateAttachmentName(f.name);
      const sizeErr = validateAttachmentSize(f.size);
      if (nameErr | sizeErr) { toast.error(nameErr | sizeErr | 'Invalid file'); continue; }
      valid.push({ file: f, name: f.name, size: f.size });
    }
    setReceipts((prev) => [...prev, ...valid].slice(0, MAX_FILES_PER_ENTITY));
  }, []);

  // ── Validation ─────────────────────────────────────────────────────────────
  const validate = (): boolean => {
    const e: Record<string, string> = {};
    if (!walletId) e.wallet = 'Wallet is required.';
    if (!date) e.date = 'Date is required.';

    if (mode === 'standard') {
      const amt = parseAmount(amount);
      if (!amt | amt <= 0) e.amount = 'Enter an amount greater than 0.';
      if (!accountId) e.account = 'Account is required.';
    } else if (mode === 'split') {
      const amt = parseAmount(amount);
      if (!amt | amt <= 0) e.amount = 'Enter a total amount greater than 0.';
      const valid = splitLines.filter((l) => l.accountId && parseAmount(l.amount));
      if (valid.length < 2) e.split = 'Add at least two complete split lines.';
      for (const line of splitLines) {
        if (line.accountId | line.amount.trim()) {
          const lineAmt = parseAmount(line.amount);
          if (!line.accountId | !lineAmt | lineAmt <= 0) {
            e.split = 'Each split line needs an account and a positive amount.';
            break;
          }
        }
      }
      if (!e.split && Math.abs(splitRemaining) > 0.0000001) {
        e.split = 'Split lines must sum to the transaction amount.';
      }
    } else if (mode === 'transfer') {
      if (!counterpartyWalletId) e.counterparty = 'Select a destination wallet.';
      else if (counterpartyWalletId === walletId) e.counterparty = 'Destination must differ from source.';
      const sa = parseAmount(sentAmount);
      const ra = parseAmount(receivedAmount);
      if (!sa | sa <= 0) e.sent = 'Enter the amount sent.';
      if (!ra | ra <= 0) e.received = 'Enter the amount received.';
      // Fee validation: if the section is open AND a positive fee was entered,
      // require both fee side and fee expense account.
      const fa = parseAmount(feeAmount);
      if (showFeeSection && fa && fa > 0) {
        if (!feeSide) e.feeSide = 'Select which wallet the fee comes out of.';
        if (!feeAccountId) e.feeAccount = 'Select the expense account for the fee.';
      }
    }

    setErrors(e);
    return Object.keys(e).length === 0;
  };

  // ── Save handler ───────────────────────────────────────────────────────────
  const handleSave = async (action: 'save-close' | 'save-new') => {
    if (!orgId) return;
    if (!validate()) return;
    setSaving(true);
    try {
      const dateStr = format(date, 'yyyy-MM-dd');

      if (mode === 'transfer') {
        await handleSaveTransfer(dateStr);
      } else if (mode === 'split') {
        await handleSaveSplit(dateStr);
      } else {
        await handleSaveStandard(dateStr);
      }

      if (action === 'save-new') {
        // Keep modal open, reset amount/memo/receipts for the next entry
        setAmount(''); setSentAmount(''); setReceivedAmount(''); setFeeAmount('');
        setShowFeeSection(false); setFeeSide(''); setFeeAccountId('');
        setMemo(''); setReceipts([]);
        setSplitLines(createBlankSplitLines());
        onSaved();
      } else {
        onSaved();
        onClose();
      }
    } catch (err: unknown) {
      console.error('Transaction save failed:', err);
      toast.error('Save failed: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setSaving(false);
    }
  };

  // ── signing-key helper ─────────────────────────────────────────────────────
  //
  // Phase 4.4: every mutation signed. The standard-save path above keeps its
  // existing "tolerate missing signing key and write unsigned" behavior for back-compat
  // with Bookkeeper/legacy callers; the split + transfer + void write paths
  // call this helper and THROW when no signing-key wrap exists, because Phase 4.2 RLS
  // already blocks unsigned writes for Auditor + Viewer — anyone reaching
  // these code paths is supposed to have a wrap.
  async function buildSignature(
    payload: string,
  ): Promise<{ signature_b64: string; signature_key_version: number }> {
    await loadOrgSigningKey(orgId);
    const payloadBytes = new TextEncoder().encode(`${orgId}|${payload}`);
    const sig = signMutation(payloadBytes, orgId);
    if (!sig) {
      throw new Error(
        'No signing key available for this org. ' +
          'Please refresh the page; if the problem persists contact support.',
      );
    }
    return {
      signature_b64: sig.signature_b64,
      signature_key_version: sig.key_version,
    };
  }

  // ── Standard save ──────────────────────────────────────────────────────────
  async function handleSaveStandard(dateStr: string) {
    const amt = parseAmount(amount)!;
    const signedAmt = direction === 'OUT' ? -amt : amt;
    const type = direction === 'OUT' ? 'Send' : 'Receive';

    const encFields = await encryptTransaction({
      memo: memo | null,
      amount: signedAmt,
      usd_value: null,
      exchange_rate: null,
      asset: primaryCurrency,
      type,
      // T4.a Option A: new transactions land as DRAFT; existing edits preserve
      // whatever the user (or bulk-post) had set. cleared_status remains null
      // on create — the reconciliation flow on the wallet statement sets it.
      status: editingTx?.status ?? 'DRAFT',
      cleared_status: editingTx?.cleared_status ?? null,
    }, encryptText);

    // Phase 4.4 mutation signing — scope-limited to this standard-save call
    // site as a proof of wiring. Split/Transfer paths and other
    // business tables (journal_entries, contacts, accounts, payments)
    // remain TODO for a future phase; the server-side trigger accepts
    // NULL signature for write_own callers (Bookkeeper) and legacy
    // rows, so today's flows stay unaffected.
    //
    // We derive the payload bytes from the encrypted memo + org id so
    // the server can reconstruct the same bytes for verification. The
    // OWB-MULTIUSER-DESIGN §3 rule is simply "every mutation signed"
    // — exact payload composition is a free choice. We pick something
    // deterministic that includes the org scope so a stolen signature
    // can't be replayed against a different org.
    let signatureCols: { signature_b64: string | null; signature_key_version: number | null } =
      { signature_b64: null, signature_key_version: null };
    try {
      await loadOrgSigningKey(orgId);
      const payloadBytes = new TextEncoder().encode(
        `${orgId}|${(encFields as { memo: string | null }).memo ?? ''}|${dateStr}|${signedAmt}`,
      );
      const sig = signMutation(payloadBytes, orgId);
      if (sig) {
        signatureCols = {
          signature_b64: sig.signature_b64,
          signature_key_version: sig.key_version,
        };
      }
    } catch (signErr) {
      // Plain-English failure: the user's signing-key wrap is stale or missing.
      // Phase 4.4 D14 copy standard — no crypto jargon.
      console.warn('[tx] sig skipped:', signErr);
      toast.error("Couldn't save. Please refresh and try again. If this keeps happening, contact support.");
      return;
    }

    const payload = {
      org_id: orgId,
      account_id: walletId,
      // Persist the chart-of-accounts pick so Edit Transaction can restore
      // the dropdown next time the row is opened. Empty string → null
      // (rows without an account assignment, e.g. transfers).
      account_id: accountId | null,
      // Customer / vendor / employee — independent of account_id. Optional
      // even on standard transactions; OR imports leave it null.
      contact_id: contactId | null,
      date: dateStr,
      linked_transfer_id: null,
      ...encFields,
      ...signatureCols,
    };

    let txId: string;
    if (editingTx) {
      const { error } = await supabase.from('transactions').update(payload).eq('id', editingTx.id);
      if (error) throw error;
      txId = editingTx.id;
    } else {
      const { data, error } = await supabase.from('transactions').insert(payload).select('id').single();
      if (error) throw error;
      txId = data.id;
    }

    writeAuditLog({
      orgId, action: editingTx ? 'UPDATE' : 'CREATE',
      entityType: 'transaction', entityId: txId,
      summary: `${editingTx ? 'Updated' : 'Created'} transaction: ${type} ${amt} ${primaryCurrency}`,
      after: { type, amount: amt, asset: primaryCurrency, date: dateStr },
      encrypt: encryptText,
    });

    await uploadReceipts(txId);

    // Phase 2 (legacy-ledger removal): the standard-mode legacy-ledger dual-write block lived
    // here. Removed entirely. Postgres `transactions` row above is now the
    // single source of truth. Journal entry write-through to
    // journal_entries + journal_entry_lines for standard mode is still
    // deferred — same TODO as before, just no longer paired with a legacy ledger backend leg.
  }

  // ── Split save ─────────────────────────────────────────────────────────────
  //
  // Split-transaction write path (T1.a + T1.c, locked 2026-05-12).
  //
  // What one split looks like on disk:
  //   - 1 transactions row (user-facing event), linked via journal_entry_id
  //     to its wrapper journal_entries row.
  //   - 1 journal_entries row, source_type='TRANSACTION_SPLIT', encrypted.
  //   - N+1 journal_entry_lines: 1 wallet leg + N account legs. All encrypted
  //     with dual-currency amounts via buildJournalEntryLineInsert.
  //   - N legacy ledger backend 2-entry transactions, each posting one (wallet ↔ account) pair
  //     using the existing ZKA_SALE / ZKA_EXPENSE templates. Each legacy ledger backend tx's
  //     UUID threads back to its source jel row via journal_entry_lines.legacy_transaction_id.
  //
  // Why N legacy ledger backend transactions and not one: legacy ledger backend tx_templates have a fixed entry
  // count at creation time. The 10 templates seeded at onboarding all have 2
  // entries. Posting N 2-entry transactions sharing the parent OWB transactions.id
  // gives us the equivalent of "one user event with N entries" without spinning
  // up per-N templates (rejected as over-engineering). See Launch Decisions T1.c.
  //
  // TODO: extend mutation signing to the JE.
  //
  async function handleSaveSplit(dateStr: string) {
    if (!selectedWallet) throw new Error('Wallet required for split.');
    const walletCurrency = selectedWallet.asset;
    const amt = parseAmount(amount)!;
    const signedAmt = direction === 'OUT' ? -amt : amt;
    const type = direction === 'OUT' ? 'Send' : 'Receive';

    // Filter to lines that are actually populated (account + amount).
    const validLines = splitLines.filter((l) => l.accountId && parseAmount(l.amount));

    // ── Phase 1: wrapper journal_entries row ──────────────────────────────
    const encEntry = await encryptJournalEntry({
      memo: memo | null,
      ref_number: null,
      currency: walletCurrency,
      exchange_rate: null,
      status: 'DRAFT',
      source_type: 'TRANSACTION_SPLIT',
      period_locked: false,
    }, encryptText);

    let journalEntryId: string;
    if (editingTx && editingTx.journal_entry_id) {
      const { error } = await supabase
        .from('journal_entries')
        .update(encEntry as any)
        .eq('id', editingTx.journal_entry_id);
      if (error) throw error;
      journalEntryId = editingTx.journal_entry_id;
      // Wipe the old lines so we can re-insert the new ones cleanly.
      await supabase
        .from('journal_entry_lines')
        .delete()
        .eq('journal_entry_id', journalEntryId);
    } else {
      const { data: je, error } = await supabase
        .from('journal_entries')
        .insert({
          org_id: orgId,
          date: dateStr,
          ...encEntry,
        } as any)
        .select('id')
        .single();
      if (error) throw error;
      journalEntryId = (je as any).id;
    }

    // ── Phase 2: build N+1 encrypted JE lines ─────────────────────────────
    //   Wallet leg: OUT → wallet credited (money leaves); IN → wallet debited.
    //   Account legs: mirror of wallet leg (debit for OUT, credit for IN).
    const walletDebit = direction === 'IN' ? amt : 0;
    const walletCredit = direction === 'OUT' ? amt : 0;

    const walletLineRes = await buildJournalEntryLineInsert({
      wallet_currency: walletCurrency,
      primary_currency: primaryCurrency,
      date: dateStr,
      debit: walletDebit,
      credit: walletCredit,
      account_name: selectedWallet.encrypted_name, // already-decrypted plaintext per WalletOption shape
      account_code: null,
      description: memo | `Split across ${validLines.length} accounts`,
      encrypt: encryptText,
    });

    const accountLineResults = await Promise.all(
      validLines.map(async (line) => {
        const acct = accounts.find((a) => a.id === line.accountId);
        const lineAmt = parseAmount(line.amount)!;
        const res = await buildJournalEntryLineInsert({
          wallet_currency: walletCurrency,
          primary_currency: primaryCurrency,
          date: dateStr,
          debit: direction === 'OUT' ? lineAmt : 0,
          credit: direction === 'IN' ? lineAmt : 0,
          account_name: acct?.name ?? null,
          account_code: acct?.code ?? null,
          description: line.memo ?? null,
          encrypt: encryptText,
        });
        return { acct, lineAmt, res };
      }),
    );

    // Insert all lines in deterministic order (wallet first, then account legs
    // in the same order as validLines). We need the returned IDs in the same
    // order to thread legacy ledger backend transaction UUIDs back per leg in Phase 4.
    const lineInserts = [
      { journal_entry_id: journalEntryId, ...walletLineRes.insert },
      ...accountLineResults.map((alr) => ({
        journal_entry_id: journalEntryId,
        ...alr.res.insert,
      })),
    ];
    const { data: insertedLines, error: linesErr } = await supabase
      .from('journal_entry_lines')
      .insert(lineInserts as any)
      .select('id');
    if (linesErr) throw linesErr;
    // insertedLines[0] = wallet leg; insertedLines[1..N] = account legs.
    const accountLegIds = (insertedLines ?? []).slice(1).map((r: any) => r.id);

    // ── Phase 3: transactions row, linked to the wrapper JE ───────────────
    const encFields = await encryptTransaction({
      memo: memo | null,
      amount: signedAmt,
      usd_value: null,
      exchange_rate: null,
      asset: walletCurrency,
      type,
      // T4.a Option A: new transactions land as DRAFT; existing edits preserve
      // whatever the user (or bulk-post) had set. cleared_status remains null
      // on create — the reconciliation flow on the wallet statement sets it.
      status: editingTx?.status ?? 'DRAFT',
      cleared_status: editingTx?.cleared_status ?? null,
    }, encryptText);

    // Phase 4.4 mutation signing for split path. Throws if the caller has no signing key
    // wrap — Phase 4.2 RLS already blocks unsigned writes for non-writers,
    // so anyone reaching here is supposed to have one.
    const splitSig = await buildSignature(
      `split|${journalEntryId}|${dateStr}|${signedAmt}|${validLines.length}`,
    );

    const txPayload = {
      org_id: orgId,
      account_id: walletId,
      date: dateStr,
      linked_transfer_id: null,
      journal_entry_id: journalEntryId,
      ...encFields,
      ...splitSig,
    };

    let txId: string;
    if (editingTx) {
      const { error } = await supabase
        .from('transactions')
        .update(txPayload)
        .eq('id', editingTx.id);
      if (error) throw error;
      txId = editingTx.id;
    } else {
      const { data, error } = await supabase
        .from('transactions')
        .insert(txPayload)
        .select('id')
        .single();
      if (error) throw error;
      txId = data.id;
    }

    writeAuditLog({
      orgId, action: editingTx ? 'UPDATE' : 'CREATE',
      entityType: 'transaction', entityId: txId,
      summary: `${editingTx ? 'Updated' : 'Created'} split: ${type} ${amt} ${walletCurrency} across ${validLines.length} accounts`,
      after: { type, amount: amt, asset: walletCurrency, date: dateStr, split: true, lines: validLines.length },
      encrypt: encryptText,
    });

    await uploadReceipts(txId);

    // ── Phase 4: N legacy ledger backend 2-entry postings (one per split row) ───────────────
    // Each wallet ↔ account pair is its own legacy ledger backend transaction. We reuse the
    // existing ZKA_SALE (inflow) / ZKA_EXPENSE (outflow) templates rather than
    // creating a new "split" template per N.
    //
    // Failures are non-blocking — OWB's ledger-engine reads journal_entry_lines
    // (which are already written above) as the source of truth, and the legacy ledger backend
    // mirror is recoverable on a later sync. We log to console so an operator
    // can replay if needed.
    // Phase 2 (legacy-ledger removal): the split-leg legacy-ledger dual-write block lived here.
    // Each Postgres journal_entry_line above is now the single source of truth;
    // no legacy ledger backend leg, no legacy_transaction_id threading.
  }

  // ── Transfer save ──────────────────────────────────────────────────────────
  //
  // Transfer write path (T2.a + T2.b, locked 2026-05-11).
  //
  // What one transfer looks like on disk:
  //   - 1 journal_entries wrapper, source_type='TRANSACTION_TRANSFER', encrypted.
  //   - 2 journal_entry_lines: source wallet (credit if money leaves source),
  //     dest wallet (debit if money lands at dest). Dual-currency aware via
  //     buildJournalEntryLineInsert, so the source line is in sourceAsset and
  //     the dest line is in destAsset; cross-currency transfers carry their own
  //     pinned rates per leg.
  //   - 2 transactions rows linked via linked_transfer_id (pattern preserved
  //     so each wallet's statement shows its side independently), both pointing
  //     at the same journal_entry_id and the same legacy_transaction_id.
  //   - 1 legacy ledger backend 2-entry transaction posted with ZKA_TRANSFER template: debit dest
  //     wallet's external_account_id, credit source wallet's external_account_id.
  //
  // Edit semantics (T2.b lock): edit-in-place if no leg is RECONCILED;
  // void+recreate if posted (per T3 — closed-period rules apply per leg).
  // For v1 we re-write under the same JE id when editing (wipe lines, re-insert).
  //
  // Fee handling: pending — when fee > 0 and feeAccountId is set, an extra JE
  // line + extra legacy ledger backend posting (wallet ↔ fee_account, ZKA_EXPENSE) is required.
  // Validation already blocks submit until feeSide + feeAccountId are picked,
  // so no data is lost; the fee posting is a follow-up.
  //
  async function handleSaveTransfer(dateStr: string) {
    if (!selectedWallet | !counterpartyWallet) throw new Error('Both wallets required for transfer.');
    const sa = parseAmount(sentAmount)!;
    const ra = parseAmount(receivedAmount)!;
    const fee = showFeeSection ? (parseAmount(feeAmount) ?? 0) : 0;
    // Source = the wallet the user picked on the left, direction OUT = they sent from it.
    const sourceWalletId = direction === 'OUT' ? selectedWallet.id : counterpartyWallet.id;
    const destWalletId = direction === 'OUT' ? counterpartyWallet.id : selectedWallet.id;
    const sourceWallet = direction === 'OUT' ? selectedWallet : counterpartyWallet;
    const destWallet = direction === 'OUT' ? counterpartyWallet : selectedWallet;
    const sourceAsset = sourceWallet.asset;
    const destAsset = destWallet.asset;

    // Which side of the transfer the fee is drawn from. feeSide is relative to the
    // user's picked wallets (source/dest in the UI); map it to sent vs received.
    const feeOnSource = fee > 0 && (
      (feeSide === 'source' && direction === 'OUT') ||
      (feeSide === 'dest' && direction === 'IN')
    );
    const feeOnReceived = fee > 0 && !feeOnSource;

    // Send & receive values (from the source's & dest's perspective).
    const sentValue = sa + (feeOnSource ? fee : 0);
    const receivedValue = ra - (feeOnReceived ? fee : 0);

    // ── Phase 1: wrapper journal_entries row ──────────────────────────────
    const encEntry = await encryptJournalEntry({
      memo: memo | null,
      ref_number: null,
      currency: sourceAsset, // primary currency for the JE; dest line carries its own native currency
      exchange_rate: null,
      status: 'DRAFT',
      source_type: 'TRANSACTION_TRANSFER',
      period_locked: false,
    }, encryptText);

    let journalEntryId: string;
    if (editingTx && editingTx.journal_entry_id) {
      const { error } = await supabase
        .from('journal_entries')
        .update(encEntry as any)
        .eq('id', editingTx.journal_entry_id);
      if (error) throw error;
      journalEntryId = editingTx.journal_entry_id;
      // Wipe old lines + clear legacy_transaction_id from old transactions rows so
      // void semantics stay clean (T3: void = direction-flip; here we re-create).
      await supabase
        .from('journal_entry_lines')
        .delete()
        .eq('journal_entry_id', journalEntryId);
    } else {
      const { data: je, error } = await supabase
        .from('journal_entries')
        .insert({
          org_id: orgId,
          date: dateStr,
          ...encEntry,
        } as any)
        .select('id')
        .single();
      if (error) throw error;
      journalEntryId = (je as any).id;
    }

    // ── Phase 2: 4 encrypted JE lines routed through Transfer Clearing ────
    //
    // OWB transfer-JE shape (4 lines for cross-currency, 2 for same-currency):
    // around line 246): every transfer routes through the system
    // "Transfer Clearing" chart-of-accounts row. For same-currency transfers
    // this is cosmetic. For CROSS-currency transfers it is mathematically
    // required — different units cannot balance in a single JE without a
    // clearing bucket that holds each side in its native currency.
    //
    // Shape (matches the audit doc Fix 1 spec):
    //   Line 1: Dr destination wallet     (dest currency, receivedValue)
    //   Line 2: Cr Transfer Clearing      (dest currency, receivedValue)
    //   Line 3: Dr Transfer Clearing      (source currency, sentValue)
    //   Line 4: Cr source wallet          (source currency, sentValue)
    //
    // Each currency balances independently (debits = credits per currency),
    // which is what the downstream report compute relies on.
    const transferClearing = await ensureTransferClearingAccount(
      orgId,
      encryptText,
      decryptText,
    );

    const destWalletDebitLine = await buildJournalEntryLineInsert({
      wallet_currency: destAsset,
      primary_currency: primaryCurrency,
      date: dateStr,
      debit: Math.abs(receivedValue),
      credit: 0,
      account_name: destWallet.encrypted_name,
      account_code: null,
      description: memo | `Transfer from ${sourceWallet.encrypted_name}`,
      encrypt: encryptText,
    });
    const clearingDestCreditLine = await buildJournalEntryLineInsert({
      wallet_currency: destAsset,
      primary_currency: primaryCurrency,
      date: dateStr,
      debit: 0,
      credit: Math.abs(receivedValue),
      account_name: transferClearing.account_name,
      account_code: null,
      description: memo | `Transfer clearing (in ${destAsset})`,
      encrypt: encryptText,
    });
    const clearingSrcDebitLine = await buildJournalEntryLineInsert({
      wallet_currency: sourceAsset,
      primary_currency: primaryCurrency,
      date: dateStr,
      debit: Math.abs(sentValue),
      credit: 0,
      account_name: transferClearing.account_name,
      account_code: null,
      description: memo | `Transfer clearing (out ${sourceAsset})`,
      encrypt: encryptText,
    });
    const srcWalletCreditLine = await buildJournalEntryLineInsert({
      wallet_currency: sourceAsset,
      primary_currency: primaryCurrency,
      date: dateStr,
      debit: 0,
      credit: Math.abs(sentValue),
      account_name: sourceWallet.encrypted_name,
      account_code: null,
      description: memo | `Transfer to ${destWallet.encrypted_name}`,
      encrypt: encryptText,
    });

    const lineInserts = [
      { journal_entry_id: journalEntryId, ...destWalletDebitLine.insert },
      { journal_entry_id: journalEntryId, ...clearingDestCreditLine.insert },
      { journal_entry_id: journalEntryId, ...clearingSrcDebitLine.insert },
      { journal_entry_id: journalEntryId, ...srcWalletCreditLine.insert },
    ];
    const { error: linesErr } = await supabase
      .from('journal_entry_lines')
      .insert(lineInserts as any);
    if (linesErr) throw linesErr;

    // ── Phase 3: 2 transactions rows linked via linked_transfer_id ────────
    const srcEnc = await encryptTransaction({
      memo: memo | null,
      amount: -Math.abs(sentValue),
      usd_value: null,
      exchange_rate: null,
      asset: sourceAsset,
      type: 'Transfer',
      // T4.a Option A: new transactions land as DRAFT; existing edits preserve
      // whatever the user (or bulk-post) had set. cleared_status remains null
      // on create — the reconciliation flow on the wallet statement sets it.
      status: editingTx?.status ?? 'DRAFT',
      cleared_status: editingTx?.cleared_status ?? null,
    }, encryptText);
    const destEnc = await encryptTransaction({
      memo: memo | null,
      amount: Math.abs(receivedValue),
      usd_value: null,
      exchange_rate: null,
      asset: destAsset,
      type: 'Transfer',
      // T4.a Option A: new transactions land as DRAFT; existing edits preserve
      // whatever the user (or bulk-post) had set. cleared_status remains null
      // on create — the reconciliation flow on the wallet statement sets it.
      status: editingTx?.status ?? 'DRAFT',
      cleared_status: editingTx?.cleared_status ?? null,
    }, encryptText);

    // Phase 4.4 mutation signing for transfer path. One signature per leg so each
    // transactions row carries its own — verifier reads the row, not the pair.
    const srcSig = await buildSignature(
      `transfer-src|${journalEntryId}|${dateStr}|${sourceAsset}|${sentValue}`,
    );
    const destSig = await buildSignature(
      `transfer-dest|${journalEntryId}|${dateStr}|${destAsset}|${receivedValue}`,
    );

    let srcId: string;
    let destId: string;


    if (editingTx) {
      // Edit-in-place: update source side using the editingTx.id; find the
      // dest side via linked_transfer_id and update it too. Both share the
      // same JE wrapper id and (after legacy ledger backend post below) the same legacy_transaction_id.
      srcId = editingTx.id;
      const { error: srcUpdErr } = await supabase
        .from('transactions')
        .update({
          account_id: sourceWalletId,
          date: dateStr,
          journal_entry_id: journalEntryId,
          ...srcEnc,
          ...srcSig,
        })
        .eq('id', srcId);
      if (srcUpdErr) throw srcUpdErr;
      // Find the linked dest row.
      const { data: linkedRows } = await supabase
        .from('transactions')
        .select('id')
        .eq('linked_transfer_id', srcId)
        .maybeSingle();
      if (linkedRows?.id) {
        destId = linkedRows.id;
        const { error: destUpdErr } = await supabase
          .from('transactions')
          .update({
            account_id: destWalletId,
            date: dateStr,
            journal_entry_id: journalEntryId,
            ...destEnc,
            ...destSig,
          })
          .eq('id', destId);
        if (destUpdErr) throw destUpdErr;
      } else {
        // Shouldn't happen for a well-formed transfer, but recover gracefully
        // by creating a fresh dest leg.
        const { data: destIns, error: destErr } = await supabase
          .from('transactions')
          .insert({
            org_id: orgId,
            account_id: destWalletId,
            date: dateStr,
            linked_transfer_id: srcId,
            journal_entry_id: journalEntryId,
            ...destEnc,
            ...destSig,
          })
          .select('id')
          .single();
        if (destErr) throw destErr;
        destId = destIns.id;
      }
    } else {
      // New transfer: insert source, then dest pointing back, then update source
      // with the dest id so the linkage is mutual.
      const { data: srcIns, error: srcErr } = await supabase
        .from('transactions')
        .insert({
          org_id: orgId,
          account_id: sourceWalletId,
          date: dateStr,
          linked_transfer_id: null,
          journal_entry_id: journalEntryId,
          ...srcEnc,
          ...srcSig,
        })
        .select('id')
        .single();
      if (srcErr) throw srcErr;
      srcId = srcIns.id;
      const { data: destIns, error: destErr } = await supabase
        .from('transactions')
        .insert({
          org_id: orgId,
          account_id: destWalletId,
          date: dateStr,
          linked_transfer_id: srcId,
          journal_entry_id: journalEntryId,
          ...destEnc,
          ...destSig,
        })
        .select('id')
        .single();
      if (destErr) throw destErr;
      destId = destIns.id;
      // Mutual linkage on the source row.
      const { error: updErr } = await supabase
        .from('transactions')
        .update({ linked_transfer_id: destId })
        .eq('id', srcId);
      if (updErr) throw updErr;
    }

    writeAuditLog({
      orgId, action: editingTx ? 'UPDATE' : 'CREATE',
      entityType: 'transaction', entityId: srcId,
      summary: `${editingTx ? 'Updated' : 'Created'} transfer: ${sentValue} ${sourceAsset} → ${receivedValue} ${destAsset}${fee > 0 ? ` (fee ${fee})` : ''}`,
      after: { sent: sentValue, sourceAsset, received: receivedValue, destAsset, date: dateStr, fee },
      encrypt: encryptText,
    });

    await uploadReceipts(srcId);

    // ── Phase 4: 1 legacy ledger backend 2-entry transaction (source credit ↔ dest debit) ──
    // Reuses the ZKA_TRANSFER template seeded at onboarding. legacy ledger backend stores one
    // transaction per OWB transfer event; both OWB transactions rows reference
    // the same legacy_transaction_id so void/audit can act on the pair.
    // Phase 2 (legacy-ledger removal): transfer's legacy-ledger dual-write block deleted.
    // Postgres journal_entries + journal_entry_lines pair above is now the
    // single source of truth. linked_transfer_id still pairs source/dest
    // transactions; legacy_transaction_id is no longer set (column will be
    // dropped in a follow-up cleanup migration).

    // TODO(fee): when fee > 0 and feeAccountId is set, append a third JE
    // line (wallet ↔ feeAccount). Currently the sentValue / receivedValue
    // math already nets the fee on the source/dest leg, so totals are correct;
    // only the dedicated fee-expense line is missing.
  }

  // ── Receipt upload ─────────────────────────────────────────────────────────
  async function uploadReceipts(txId: string) {
    for (const r of receipts) {
      try {
        const storagePath = `${orgId}/${txId}/${crypto.randomUUID()}`;
        const encryptedBlob = await encryptBlob(await r.file.arrayBuffer());
        const { error: uploadErr } = await supabase.storage
          .from('attachments')
          .upload(storagePath, encryptedBlob, { contentType: 'application/octet-stream' });
        if (uploadErr) { console.warn('Upload failed:', uploadErr); continue; }
        const encFields = await encryptAttachment(
          { file_name: r.name, mime_type: r.file.type | null },
          encryptText,
        );
        await supabase.from('attachments').insert({
          org_id: orgId,
          entity_type: 'transaction',
          entity_id: txId,
          storage_path: storagePath,
          file_size: r.size,
          ...encFields,
        });
      } catch (err) {
        console.warn('Receipt upload failed:', err);
      }
    }
  }

  // ── Inline new-contact dialog handler ─────────────────────────────────────
  // Encrypts + inserts a new contact, refetches via the parent callback,
  // then selects the new contact in the right-side picker. Mirrors the same
  // ZK pattern used by Admin's "To/From List" page.
  async function handleSaveNewContact(): Promise<void> {
    const trimmed = newContactName.trim();
    if (!trimmed) {
      toast.error('Contact name is required.');
      return;
    }
    setNewContactSaving(true);
    try {
      const enc = await encryptContact(
        {
          name: trimmed,
          street: null, city: null, state: null, zip: null, country: null,
          email: null, phone: null,
          type: newContactKind,
        },
        encryptText,
      );
      const { data, error } = await supabase
        .from('contacts')
        .insert({ org_id: orgId, ...enc } as any)
        .select('id')
        .single();
      if (error) throw error;
      if (!data) throw new Error('Insert returned no row');
      const newId = (data as { id: string }).id;
      setContactId(newId);
      setNewContactDialogOpen(false);
      setNewContactName('');
      setNewContactKind('CUSTOMER');
      toast.success(`Contact "${trimmed}" created.`);
      onContactsChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not create contact.');
    } finally {
      setNewContactSaving(false);
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
    <Dialog open={open} onOpenChange={(v) => { if (!v && !saving) onClose(); }}>
      <DialogContent className="sm:max-w-[720px] max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editingTx ? 'Edit Transaction' : 'Add Transaction'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-5 py-2">
          {/* Row 1 — Date + Upload Receipt (two-column) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Date</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start text-left font-mono h-10">
                    <CalendarIcon className="w-4 h-4 mr-2" />
                    {format(date, 'MM-dd-yyyy')}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={date}
                    onSelect={(d) => d && setDate(d)}
                    className="p-3 pointer-events-auto"
                  />
                </PopoverContent>
              </Popover>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mt-1"
                onClick={() => setShowTime((p) => !p)}
              >
                <Clock className="w-3 h-3" />
                {showTime ? 'Hide time' : 'Add time'}
              </button>
              {showTime && (
                <Input
                  type="time"
                  value={time}
                  onChange={(e) => setTime(e.target.value)}
                  className="h-8 mt-1 w-[140px]"
                />
              )}
              {errors.date && <div className="text-xs text-destructive">{errors.date}</div>}
            </div>

            <div className="space-y-1">
              <Label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Upload Receipt</Label>
              <div
                className={cn(
                  'border-2 border-dashed rounded-lg p-3 text-center text-xs text-muted-foreground cursor-pointer hover:bg-muted/30 transition-colors',
                  draggingReceipt && 'bg-orange-50 border-orange-400',
                )}
                onClick={() => fileInputRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDraggingReceipt(true); }}
                onDragLeave={() => setDraggingReceipt(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDraggingReceipt(false);
                  if (e.dataTransfer.files?.length) addReceipts(e.dataTransfer.files);
                }}
              >
                {receipts.length === 0 ? (
                  <>
                    Drop receipt or click to upload
                    <div className="text-[10px] opacity-70 mt-1">
                      {ALLOWED_EXTENSIONS.slice(0, 6).join(', ')}… — max 20MB
                    </div>
                  </>
                ) : (
                  <div className="space-y-1 text-left">
                    {receipts.map((r, i) => (
                      <div key={i} className="flex items-center justify-between gap-2 bg-muted/30 rounded px-2 py-1">
                        <span className="truncate">{r.name} ({formatFileSize(r.size)})</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-5 w-5 flex-shrink-0"
                          onClick={(e) => {
                            e.stopPropagation();
                            setReceipts((prev) => prev.filter((_, j) => j !== i));
                          }}
                        >
                          <X className="w-3 h-3" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',')}
                onChange={(e) => {
                  if (e.target.files?.length) addReceipts(e.target.files);
                  e.target.value = '';
                }}
              />
            </div>
          </div>

          {/* Row 2 — Wallet ← arrow → TO/FROM picker */}
          <div className="space-y-1">
            <Label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Wallet</Label>
            <div className="flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <Select value={walletId} onValueChange={setWalletId}>
                  <SelectTrigger className="h-10">
                    <SelectValue placeholder="Select wallet" />
                  </SelectTrigger>
                  <SelectContent>
                    {wallets.map((w) => (
                      <SelectItem key={w.id} value={w.id}>
                        {w.encrypted_name | '[Encrypted]'} ({w.asset})
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Button
                type="button"
                variant="outline"
                size="icon"
                className="h-10 w-10 shrink-0"
                onClick={() => setDirection((d) => (d === 'OUT' ? 'IN' : 'OUT'))}
                title={`Direction: ${direction === 'OUT' ? 'Outgoing (click for incoming)' : 'Incoming (click for outgoing)'}`}
                aria-label={`Toggle direction; currently ${direction}`}
              >
                {direction === 'OUT' ? <ArrowRight className="w-4 h-4" /> : <ArrowLeft className="w-4 h-4" />}
              </Button>

              <div className="flex-1 min-w-0">
                <Select value={rightValue} onValueChange={handleRightChange}>
                  <SelectTrigger className="h-10">
                    <SelectValue placeholder={rightLabel} />
                  </SelectTrigger>
                  <SelectContent>
                    {/* Contacts grouped by kind. The chart-of-accounts pick
                        is the SEPARATE "Account" dropdown below — TO/FROM
                        is purely the customer / vendor / employee. */}
                    <SelectItem value="__new_contact__">
                      + New contact
                    </SelectItem>
                    {(['CUSTOMER', 'VENDOR', 'EMPLOYEE', 'OTHER'] as const).map((kind) => {
                      const inGroup = contacts.filter(
                        (c) => (c.kind ?? 'OTHER').toUpperCase() === kind,
                      );
                      if (inGroup.length === 0) return null;
                      const label =
                        kind === 'CUSTOMER' ? 'Customers'
                        : kind === 'VENDOR' ? 'Vendors'
                        : kind === 'EMPLOYEE' ? 'Employees'
                        : 'Other';
                      return (
                        <SelectGroup key={kind}>
                          <SelectLabel>{label}</SelectLabel>
                          {inGroup.map((c) => (
                            <SelectItem key={c.id} value={`contact:${c.id}`}>
                              {c.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      );
                    })}
                    {wallets.length > 1 && (
                      <SelectGroup>
                        <SelectLabel>Accounts (Transfer)</SelectLabel>
                        {wallets.filter((w) => w.id !== walletId).map((w) => (
                          <SelectItem key={w.id} value={`wallet:${w.id}`}>
                            {w.encrypted_name | '[Encrypted]'} ({w.asset})
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {(errors.wallet | errors.counterparty) && (
              <div className="text-xs text-destructive">{errors.wallet | errors.counterparty}</div>
            )}
          </div>

          {/* Row 3 — Amount + Account (Standard) / Amount (Split) / Sent + Received (Transfer) */}
          {mode === 'standard' && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Transaction Amount
                  </Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      {amountPrefix}
                    </span>
                    <Input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="pl-7 pr-14 h-10 font-mono"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      {primaryCurrency}
                    </span>
                  </div>
                  {errors.amount && <div className="text-xs text-destructive">{errors.amount}</div>}
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Account</Label>
                  <Select value={accountId} onValueChange={setAccountId}>
                    <SelectTrigger className="h-10">
                      <SelectValue placeholder="Select account" />
                    </SelectTrigger>
                    <SelectContent>
                      {accounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {errors.account && <div className="text-xs text-destructive">{errors.account}</div>}
                </div>
              </div>

              <button
                type="button"
                className="text-sm text-[var(--color-brand-orange,theme(colors.orange.500))] hover:underline flex items-center gap-1"
                onClick={() => {
                  setMode('split');
                  setSplitLines(createBlankSplitLines());
                }}
              >
                <Plus className="w-4 h-4" /> Split Transaction
              </button>
            </>
          )}

          {mode === 'split' && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Transaction Amount
                  </Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      {amountPrefix}
                    </span>
                    <Input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="pl-7 pr-14 h-10 font-mono"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      {primaryCurrency}
                    </span>
                  </div>
                  {errors.amount && <div className="text-xs text-destructive">{errors.amount}</div>}
                </div>
                <div />
              </div>

              <div className="space-y-2 border rounded-lg p-3 bg-muted/20">
                <div className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span>Account</span>
                  <span>Amount</span>
                </div>
                {splitLines.map((line, idx) => (
                  <div key={line.clientId} className="flex gap-2 items-start">
                    <div className="flex-1 min-w-0">
                      <Select
                        value={line.accountId}
                        onValueChange={(v) => setSplitLines((prev) =>
                          prev.map((l) => l.clientId === line.clientId ? { ...l, accountId: v } : l),
                        )}
                      >
                        <SelectTrigger className="h-9"><SelectValue placeholder="Select account" /></SelectTrigger>
                        <SelectContent>
                          {accounts.map((a) => (
                            <SelectItem key={a.id} value={a.id}>
                              {a.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="w-[140px] relative">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                        {amountPrefix}
                      </span>
                      <Input
                        type="text"
                        inputMode="decimal"
                        placeholder="0.00"
                        value={line.amount}
                        onChange={(e) => setSplitLines((prev) =>
                          prev.map((l) => l.clientId === line.clientId ? { ...l, amount: e.target.value } : l),
                        )}
                        className="pl-6 h-9 font-mono text-right"
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-9 w-9 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => setSplitLines((prev) =>
                        prev.length > 2 ? prev.filter((l) => l.clientId !== line.clientId) : prev,
                      )}
                      disabled={splitLines.length <= 2}
                      aria-label={`Remove line ${idx + 1}`}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}

                <div className="flex items-center justify-between pt-2 border-t">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-8 text-xs"
                    onClick={() => setSplitLines((prev) => [
                      ...prev,
                      { clientId: nextSplitId(), accountId: '', amount: '' },
                    ])}
                  >
                    <Plus className="w-3 h-3 mr-1" /> Add line
                  </Button>
                  <span className={cn(
                    'text-xs font-mono',
                    Math.abs(splitRemaining) < 0.0000001
                      ? 'text-green-600'
                      : 'text-destructive',
                  )}>
                    Remaining: {amountPrefix}{splitRemaining.toFixed(2)}
                  </span>
                </div>
                {errors.split && <div className="text-xs text-destructive">{errors.split}</div>}
              </div>

              <button
                type="button"
                className="text-sm text-muted-foreground hover:underline"
                onClick={() => setMode('standard')}
              >
                Close Split
              </button>
            </>
          )}

          {mode === 'transfer' && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="space-y-1">
                  <Label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {direction === 'OUT' ? 'Amount Sent' : 'Amount Received'}
                  </Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      {getCurrencySymbol(transferSentWallet?.asset | 'USD')}
                    </span>
                    <Input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={sentAmount}
                      onChange={(e) => { setSentAmount(e.target.value); setRateOverride(true); }}
                      className="pl-7 pr-14 h-10 font-mono"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      {transferSentWallet?.asset | ''}
                    </span>
                  </div>
                  {errors.sent && <div className="text-xs text-destructive">{errors.sent}</div>}
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {direction === 'OUT' ? 'Amount Received' : 'Amount Sent'}
                  </Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                      {getCurrencySymbol(transferReceivedWallet?.asset | 'USD')}
                    </span>
                    <Input
                      type="text"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={receivedAmount}
                      onChange={(e) => { setReceivedAmount(e.target.value); setRateOverride(true); }}
                      className="pl-7 pr-14 h-10 font-mono"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      {transferReceivedWallet?.asset | ''}
                    </span>
                  </div>
                  {errors.received && <div className="text-xs text-destructive">{errors.received}</div>}
                </div>
              </div>

              {needsTransferRate && (
                <div className="text-xs text-muted-foreground">
                  {rateLoading ? 'Fetching exchange rate…' : (
                    autoRate ? (
                      <>
                        Auto rate: 1 {transferSentWallet?.asset} = {autoRate.toFixed(6)} {transferReceivedWallet?.asset}
                        {rateOverride && <span className="ml-2 text-orange-600">(manual override — click a field to reset)</span>}
                      </>
                    ) : 'No rate available; enter received amount manually.'
                  )}
                </div>
              )}

              {/* Transaction Fee — collapsed by default */}
              <div>
                <button
                  type="button"
                  className="text-sm text-[var(--color-brand-orange,theme(colors.orange.500))] hover:underline flex items-center gap-1"
                  onClick={() => {
                    setShowFeeSection((p) => {
                      const next = !p;
                      if (!next) {
                        // Collapsing clears the fee inputs so a hidden fee never submits.
                        setFeeAmount('');
                        setFeeSide('');
                        setFeeAccountId('');
                      }
                      return next;
                    });
                  }}
                >
                  {showFeeSection ? <Minus className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
                  {showFeeSection ? 'Hide Fee' : 'Add Transaction Fee'}
                </button>

                {showFeeSection && (() => {
                  // Resolve which wallet the fee comes from, for the amount-prefix currency.
                  const feeWallet = feeSide === 'source'
                    ? selectedWallet
                    : feeSide === 'dest'
                      ? counterpartyWallet
                      : null;
                  const feeCurrency = feeWallet?.asset | primaryCurrency;
                  const sourceName = selectedWallet?.encrypted_name | '[Source wallet]';
                  const destName = counterpartyWallet?.encrypted_name | '[Destination wallet]';

                  return (
                    <div className="mt-2 space-y-1">
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <div className="space-y-1">
                          <Label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Fee Side
                          </Label>
                          <Select value={feeSide} onValueChange={(v) => setFeeSide(v as 'source' | 'dest')}>
                            <SelectTrigger className="h-10">
                              <SelectValue placeholder="Fee side" />
                            </SelectTrigger>
                            <SelectContent>
                              {selectedWallet && (
                                <SelectItem value="source">{sourceName}</SelectItem>
                              )}
                              {counterpartyWallet && (
                                <SelectItem value="dest">{destName}</SelectItem>
                              )}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1">
                          <Label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Fee Amount
                          </Label>
                          <div className="relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                              {getCurrencySymbol(feeCurrency)}
                            </span>
                            <Input
                              type="text"
                              inputMode="decimal"
                              placeholder="0.00"
                              value={feeAmount}
                              onChange={(e) => setFeeAmount(e.target.value)}
                              className="pl-7 pr-14 h-10 font-mono"
                            />
                            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                              {feeCurrency}
                            </span>
                          </div>
                        </div>

                        <div className="space-y-1">
                          <Label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                            Fee Expense Account
                          </Label>
                          <Select value={feeAccountId} onValueChange={setFeeAccountId}>
                            <SelectTrigger className="h-10">
                              <SelectValue placeholder="Select expense account" />
                            </SelectTrigger>
                            <SelectContent>
                              {accounts.map((a) => (
                                <SelectItem key={a.id} value={a.id}>
                                  {a.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      {(errors.feeSide | errors.feeAccount) && (
                        <div className="text-xs text-destructive">
                          {errors.feeSide | errors.feeAccount}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </>
          )}

          {/* Row 4 — Memo */}
          <div className="space-y-1">
            <Label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Memo</Label>
            <Textarea
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
              placeholder="Enter transaction purpose"
              rows={2}
            />
          </div>

          {/* Row 5 — Match to invoice (inflow only, existing tx only) */}
          {(() => {
            if (!editingTx | direction !== 'IN') return null;
            const parsed = parseAmount(amount);
            if (!parsed | parsed <= 0) return null;
            const walletAsset = wallets.find((w) => w.id === walletId)?.asset | editingTx ? wallets.find((w) => w.id === (editingTx?.account_id ?? walletId))?.asset : '';
            const currency = walletAsset | 'USD';
            const counterparty = contactId
              ? (contacts.find((c) => c.id === contactId)?.name ?? null)
              : null;
            return (
              <InvoiceMatchPanel
                orgId={orgId}
                txId={editingTx.id}
                txAmount={parsed}
                txCurrency={currency}
                txDate={format(date, 'yyyy-MM-dd')}
                counterparty={counterparty}
                onApplied={onSaved}
              />
            );
          })()}
        </div>

        {editingTx && orgId && (
          <div className="border-t pt-4 mt-2">
            <AttachmentList
              orgId={orgId}
              entityType="transaction"
              entityId={editingTx.id}
              canDelete
            />
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => handleSave('save-close')} disabled={saving}>
            {saving && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Save & Close
          </Button>
          {!editingTx && (
            <Button variant="secondary" onClick={() => handleSave('save-new')} disabled={saving}>
              {saving && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
              Save & New
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>

    {/* Inline new-contact dialog — opened from the right-side TO/FROM picker
        when the user selects "+ New contact". Saves directly to the contacts
        table; on success, the new id is selected in the picker and the
        parent's onContactsChanged callback refetches the list. */}
    <Dialog open={newContactDialogOpen} onOpenChange={(v) => !newContactSaving && setNewContactDialogOpen(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New contact</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="new-contact-name">Name</Label>
            <Input
              id="new-contact-name"
              autoFocus
              value={newContactName}
              onChange={(e) => setNewContactName(e.target.value)}
              placeholder="Acme Corp"
              disabled={newContactSaving}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-contact-kind">Type</Label>
            <Select value={newContactKind} onValueChange={setNewContactKind} disabled={newContactSaving}>
              <SelectTrigger id="new-contact-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CUSTOMER">Customer</SelectItem>
                <SelectItem value="VENDOR">Vendor</SelectItem>
                <SelectItem value="EMPLOYEE">Employee</SelectItem>
                <SelectItem value="OTHER">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            Edit address, email, and phone later from Admin → To/From List.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setNewContactDialogOpen(false)} disabled={newContactSaving}>
            Cancel
          </Button>
          <Button onClick={handleSaveNewContact} disabled={newContactSaving}>
            {newContactSaving && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  );
}

/**
 * Helper used by Transactions.tsx to fetch & decrypt accounts.
 * Returns AccountOption[] shaped for the modal.
 */
export async function fetchAccountsForModal(
  orgId: string,
  decryptText: (v: string) => Promise<string>,
): Promise<AccountOption[]> {
  const { data } = await supabase.from('chart_of_accounts').select('*').eq('org_id', orgId);
  const rows = (data as any[]) | [];
  const decrypted = await Promise.all(
    rows.map(async (row) => {
      const fields = await decryptChartOfAccount(row, decryptText);
      return {
        id: row.id as string,
        external_account_id: row.external_account_id as string,
        name: fields.account_name | '[Account]',
        code: fields.account_code | null,
      } satisfies AccountOption;
    }),
  );
  return decrypted.filter((a) => !!a.name);
}

/**
 * Helper used by Transactions.tsx to fetch & decrypt contacts for the
 * right-side TO/FROM picker. Mirrors fetchAccountsForModal.
 */
export async function fetchContactsForModal(
  orgId: string,
  decryptText: (v: string) => Promise<string>,
): Promise<ContactOption[]> {
  const { data } = await supabase.from('contacts').select('*').eq('org_id', orgId);
  const rows = (data as any[]) | [];
  const decrypted = await Promise.all(
    rows.map(async (row) => {
      try {
        const fields = await decryptContact(row, decryptText);
        return {
          id: row.id as string,
          name: fields.name | '[Contact]',
          kind: fields.type | 'OTHER',
        } satisfies ContactOption;
      } catch {
        // Undecryptable rows (key version mismatch) — exclude rather than
        // surface garbage in the picker.
        return null;
      }
    }),
  );
  return decrypted.filter((c): c is ContactOption => !!c && !!c.name);
}
