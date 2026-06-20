/**
 * InvoiceMatchPanel — Wave-style "is this deposit for invoice X?" suggestion.
 *
 * Renders below the transaction edit modal when the tx is an inflow.
 * Loads open invoices for the org, decrypts customer name + amount
 * client-side, ranks them via rankInvoiceMatches(), and lets the user
 * apply the deposit against one match in a single click.
 *
 * Apply paths:
 *   • "Apply as new payment" — encrypts amount_applied with the vault
 *     MEK and calls apply_invoice_payment() RPC.
 *   • "Merge with placeholder payment" (Phase I16) — when the invoice
 *     already has a placeholder invoice_payments row from a manual
 *     "Mark paid" action, fold this real deposit into the placeholder
 *     via mergeWithPlaceholder(). The highest-confidence candidate
 *     that has a placeholder defaults to Merge.
 *
 * The component is read-only until "Apply" or "Merge" is clicked.
 * Re-applying or re-merging the same (invoice, transaction) pair is
 * idempotent server-side.
 */

import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, Merge, Receipt } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { supabase } from '@/lib/supabase';
import { useVault } from '@/context/VaultContext';
import { decryptInvoice } from '@/lib/crypto-fields';
import { rankInvoiceMatches, type InvoiceCandidate, type RankedMatch } from '@/lib/invoiceMatch';
import {
  fetchPlaceholderPayments,
  mergeWithPlaceholder,
  MergeAmountMismatchError,
  type PlaceholderInfo,
} from '@/lib/invoices/mergeInvoicePayment';
import { toast } from 'sonner';

interface Props {
  orgId: string;
  txId: string;
  txAmount: number; // positive deposit amount
  txCurrency: string;
  txDate: string; // ISO date
  counterparty: string | null;
  onApplied: () => void;
}

const OPEN_STATUSES = ['DRAFT', 'SENT', 'VIEWED', 'PARTIAL', 'OVERDUE'];
const MAX_SHOWN = 3;

export function InvoiceMatchPanel({
  orgId,
  txId,
  txAmount,
  txCurrency,
  txDate,
  counterparty,
  onApplied,
}: Props) {
  const { encryptText, decryptText, loadOrgSigningKey, signMutation } = useVault();
  const [loading, setLoading] = useState(true);
  const [ranked, setRanked] = useState<RankedMatch[]>([]);
  const [applying, setApplying] = useState<string | null>(null);
  const [merging, setMerging] = useState<string | null>(null);
  const [appliedAmounts, setAppliedAmounts] = useState<Record<string, number>>({});
  /** invoice_id → existing placeholder invoice_payments row, if any. */
  const [placeholders, setPlaceholders] = useState<Map<string, PlaceholderInfo>>(() => new Map());
  /** invoice_ids that have been merged this session (hide row actions). */
  const [merged, setMerged] = useState<Set<string>>(() => new Set());
  // Per-row editable amount (string for input control).
  const [amountInputs, setAmountInputs] = useState<Record<string, string>>({});
  const [remaining, setRemaining] = useState<number>(txAmount);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data, error } = await (supabase as any)
          .from('invoices')
          .select('*')
          .eq('org_id', orgId)
          .in('status', OPEN_STATUSES)
          .eq('currency', txCurrency.toUpperCase())
          .limit(200);
        if (error) throw error;

        const candidates: InvoiceCandidate[] = [];
        for (const r of (data ?? []) as any[]) {
          try {
            const dec = await decryptInvoice(r, decryptText);
            candidates.push({
              id: r.id,
              invoice_number: r.invoice_number,
              amount: dec.amount ?? r.amount ?? 0,
              currency: r.currency,
              customer_name: dec.customer_name ?? '',
              issue_date: r.issue_date,
              due_date: r.due_date,
            });
          } catch (e) {
            console.warn('[match] decrypt invoice failed', r.id, e);
          }
        }
        if (cancelled) return;
        const result = rankInvoiceMatches(
          { amount: txAmount, currency: txCurrency, date: txDate, counterparty },
          candidates,
        );
        const top = result.slice(0, MAX_SHOWN);
        setRanked(top);
        // Seed each row's editable amount with min(remaining, invoice.amount)
        // so a single-invoice match defaults to the full deposit but a
        // split scenario auto-suggests the per-invoice cap.
        const seed: Record<string, string> = {};
        for (const m of top) {
          seed[m.candidate.id] = String(Math.min(txAmount, m.candidate.amount));
        }
        setAmountInputs(seed);
        // Phase I16 — pull placeholder invoice_payments so we can surface
        // "Merge" instead of "Apply as new" when manual mark-paid already
        // created a row.
        try {
          const phMap = await fetchPlaceholderPayments(top.map((m) => m.candidate.id));
          if (!cancelled) setPlaceholders(phMap);
        } catch (e) {
          console.warn('[match] placeholder fetch failed', e);
        }
      } catch (err) {
        console.error('[match] load failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId, txAmount, txCurrency, txDate, counterparty, decryptText]);

  const handleApply = async (m: RankedMatch) => {
    const rawInput = amountInputs[m.candidate.id];
    const applied = Number(rawInput);
    if (!Number.isFinite(applied) || applied <= 0) {
      toast.error('Amount must be positive');
      return;
    }
    if (applied > remaining + (appliedAmounts[m.candidate.id] ?? 0) + 0.0001) {
      toast.error(`Only ${remaining.toFixed(2)} left to apply from this deposit`);
      return;
    }
    setApplying(m.candidate.id);
    try {
      const encryptedApplied = await encryptText(String(applied));
      const { data, error } = await (supabase as any).rpc('apply_invoice_payment', {
        p_invoice_id: m.candidate.id,
        p_transaction_id: txId,
        p_amount_applied: applied,
        p_encrypted_amount_applied: encryptedApplied,
      });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      // Track per-row applied amount + decrement remaining so multi-apply
      // (split deposit) shows shrinking budget.
      setAppliedAmounts((prev) => ({ ...prev, [m.candidate.id]: applied }));
      setRemaining((prev) => Math.max(0, prev - applied));
      // Re-seed any unapplied rows so their default doesn't exceed
      // what's left of the deposit.
      setAmountInputs((prev) => {
        const next = { ...prev };
        const leftover = Math.max(0, remaining - applied);
        for (const cand of ranked) {
          if (appliedAmounts[cand.candidate.id]) continue;
          if (cand.candidate.id === m.candidate.id) continue;
          const cap = Math.min(leftover, cand.candidate.amount);
          next[cand.candidate.id] = String(cap);
        }
        return next;
      });
      toast.success(
        `Applied ${applied} to ${m.candidate.invoice_number} — ${(row?.invoice_status ?? 'updated').toLowerCase()}${row?.je_posted ? ' · JE posted' : ''}`,
      );
      onApplied();
    } catch (err) {
      console.error('[match] apply failed', err);
      toast.error(err instanceof Error ? err.message : 'Apply failed');
    } finally {
      setApplying(null);
    }
  };

  const handleMerge = async (m: RankedMatch, opts: { confirm?: boolean } = {}) => {
    const placeholder = placeholders.get(m.candidate.id);
    if (!placeholder) {
      toast.error('No placeholder payment to merge with.');
      return;
    }
    setMerging(m.candidate.id);
    try {
      const result = await mergeWithPlaceholder({
        placeholderPaymentId: placeholder.id,
        transactionId: txId,
        orgId,
        depositAmount: txAmount,
        confirmAmountMismatch: opts.confirm,
        loadOrgSigningKey,
        signMutation,
      });
      setMerged((prev) => {
        const next = new Set(prev);
        next.add(m.candidate.id);
        return next;
      });
      // Merge consumes the deposit toward the placeholder's recorded
      // amount; treat the deposit as fully spent for the panel's
      // remaining-budget UI so the user can't double-apply.
      setRemaining(0);
      toast.success(
        result.noop
          ? `Already merged with ${m.candidate.invoice_number}.`
          : `Merged deposit with ${m.candidate.invoice_number} placeholder payment.`,
      );
      onApplied();
    } catch (err) {
      if (err instanceof MergeAmountMismatchError) {
        const proceed =
          typeof window !== 'undefined'
            ? window.confirm(
                `Deposit (${err.depositAmount}) and placeholder ` +
                  `(${err.placeholderAmount}) differ by more than ` +
                  `${(err.tolerancePct * 100).toFixed(2)}%. Merge anyway?`,
              )
            : false;
        if (proceed) {
          setMerging(null);
          await handleMerge(m, { confirm: true });
          return;
        }
        toast.message('Merge cancelled.');
      } else {
        console.error('[match] merge failed', err);
        toast.error(err instanceof Error ? err.message : 'Merge failed');
      }
    } finally {
      setMerging(null);
    }
  };

  const headline = useMemo(() => {
    if (loading) return 'Looking for matching invoices…';
    if (ranked.length === 0) return 'No open invoices match this deposit.';
    if (remaining <= 0.0001) return 'Deposit fully applied.';
    return `Match this deposit to an invoice?`;
  }, [loading, ranked.length, remaining]);

  // Index of the first ranked candidate that has a placeholder — its
  // primary action defaults to "Merge" (Wave UX).
  const primaryMergeIdx = useMemo(
    () => ranked.findIndex((r) => placeholders.has(r.candidate.id)),
    [ranked, placeholders],
  );

  return (
    <div
      className="rounded-md border border-primary/30 bg-primary/5 p-3 space-y-2"
      data-testid="invoice-match-panel"
    >
      <div className="flex items-center gap-2">
        <Receipt className="w-4 h-4 text-primary" />
        <p className="text-sm font-medium">{headline}</p>
        {loading && <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />}
        {!loading && ranked.length > 0 && remaining > 0.0001 && (
          <Badge
            variant="outline"
            className="text-xs ml-auto"
            data-testid="invoice-match-remaining"
          >
            {remaining.toFixed(2)} {txCurrency} left
          </Badge>
        )}
      </div>

      {!loading && ranked.length > 0 && (
        <div className="space-y-1.5">
          {ranked.map((m, idx) => {
            const pct = Math.round(m.score * 100);
            const appliedAmt = appliedAmounts[m.candidate.id];
            const isApplied = appliedAmt !== undefined;
            const isApplying = applying === m.candidate.id;
            const isMerging = merging === m.candidate.id;
            const placeholder = placeholders.get(m.candidate.id);
            const isMerged = merged.has(m.candidate.id);
            const isPrimaryMerge = placeholder !== undefined && idx === primaryMergeIdx;
            return (
              <div
                key={m.candidate.id}
                className="flex items-center gap-2 rounded border border-border bg-background px-2 py-1.5"
                data-testid={`invoice-match-row-${m.candidate.invoice_number}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm">{m.candidate.invoice_number}</span>
                    <Badge variant="outline" className="text-xs">
                      {pct}% match
                    </Badge>
                    {placeholder && !isMerged && (
                      <Badge
                        variant="secondary"
                        className="text-xs"
                        data-testid={`invoice-match-placeholder-${m.candidate.invoice_number}`}
                      >
                        placeholder · {placeholder.applied_at?.slice(0, 10) ?? ''}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground truncate">
                    {m.candidate.customer_name || '(no customer)'} · {m.candidate.amount}{' '}
                    {m.candidate.currency}
                    {m.candidate.due_date ? ` · due ${m.candidate.due_date}` : ''}
                  </p>
                </div>
                {isMerged ? (
                  <Badge className="bg-blue-600 hover:bg-blue-600 text-white">
                    <Merge className="w-3 h-3 mr-1" /> Merged
                  </Badge>
                ) : isApplied ? (
                  <Badge className="bg-green-600 hover:bg-green-600 text-white">
                    <Check className="w-3 h-3 mr-1" /> Applied {appliedAmt}
                  </Badge>
                ) : (
                  <>
                    {!placeholder && (
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={amountInputs[m.candidate.id] ?? ''}
                        onChange={(e) =>
                          setAmountInputs((prev) => ({ ...prev, [m.candidate.id]: e.target.value }))
                        }
                        className="h-8 w-24 text-right text-sm"
                        data-testid={`invoice-match-amount-${m.candidate.invoice_number}`}
                      />
                    )}
                    {placeholder && (
                      <Button
                        size="sm"
                        variant={isPrimaryMerge ? 'default' : 'outline'}
                        onClick={() => handleMerge(m)}
                        disabled={isMerging || isApplying}
                        data-testid={`invoice-match-merge-${m.candidate.invoice_number}`}
                        title={`Merge with existing payment record (${placeholder.amount_applied} applied on ${placeholder.applied_at?.slice(0, 10) ?? ''})`}
                      >
                        {isMerging ? (
                          <Loader2 className="w-3 h-3 animate-spin" />
                        ) : (
                          <>
                            <Merge className="w-3 h-3 mr-1" /> Merge
                          </>
                        )}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleApply(m)}
                      disabled={isApplying || isMerging || remaining <= 0.0001}
                      data-testid={`invoice-match-apply-${m.candidate.invoice_number}`}
                    >
                      {isApplying ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : placeholder ? (
                        'Apply as new'
                      ) : (
                        'Apply'
                      )}
                    </Button>
                  </>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
