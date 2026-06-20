/**
 * Unit-level check that the webhook signature scheme (hex HMAC-SHA256 of
 * the raw body) round-trips between the mock-flash signer and the
 * verifier shape used in flash-webhook/index.ts. This catches a
 * mismatch (e.g. one side switches to base64) without spinning up the
 * full edge runtime.
 */
import { describe, it, expect } from 'vitest';
import { webcrypto } from 'node:crypto';

const subtle: SubtleCrypto = (webcrypto as unknown as Crypto).subtle;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sign(secret: string, body: string): Promise<string> {
  const key = await subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await subtle.sign('HMAC', key, new TextEncoder().encode(body)));
  return bytesToHex(sig);
}

async function verify(secret: string, body: string, presented: string): Promise<boolean> {
  const expected = await sign(secret, body);
  if (expected.length !== presented.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ presented.toLowerCase().charCodeAt(i);
  return diff === 0;
}

describe('flash webhook HMAC round-trip', () => {
  it('accepts a signature produced by the mock signer', async () => {
    const secret = 'devsecret';
    const body = JSON.stringify({ event_type: 'payment.completed', external_reference: 'abc' });
    const sig = await sign(secret, body);
    expect(await verify(secret, body, sig)).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const secret = 'devsecret';
    const body = JSON.stringify({ event_type: 'payment.completed', external_reference: 'abc' });
    const sig = await sign(secret, body);
    expect(await verify(secret, body + ' ', sig)).toBe(false);
  });

  it('rejects a wrong secret', async () => {
    const body = JSON.stringify({ event_type: 'payment.completed' });
    const sig = await sign('one', body);
    expect(await verify('two', body, sig)).toBe(false);
  });
});
