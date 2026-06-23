/**
 * Browser-side shared types for Flash. The actual Flash API client lives
 * in `supabase/functions/_shared/flash.ts` and is invoked from edge
 * functions only, the browser never holds Flash credentials.
 */

export interface FlashStatus {
  connected: boolean;
  expiresAt: string | null;
  scopes: string[] | null;
}

export interface FlashPaymentRow {
  id: string;
  amount_cents: number;
  currency: string;
  status: 'pending' | 'completed' | 'failed' | 'expired' | 'refunded';
  flash_payment_link_url: string | null;
  paid_at: string | null;
  created_at: string;
  net_cents: number | null;
}
