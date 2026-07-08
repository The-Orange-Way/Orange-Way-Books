/**
 * PostHog event scrubber. Runs in posthog.init via the before_send hook
 * and trims any property that could carry decrypted accounting content
 * to PostHog by accident.
 *
 * The hook fires for every event (pageview, custom capture, captureException)
 * before the network call. Returning the event with modified properties
 * sends the trimmed version; returning null drops the event.
 *
 * Companion to Sentry's scrubEvent hook which does the same job on the
 * error-reporting side, and a faithful port of the Orange Way Me scrubber.
 * The two apps are design twins; keep the two scrubbers in shape with
 * each other. The hint list below is a superset of the Orange Way Me one, adding the
 * double-entry-accounting terms specific to Orange Way Books.
 */

import type { CaptureResult } from 'posthog-js';

/**
 * Property keys whose VALUES are scrubbed unconditionally. Match by
 * lowercase substring against the property key name.
 */
const SCRUB_VALUE_KEY_HINTS = [
  // Shared with Orange Way Me.
  'account',
  'household',
  'transaction',
  'merchant',
  'category',
  'budget',
  'goal',
  'rule',
  'email',
  'password',
  'vault',
  'mek',
  'opk',
  'recovery',
  'verifier',
  'ciphertext',
  'plaintext',
  'balance',
  'amount',
  'memo',
  'description',
  'notes',
  'name',
  'token',
  // Orange Way Books accounting domain.
  'org',
  'journal',
  'ledger',
  'entry',
  'invoice',
  'debit',
  'credit',
  'posting',
  'reconcil',
  'customer',
  'vendor',
  'wallet',
  'address',
  'xpub',
];

// PostHog reserved auto-capture properties that carry quasi-identifiers.
// These are matched by exact key (with the leading $) and replaced with
// "[redacted]", separately from the substring-hint list above so a regular
// "ip" or "browser" inside a payload still passes through unchanged.
// IP, browser, and device fingerprints are treated as identifiers when
// joined to a user id (Law 25 / GDPR recital 75).
//
// NOTE: $ip is handled by its own branch in scrubValue (returns literal
// null, not the "[redacted]" string) because PostHog only suppresses
// server-side GeoIP enrichment on a literal null. It is intentionally
// NOT in this set.
const SCRUB_RESERVED_KEYS = new Set([
  '$browser',
  '$browser_version',
  '$device',
  '$device_id',
  '$device_type',
  '$os',
  '$os_version',
  '$user_agent',
]);

/**
 * UUID and slug-ish path segments that we treat as sensitive when they
 * appear in URL paths. PostHog captures both `$current_url` and
 * `$pathname` on pageviews; we rewrite both.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const LONG_NUM_RE = /\/\d{6,}(?=\/|$)/g;
const BASE64ISH_RE = /\/[A-Za-z0-9+/=_-]{16,}(?=\/|$)/g;

function scrubUrl(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  let out = input;
  // Drop query strings entirely. Search params can carry org IDs,
  // recovery tokens, or other one-time URL-bound state.
  const q = out.indexOf('?');
  if (q >= 0) out = out.slice(0, q) + '?[redacted]';
  // Drop URL fragments. Recovery tokens land in the fragment on the
  // reset-password route.
  const h = out.indexOf('#');
  if (h >= 0) out = out.slice(0, h) + '#[redacted]';
  // Replace UUIDs / long numeric ids / long opaque path segments.
  out = out.replace(UUID_RE, '[uuid]');
  out = out.replace(LONG_NUM_RE, '/[id]');
  out = out.replace(BASE64ISH_RE, '/[opaque]');
  return out;
}

function shouldScrubKey(key: string): boolean {
  const k = key.toLowerCase();
  return SCRUB_VALUE_KEY_HINTS.some((hint) => k.includes(hint));
}

// Max recursion depth into nested objects/arrays. PostHog event
// properties are flat by convention, but a callsite could pass a
// nested shape by accident. A depth of 4 covers any realistic
// payload while preventing pathological structures from running
// the scrubber for an unbounded amount of time. Exported so the
// test suite can verify against the same constant rather than a
// magic number.
export const MAX_SCRUB_DEPTH = 4;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  if (Array.isArray(v)) return false;
  // Reject typed containers like Date, Map, Set, RegExp, etc. Their
  // own-property keys are usually empty, so Object.entries(v) would
  // silently turn them into {}; better to leave them untouched.
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function scrubValue(key: string, value: unknown, depth: number): unknown {
  if (key === '$current_url' || key === '$referrer' || key === '$pathname') {
    return scrubUrl(value);
  }
  // $ip must be literal null, not the "[redacted]" string: PostHog only
  // suppresses server-side GeoIP enrichment when $ip === null. Any non-null
  // value (including a placeholder string) leaves enrichment behavior
  // undefined on PostHog's side. This branch runs before SCRUB_RESERVED_KEYS.
  if (key === '$ip') {
    return null;
  }
  if (SCRUB_RESERVED_KEYS.has(key)) {
    return '[redacted]';
  }
  if (shouldScrubKey(key)) {
    return '[redacted]';
  }
  if (typeof value === 'string' && value.length > 256) {
    // Cap long strings: a 1KB string in an event property is almost
    // never a deliberate analytics signal, but it's a great way to
    // accidentally exfiltrate ciphertext or a base64-encoded key.
    return value.slice(0, 256) + '…';
  }
  if (depth >= MAX_SCRUB_DEPTH) {
    // Past the depth cap: pass primitives through, but redact any
    // further nesting so a deliberately-deep payload cannot smuggle
    // sensitive content past the scrubber.
    if (isPlainObject(value) || Array.isArray(value)) return '[redacted-deep]';
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrubValue(key, v, depth + 1));
  }
  if (isPlainObject(value)) {
    const inner: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      // Defensive: skip dangerous key names. Object.entries already
      // excludes non-enumerable keys, so __proto__ on a literal will
      // not appear here, but a key parsed from JSON.parse could.
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      inner[k] = scrubValue(k, v, depth + 1);
    }
    return inner;
  }
  return value;
}

function scrubProperties(
  props: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!props) return props;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    out[key] = scrubValue(key, value, 0);
  }
  return out;
}

/**
 * Exported as the `before_send` argument to `posthog.init`. PostHog
 * types this as `(event: CaptureResult | null) => CaptureResult | null`.
 * We always return the event (with scrubbed properties) rather than
 * dropping; dropping silently would hide a bug where a route renders
 * sensitive data in the URL.
 */
export function scrubPostHogEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  return {
    ...event,
    properties: scrubProperties(event.properties as Record<string, unknown> | undefined) ?? {},
  };
}
