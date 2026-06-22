/**
 * @vitest-environment node
 *
 * Phase 4.1 — user_vault_keys lifecycle tests.
 *
 * Scope:
 *   1. `ensureUserKeypair` generates and INSERTs exactly once.
 *   2. `rewrapUserKeypair` uses a single atomic UPDATE and NEVER
 *      DELETE+INSERT (Atomic re-wrap design: password change MUST NOT leave
 *      old ciphertext behind).
 *   3. After N password changes, count(user_vault_keys WHERE user_id = X)
 *      is always 1 — enforced by the in-memory stub's row map.
 *
 * The Supabase client is stubbed with a minimal `FakeUserVaultKeys`
 * store that counts every INSERT / UPDATE / DELETE call. The real
 * Supabase schema types are not pulled in — the 4.1 keypair module
 * takes a narrow `SupabaseKeypairClient` interface for exactly this
 * reason.
 *
 * These tests run in jsdom so WebCrypto is available (needed by the
 * pqc + HKDF round-trip; `@noble/post-quantum` does the KEM in pure
 * JS, but the AES-GCM wrap comes from `crypto.subtle`).
 */

import { describe, it, expect, beforeEach } from 'vitest';

// The vault crypto helpers (vault.ts) reach for `window.crypto` to match
// the rest of the app. Under the "node" environment we run in, there is
// no `window`. Point it at `globalThis` so WebCrypto calls resolve to
// node's built-in implementation. This polyfill stays local to this
// test file.
if (typeof (globalThis as unknown as { window?: unknown }).window === 'undefined') {
  (globalThis as unknown as { window: typeof globalThis }).window = globalThis;
}

import {
  ensureUserKeypair,
  rewrapUserKeypair,
  importMekForHkdf,
  type SupabaseKeypairClient,
  type UserVaultKeysRow,
} from '@/lib/vault-keypair';

// ---------------------------------------------------------------------------
// In-memory fake for the `user_vault_keys` rows. Mirrors the very small
// surface `ensureUserKeypair` / `rewrapUserKeypair` need from Supabase.
// ---------------------------------------------------------------------------

interface StoredRow extends UserVaultKeysRow {
  user_id: string;
}

interface CallCounts {
  select: number;
  insert: number;
  update: number;
  delete: number;
}

class FakeUserVaultKeys {
  rows: Map<string, StoredRow> = new Map();
  calls: CallCounts = { select: 0, insert: 0, update: 0, delete: 0 };

  rowsFor(userId: string): number {
    return this.rows.has(userId) ? 1 : 0;
  }

  client(): SupabaseKeypairClient {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- closure needs the test-stub store instance, not the SupabaseClient `this` of the returned method
    const store = this;
    return {
      from(table) {
        if (table !== 'user_vault_keys') {
          throw new Error(`unexpected table in test stub: ${table}`);
        }
        return {
          select(_columns: string) {
            return {
              eq(_col: 'user_id', userId: string) {
                return {
                  async maybeSingle() {
                    store.calls.select += 1;
                    const row = store.rows.get(userId) ?? null;
                    return { data: row, error: null };
                  },
                };
              },
            };
          },
          async insert(values: Record<string, unknown>) {
            store.calls.insert += 1;
            const user_id = values.user_id as string;
            if (store.rows.has(user_id)) {
              return { error: new Error('duplicate row — test invariant violated') };
            }
            store.rows.set(user_id, {
              user_id,
              public_key_b64: values.public_key_b64 as string,
              encrypted_private_key: values.encrypted_private_key as string,
              iv: values.iv as string,
              key_algorithm: values.key_algorithm as string,
            });
            return { error: null };
          },
          update(values: Record<string, unknown>) {
            return {
              async eq(_col: 'user_id', userId: string) {
                store.calls.update += 1;
                const row = store.rows.get(userId);
                if (!row) {
                  return { error: new Error('no row to update') };
                }
                store.rows.set(userId, {
                  ...row,
                  ...(values.encrypted_private_key !== undefined
                    ? { encrypted_private_key: values.encrypted_private_key as string }
                    : {}),
                  ...(values.iv !== undefined ? { iv: values.iv as string } : {}),
                });
                return { error: null };
              },
            };
          },
        };
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
// 43-byte base64 salt — must be non-empty for the HKDF subkey derivation.
const SALT_B64 = btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i)));

async function freshMek(label: string): Promise<CryptoKey> {
  // Derive a deterministic but distinct MEK per label so each password
  // change call has genuinely different key material to re-wrap under.
  const bytes = new Uint8Array(32);
  const encoded = new TextEncoder().encode(label);
  for (let i = 0; i < 32; i++) {
    bytes[i] = encoded[i % encoded.length] ^ (i * 7);
  }
  return importMekForHkdf(bytes);
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('vault-keypair — ensureUserKeypair', () => {
  let store: FakeUserVaultKeys;

  beforeEach(() => {
    store = new FakeUserVaultKeys();
  });

  it('inserts a row on first call', async () => {
    const mek = await freshMek('first-unlock');
    const res = await ensureUserKeypair({
      userId: USER_ID,
      mek,
      saltB64: SALT_B64,
      supabase: store.client(),
    });
    expect(res.generated).toBe(true);
    expect(store.rowsFor(USER_ID)).toBe(1);
    expect(store.calls.insert).toBe(1);
  });

  it('is idempotent — second call is a no-op', async () => {
    const mek = await freshMek('first-unlock');
    await ensureUserKeypair({
      userId: USER_ID,
      mek,
      saltB64: SALT_B64,
      supabase: store.client(),
    });
    const again = await ensureUserKeypair({
      userId: USER_ID,
      mek,
      saltB64: SALT_B64,
      supabase: store.client(),
    });
    expect(again.generated).toBe(false);
    expect(store.rowsFor(USER_ID)).toBe(1);
    expect(store.calls.insert).toBe(1); // still exactly one insert total
  });
});

describe('vault-keypair — rewrapUserKeypair', () => {
  let store: FakeUserVaultKeys;

  beforeEach(() => {
    store = new FakeUserVaultKeys();
  });

  it('no-ops if no row exists (password change before first unlock)', async () => {
    const oldMek = await freshMek('old');
    const newMek = await freshMek('new');
    const res = await rewrapUserKeypair({
      userId: USER_ID,
      oldMek,
      newMek,
      saltB64: SALT_B64,
      supabase: store.client(),
    });
    expect(res).toEqual({ rewrapped: false, reason: 'no-row' });
    expect(store.calls.update).toBe(0);
    expect(store.calls.insert).toBe(0);
  });

  it('uses UPDATE (never DELETE+INSERT) and keeps count at 1', async () => {
    const mek = await freshMek('first-unlock');
    await ensureUserKeypair({
      userId: USER_ID,
      mek,
      saltB64: SALT_B64,
      supabase: store.client(),
    });

    // Single password change.
    const newMek = await freshMek('rotated-1');
    const res = await rewrapUserKeypair({
      userId: USER_ID,
      oldMek: mek,
      newMek,
      saltB64: SALT_B64,
      supabase: store.client(),
    });

    expect(res).toEqual({ rewrapped: true });
    expect(store.rowsFor(USER_ID)).toBe(1);
    expect(store.calls.update).toBe(1);
    expect(store.calls.insert).toBe(1); // only the initial ensure-path insert
    expect(store.calls.delete).toBe(0); // critical: never delete
  });

  it('after N=10 password changes, count(user_vault_keys) = 1', async () => {
    // Chained re-wraps simulate ten consecutive password-change events.
    // The invariant we're guarding is that atomic UPDATE never drifts
    // the row count — no ghost rows, no DELETE+INSERT regression.
    let currentMek = await freshMek('password-0');
    await ensureUserKeypair({
      userId: USER_ID,
      mek: currentMek,
      saltB64: SALT_B64,
      supabase: store.client(),
    });

    const N = 10;
    for (let i = 1; i <= N; i++) {
      const nextMek = await freshMek(`password-${i}`);
      const res = await rewrapUserKeypair({
        userId: USER_ID,
        oldMek: currentMek,
        newMek: nextMek,
        saltB64: SALT_B64,
        supabase: store.client(),
      });
      expect(res).toEqual({ rewrapped: true });
      currentMek = nextMek;
    }

    expect(store.rowsFor(USER_ID)).toBe(1);
    expect(store.calls.insert).toBe(1);
    expect(store.calls.update).toBe(N);
    expect(store.calls.delete).toBe(0);
  });

  it('updates encrypted_private_key and iv on every re-wrap', async () => {
    const mek = await freshMek('first-unlock');
    await ensureUserKeypair({
      userId: USER_ID,
      mek,
      saltB64: SALT_B64,
      supabase: store.client(),
    });

    const rowBefore = store.rows.get(USER_ID)!;
    const cipherBefore = rowBefore.encrypted_private_key;
    const ivBefore = rowBefore.iv;
    const publicBefore = rowBefore.public_key_b64;

    const newMek = await freshMek('rotated');
    await rewrapUserKeypair({
      userId: USER_ID,
      oldMek: mek,
      newMek,
      saltB64: SALT_B64,
      supabase: store.client(),
    });

    const rowAfter = store.rows.get(USER_ID)!;
    // Ciphertext and IV changed (fresh random IV every AES-GCM call):
    expect(rowAfter.encrypted_private_key).not.toBe(cipherBefore);
    expect(rowAfter.iv).not.toBe(ivBefore);
    // Public key is the same (the keypair itself is unchanged, only
    // the wrap rotates):
    expect(rowAfter.public_key_b64).toBe(publicBefore);
  });
});
