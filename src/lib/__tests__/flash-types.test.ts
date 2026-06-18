/**
 * Smoke tests for shared Flash browser types. The real integration
 * coverage lives in tests/integration/flash/MANUAL.md — OWB does not
 * yet have a local-supabase test harness so we keep this file as a
 * placeholder that ensures the type module loads cleanly.
 */
import { describe, it, expect } from 'vitest';
import type { FlashStatus, FlashPaymentRow } from '../flash';

describe('flash browser types', () => {
  it('FlashStatus shape compiles', () => {
    const s: FlashStatus = { connected: false, expiresAt: null, scopes: null };
    expect(s.connected).toBe(false);
  });

  it('FlashPaymentRow shape compiles', () => {
    const p: FlashPaymentRow = {
      id: 'x',
      amount_cents: 3000,
      currency: 'USD',
      status: 'pending',
      flash_payment_link_url: null,
      paid_at: null,
      created_at: new Date().toISOString(),
      net_cents: null,
    };
    expect(p.status).toBe('pending');
  });
});
