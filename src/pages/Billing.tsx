import { useEffect, useMemo, useState, useCallback } from 'react';
import { CreditCard, Loader2, Sparkles, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/lib/supabase';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { FlashPaymentRow } from '@/lib/flash';

type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'read_only'
  | 'locked'
  | 'cancelled'
  | 'deleted';

interface Subscription {
  id: string;
  billing_account_id?: string | null;
  plan: string;
  price_cents: number;
  currency: string;
  status: SubscriptionStatus;
  trial_ends_at: string | null;
  current_period_end: string | null;
}

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 3600 * 1000)));
}

function statusBadge(status: SubscriptionStatus) {
  switch (status) {
    case 'trialing':
      return <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">Trial</Badge>;
    case 'active':
      return <Badge className="bg-green-100 text-green-800 hover:bg-green-100">Active</Badge>;
    case 'past_due':
      return <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100">Past due</Badge>;
    case 'read_only':
      return <Badge className="bg-orange-100 text-orange-900 hover:bg-orange-100">Read-only</Badge>;
    case 'locked':
      return <Badge className="bg-red-100 text-red-800 hover:bg-red-100">Locked</Badge>;
    case 'cancelled':
      return <Badge variant="secondary">Cancelled</Badge>;
    case 'deleted':
      return <Badge variant="destructive">Deleted</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function paymentStatusBadge(status: FlashPaymentRow['status']) {
  switch (status) {
    case 'completed':
      return <Badge className="bg-green-100 text-green-800 hover:bg-green-100">Paid</Badge>;
    case 'pending':
      return <Badge variant="secondary">Pending</Badge>;
    case 'failed':
      return <Badge className="bg-red-100 text-red-800 hover:bg-red-100">Failed</Badge>;
    case 'expired':
      return <Badge variant="secondary">Expired</Badge>;
    case 'refunded':
      return <Badge className="bg-amber-100 text-amber-900 hover:bg-amber-100">Refunded</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

export default function Billing() {
  const [loading, setLoading] = useState(true);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [payments, setPayments] = useState<FlashPaymentRow[]>([]);
  const [paying, setPaying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data: subRows, error: subErr } = await supabase
        .from('subscriptions')
        .select(
          'id, billing_account_id, plan, price_cents, currency, status, trial_ends_at, current_period_end',
        )
        .order('created_at', { ascending: false });
      if (subErr) throw new Error(subErr.message);
      setSubs((subRows ?? []) as Subscription[]);

      const subIds = (subRows ?? []).map((r) => r.id as string);
      if (subIds.length > 0) {
        const { data: payRows } = await supabase
          .from('flash_payments')
          .select(
            'id, amount_cents, currency, status, flash_payment_link_url, paid_at, created_at, net_cents',
          )
          .in('subscription_id', subIds)
          .order('created_at', { ascending: false })
          .limit(50);
        setPayments((payRows ?? []) as FlashPaymentRow[]);
      } else {
        setPayments([]);
      }

      // S16: log this access for each distinct billing_account_id surfaced
      // on the page. RPC is SECURITY DEFINER + verifies caller access, so
      // it's safe to call directly. Best-effort; we don't fail the page
      // load if the audit insert can't be written.
      const billingAccountIds = Array.from(
        new Set((subRows ?? []).map((r: any) => r.billing_account_id).filter(Boolean) as string[]),
      );
      await Promise.all(
        billingAccountIds.map((id) =>
          (supabase as any)
            .rpc('log_billing_access', {
              p_billing_account_id: id,
              p_access_context: 'billing_page_view',
            })
            .then(() => undefined)
            .catch((err: unknown) => console.warn('billing access log failed', err)),
        ),
      );
    } catch (err) {
      console.error('Billing load failed:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to load billing');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const primarySub = useMemo(() => subs[0] ?? null, [subs]);

  const onPay = useCallback(async () => {
    if (!primarySub) return;
    setPaying(true);
    try {
      const idempotencyKey = crypto.randomUUID();
      const { data, error } = await supabase.functions.invoke('create-flash-payment', {
        body: { subscriptionId: primarySub.id },
        headers: { 'Idempotency-Key': idempotencyKey },
      });
      if (error) throw new Error(error.message);
      const result = data as { url?: string; error?: string };
      if (!result?.url) throw new Error(result?.error ?? 'No payment URL returned');
      window.location.href = result.url;
    } catch (err) {
      console.error('Pay click failed:', err);
      toast.error(err instanceof Error ? err.message : 'Failed to start payment');
      setPaying(false);
    }
  }, [primarySub]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!primarySub) {
    return (
      <div>
        <h1 className="text-2xl font-bold text-foreground mb-1">Billing</h1>
        <p className="text-sm text-muted-foreground mb-6">
          No subscription found for your account.
        </p>
      </div>
    );
  }

  const trialDays = primarySub.status === 'trialing' ? daysUntil(primarySub.trial_ends_at) : null;
  const showPay = ['trialing', 'past_due', 'read_only', 'active'].includes(primarySub.status);

  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground mb-1">Billing</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Orange Way Books subscription, paid via Flash (Bitcoin Lightning or fiat).
      </p>

      <div className="grid gap-4 max-w-3xl">
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <CreditCard className="w-4 h-4" />
                  Subscription
                </CardTitle>
                <CardDescription>
                  Plan: <strong>{primarySub.plan}</strong> ·{' '}
                  {formatMoney(primarySub.price_cents, primarySub.currency)} / month
                </CardDescription>
              </div>
              {statusBadge(primarySub.status)}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {primarySub.status === 'trialing' && trialDays !== null && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Sparkles className="w-4 h-4 text-blue-500" />
                {trialDays} {trialDays === 1 ? 'day' : 'days'} left in your trial.
              </div>
            )}
            {primarySub.status === 'past_due' && (
              <div className="flex items-center gap-2 text-sm text-amber-700">
                <AlertTriangle className="w-4 h-4" />
                Payment due. Please pay {formatMoney(
                  primarySub.price_cents,
                  primarySub.currency,
                )}{' '}
                to continue.
              </div>
            )}
            {primarySub.status === 'active' && primarySub.current_period_end && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CheckCircle2 className="w-4 h-4 text-green-600" />
                Active through {new Date(primarySub.current_period_end).toLocaleDateString()}.
              </div>
            )}

            {showPay && (
              <Button onClick={onPay} disabled={paying}>
                {paying ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Starting payment…
                  </>
                ) : (
                  <>Pay {formatMoney(primarySub.price_cents, primarySub.currency)} to continue</>
                )}
              </Button>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Payment history</CardTitle>
            <CardDescription>Most recent first.</CardDescription>
          </CardHeader>
          <CardContent>
            {payments.length === 0 ? (
              <p className="text-sm text-muted-foreground">No payments yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Net</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {payments.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell className="text-sm">
                        {new Date(p.paid_at ?? p.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="text-sm">
                        {formatMoney(p.amount_cents, p.currency)}
                      </TableCell>
                      <TableCell>{paymentStatusBadge(p.status)}</TableCell>
                      <TableCell className="text-sm">
                        {p.net_cents != null ? formatMoney(p.net_cents, p.currency) : '-'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
