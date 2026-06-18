/**
 * OWB Invoicing — Public hosted view (customer-facing).
 *
 * Route: /i/:urlId
 * Decryption key: location.hash (URL fragment, never reaches the server).
 *
 * Flow:
 *   1. Parse urlId from path + key from fragment
 *   2. Call anon RPC get_public_invoice(urlId) → encrypted blob + plaintext
 *      lifecycle metadata
 *   3. Decrypt blob in-browser using the key from the fragment
 *   4. Render the invoice
 *   5. Fire-and-forget RPC record_public_invoice_view to log + flip SENT → VIEWED
 *
 * No vault unlock needed. No org auth. This is a public surface intended
 * for the customer who received the invoice email — same shape as a
 * Bitwarden Send share link.
 */

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Loader2, AlertTriangle, Lock, Printer, ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { supabase } from '@/lib/supabase';
import { decryptInvoiceShare, type InvoiceSharePayload } from '@/lib/invoiceShare';
import { openInvoicePrint } from '@/lib/invoicePdf';

interface ServerMeta {
  encrypted_share_blob: string;
  status: string;
  currency: string;
  issue_date: string | null;
  due_date: string | null;
  sent_at: string | null;
  expires_at: string | null;
  view_count: number;
  org_public_name: string | null;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; meta: ServerMeta; payload: InvoiceSharePayload };

function formatAmount(amount: number, currency: string): string {
  if (currency === 'BTC') return `₿ ${amount.toLocaleString(undefined, { maximumFractionDigits: 8 })}`;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

export default function PublicInvoice() {
  const { urlId } = useParams<{ urlId: string }>();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    if (!urlId) {
      setState({ kind: 'error', message: 'Invalid invoice link.' });
      return;
    }
    const shareKey = window.location.hash.replace(/^#/, '').trim();
    if (!shareKey) {
      setState({
        kind: 'error',
        message: 'This link is missing its decryption key. The key lives in the part after the # — make sure the URL was copied in full from your email.',
      });
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await (supabase as any).rpc('get_public_invoice', { p_url_id: urlId });
        if (cancelled) return;
        if (error) throw new Error(error.message);
        const rows = (data ?? []) as ServerMeta[];
        if (rows.length === 0) {
          setState({
            kind: 'error',
            message: 'This invoice link is expired, voided, or has been deleted by the sender.',
          });
          return;
        }
        const meta = rows[0];
        // Decrypt in-browser
        let payload: InvoiceSharePayload;
        try {
          payload = await decryptInvoiceShare(meta.encrypted_share_blob, shareKey);
        } catch (err) {
          setState({
            kind: 'error',
            message: 'Could not decrypt the invoice. The link may be corrupted or the decryption key in the URL was modified.',
          });
          return;
        }
        setState({ kind: 'ready', meta, payload });

        // Fire-and-forget view log (does NOT block render). Failure here
        // just means the sender's "viewed" counter doesn't tick this time.
        void (supabase as any)
          .rpc('record_public_invoice_view', { p_url_id: urlId })
          .catch(() => undefined);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message: `Could not load invoice: ${msg}` });
      }
    })();
    return () => { cancelled = true; };
  }, [urlId]);

  // ── Render ──

  if (state.kind === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex items-center gap-2 text-muted-foreground text-sm">
          <Loader2 className="w-4 h-4 animate-spin" /> Decrypting invoice in your browser…
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background px-6">
        <div className="max-w-md w-full rounded-lg border border-destructive/40 bg-destructive/5 p-6 space-y-3">
          <div className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="w-5 h-5" />
            <h1 className="text-lg font-semibold">Can't open this invoice</h1>
          </div>
          <p className="text-sm text-muted-foreground">{state.message}</p>
        </div>
      </div>
    );
  }

  const { meta, payload } = state;
  const orgName = meta.org_public_name ?? 'An organization using Orange Way Books';

  return (
    <div className="min-h-screen bg-background py-8 px-4">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* Header */}
        <div className="rounded-lg border border-border bg-card p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4 mb-4 pb-4 border-b border-border">
            <div>
              <h1 className="text-2xl font-bold text-foreground">{orgName}</h1>
              <p className="text-xs text-muted-foreground flex items-center gap-1 mt-1">
                <Lock className="w-3 h-3" /> End-to-end encrypted invoice · Orange Way Books
              </p>
            </div>
            <div className="text-right">
              <div className="text-xl font-bold text-primary font-mono">{payload.invoice_number}</div>
              <div className="text-xs text-muted-foreground mt-1">
                {payload.issue_date ? `Issued ${payload.issue_date}` : ''}
                {payload.due_date ? ` · Due ${payload.due_date}` : ''}
              </div>
              <div className="inline-block mt-2 px-2 py-0.5 rounded text-xs bg-primary text-primary-foreground uppercase tracking-wider">
                {payload.status}
              </div>
            </div>
          </div>

          {/* Customer + amount */}
          <div className="grid grid-cols-2 gap-6 mb-4">
            <div>
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Bill to</h3>
              <p className="font-semibold">{payload.customer_name}</p>
              {payload.customer_email && <p className="text-sm">{payload.customer_email}</p>}
              {payload.customer_phone && <p className="text-sm">{payload.customer_phone}</p>}
              {payload.customer_address && <p className="text-sm whitespace-pre-wrap">{payload.customer_address}</p>}
            </div>
            <div>
              <h3 className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Amount due</h3>
              <p className="text-2xl font-bold text-primary">{formatAmount(payload.amount, payload.currency)}</p>
            </div>
          </div>

          {/* Line items */}
          <div className="mt-6">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase tracking-wider text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="text-left py-2">Description</th>
                  <th className="text-right py-2 w-20">Qty</th>
                  <th className="text-right py-2 w-28">Unit</th>
                  <th className="text-right py-2 w-32">Amount</th>
                </tr>
              </thead>
              <tbody>
                {payload.lines.map((l, i) => (
                  <tr key={i} className="border-b border-border/40">
                    <td className="py-2.5">{l.description | '—'}</td>
                    <td className="py-2.5 text-right font-mono text-xs">{l.quantity != null ? l.quantity : ''}</td>
                    <td className="py-2.5 text-right font-mono text-xs">{l.unit_price != null ? formatAmount(l.unit_price, payload.currency) : ''}</td>
                    <td className="py-2.5 text-right font-mono">{formatAmount(l.amount, payload.currency)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3} className="text-right pt-3 font-semibold">Total</td>
                  <td className="text-right pt-3 font-bold font-mono">{formatAmount(payload.amount, payload.currency)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Memo + payment instructions */}
          {payload.memo && (
            <div className="mt-4 p-3 rounded-md bg-amber-50 border border-amber-200 text-sm text-amber-900 dark:bg-amber-500/5 dark:text-amber-200 dark:border-amber-500/40">
              <p className="font-semibold text-xs uppercase tracking-wider mb-1">Note</p>
              <p className="whitespace-pre-wrap">{payload.memo}</p>
            </div>
          )}

          {payload.payment_instructions && (
            <div className="mt-3 p-3 rounded-md bg-primary/5 border border-primary/30 text-sm">
              <p className="font-semibold text-xs uppercase tracking-wider mb-1 text-primary">Payment instructions</p>
              <p className="whitespace-pre-wrap">{payload.payment_instructions}</p>
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-2 mt-6 pt-4 border-t border-border">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                try {
                  openInvoicePrint(payload, { orgPublicName: orgName, formatAmount });
                } catch (err) {
                  alert(err instanceof Error ? err.message : 'Print failed.');
                }
              }}
            >
              <Printer className="w-4 h-4 mr-1" /> Print / Save PDF
            </Button>
          </div>
        </div>

        <p className="text-xs text-muted-foreground text-center">
          This invoice was decrypted in your browser. The sender's bookkeeping platform never sees your contents in plaintext.
        </p>
      </div>
    </div>
  );
}
