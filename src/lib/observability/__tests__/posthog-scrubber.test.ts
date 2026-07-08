import { describe, expect, it } from 'vitest';
import { MAX_SCRUB_DEPTH, scrubPostHogEvent } from '@/lib/observability/posthog-scrubber';

// Minimal stand-in for posthog-js's CaptureResult: the scrubber
// only touches .properties so the rest of the shape can be ignored
// in tests. Cast through unknown to satisfy the function signature
// without pulling the SDK's full type surface into the test.
function event(properties: Record<string, unknown>) {
  return scrubPostHogEvent({
    uuid: '00000000-0000-0000-0000-000000000000',
    event: 'test',
    properties,
  } as unknown as Parameters<typeof scrubPostHogEvent>[0]);
}

describe('posthog scrubber', () => {
  it('nulls $ip so PostHog skips GeoIP, redacts other reserved keys', () => {
    const r = event({ $ip: '1.2.3.4', $browser: 'Chrome', normal: 'ok' });
    // Literal null (not the "[redacted]" string) is what makes PostHog
    // skip server-side GeoIP enrichment.
    expect(r?.properties.$ip).toBeNull();
    expect(r?.properties.$browser).toBe('[redacted]');
    expect(r?.properties.normal).toBe('ok');
  });

  it('sets $geoip_disable on every event', () => {
    const r = event({ normal: 'ok' });
    expect(r?.properties.$geoip_disable).toBe(true);
  });

  it('redacts substring-hint keys (account, household, ...)', () => {
    const r = event({ account_id: 'abc', random: 1 });
    expect(r?.properties.account_id).toBe('[redacted]');
    expect(r?.properties.random).toBe(1);
  });

  it('redacts the Orange Way Books accounting-domain hints', () => {
    const r = event({
      journal_entry_id: 'je-1',
      org_id: 'org-1',
      invoice_total: 4200,
      innocent_widget: 'ok',
    });
    expect(r?.properties.journal_entry_id).toBe('[redacted]');
    expect(r?.properties.org_id).toBe('[redacted]');
    expect(r?.properties.invoice_total).toBe('[redacted]');
    expect(r?.properties.innocent_widget).toBe('ok');
  });

  it('does NOT redact innocent keys that lack a $ prefix or hint', () => {
    const r = event({ window_width: 1024, page_count: 3 });
    expect(r?.properties.window_width).toBe(1024);
    expect(r?.properties.page_count).toBe(3);
  });

  it('scrubs URL query strings on $current_url', () => {
    const r = event({ $current_url: 'https://x.test/route?a=1' });
    expect(r?.properties.$current_url).toBe('https://x.test/route?[redacted]');
  });

  it('scrubs URL fragments on $current_url', () => {
    const r = event({ $current_url: 'https://x.test/route#token=xyz' });
    expect(r?.properties.$current_url).toBe('https://x.test/route#[redacted]');
  });

  it('recurses into nested objects and redacts sensitive keys inside', () => {
    const r = event({
      ctx: { transaction_memo: 'buy coffee', label: 'innocent' },
    });
    const ctx = r?.properties.ctx as Record<string, unknown>;
    expect(ctx.transaction_memo).toBe('[redacted]');
    expect(ctx.label).toBe('innocent');
  });

  it('recurses into arrays of objects', () => {
    const r = event({
      items: [
        { account_balance: 100, label: 'a' },
        { account_balance: 200, label: 'b' },
      ],
    });
    const items = r?.properties.items as Record<string, unknown>[];
    expect(items[0].account_balance).toBe('[redacted]');
    expect(items[1].account_balance).toBe('[redacted]');
  });

  it('stops at MAX_SCRUB_DEPTH and replaces deeper containers with the sentinel', () => {
    // Build a chain with MAX_SCRUB_DEPTH + 1 nested levels. The value
    // at the deepest level should be the "[redacted-deep]" sentinel
    // because the scrubber refuses to walk past the cap. The cap is a
    // compile-time constant exported from the scrubber; the test fails
    // loudly if the constant moves or the cap logic regresses.
    const levels = MAX_SCRUB_DEPTH + 1;
    const keys = Array.from({ length: levels }, (_, i) => `lvl${i}`);
    let payload: Record<string, unknown> = { deeper: { secret: 'x' } };
    for (let i = levels - 1; i >= 0; i--) {
      payload = { [keys[i]]: payload };
    }
    const r = event(payload);
    // Walk down each level; the last lookup yields the sentinel string.
    let cur: unknown = r?.properties;
    for (const k of keys) {
      cur = (cur as Record<string, unknown>)[k];
    }
    expect(cur).toBe('[redacted-deep]');
  });

  it('leaves typed objects (Date, Map, RegExp) untouched instead of flattening', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const r = event({ ts_dropped_here: d });
    // "ts" doesn't match any hint, so the value passes through. The
    // important assertion is that we did NOT walk it into {} via
    // Object.entries.
    expect(r?.properties.ts_dropped_here).toBe(d);
  });

  it('skips dangerous keys when walking JSON-shaped input', () => {
    // An object literal { __proto__: X } sets the prototype, it does
    // not add an own property, so it does not reach the scrubber.
    // The realistic source of a __proto__ key is JSON.parse, which
    // produces an own property. Simulate that here.
    const parsed = JSON.parse('{ "ctx": { "__proto__": { "polluted": true }, "normal": 1 } }');
    const r = event(parsed);
    const ctx = r?.properties.ctx as Record<string, unknown>;
    expect(ctx.normal).toBe(1);
    // The __proto__ key was skipped, so the output object has no own
    // "polluted" property and an unmodified prototype.
    expect(Object.prototype.hasOwnProperty.call(ctx, '__proto__')).toBe(false);
    expect((ctx as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('caps long strings at 256 chars with an ellipsis', () => {
    const long = 'a'.repeat(300);
    const r = event({ notes_field_x: long });
    // notes_field_x will be substring-redacted by "notes"; pick a
    // non-hint key for the truncation test.
    const r2 = event({ payload: long });
    expect((r2?.properties.payload as string).endsWith('…')).toBe(true);
    expect((r2?.properties.payload as string).length).toBe(257);
    // sanity: the redacted form still works
    expect(r?.properties.notes_field_x).toBe('[redacted]');
  });

  it('passes null events through unchanged', () => {
    expect(scrubPostHogEvent(null)).toBeNull();
  });
});
