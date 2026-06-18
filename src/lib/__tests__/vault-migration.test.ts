/**
 * Tests for the vault v2 → v3 migration orchestrator.
 *
 * We don't stand up a real Supabase — we mock the subset of query-builder
 * semantics the orchestrator uses (`from().select().eq().maybeSingle()`,
 * `from().select(..., { count, head }).eq()`, `from().select().in()`, and
 * `rpc()`), plus a minimal `storage.from().download/upload/remove` surface
 * for the blob re-encryption phase.
 */
import { describe, it, expect } from 'vitest';
import { upgradeVaultToV3, type UpgradeProgressEvent } from '@/lib/vault-migration';
import {
  deriveKeyV3,
  deriveKeyV2,
  encryptText,
  decryptText,
  encryptBlob,
  decryptBlob,
  generateVaultSalt,
  createVaultVerifier,
} from '@/lib/vault';
import { encryptContact, encryptAttachment } from '@/lib/crypto-fields';

const PASSWORD = 'correct-horse-battery-staple';
const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ORG_ID = 'ffffffff-0000-1111-2222-333333333333';

interface Store {
  [table: string]: Array<Record<string, unknown>>;
}

/** In-memory blob store keyed by storage path. */
type BlobStore = Record<string, Uint8Array>;

/** Build a minimal mock supabase client. `rpcImpl` controls how the RPC
 *  behaves; `blobStore` backs the storage layer (optional — pass `{}` for
 *  tests that don't exercise the blob path). */
function makeSupabase(
  store: Store,
  rpcImpl: (name: string, params: Record<string, unknown>) => { error: unknown },
  blobStore: BlobStore = {},
) {
  const makeBuilder = (table: string) => {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    let wantCount = false;
    let headOnly = false;
    const b: Record<string, unknown> = {};
    b.select = (_cols: string, options?: { count?: string; head?: boolean }) => {
      if (options?.count) wantCount = true;
      if (options?.head) headOnly = true;
      return b;
    };
    b.eq = (col: string, val: unknown) => {
      filters.push((r) => r[col] === val);
      return b;
    };
    b.in = (col: string, vals: unknown[]) => {
      filters.push((r) => vals.includes(r[col]));
      return b;
    };
    b.maybeSingle = async () => {
      const rows = (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return { data: rows[0] ?? null, error: null };
    };
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      const rows = (store[table] ?? []).filter((r) => filters.every((f) => f(r)));
      const payload: Record<string, unknown> = { error: null };
      if (wantCount) payload.count = rows.length;
      payload.data = headOnly ? null : rows;
      return Promise.resolve(payload).then(resolve, reject);
    };
    return b;
  };

  const makeStorageBucket = () => ({
    download: async (path: string) => {
      const data = blobStore[path];
      if (!data) return { data: null, error: { message: `Not found: ${path}` } };
      return { data: new Blob([data as BlobPart]), error: null };
    },
    upload: async (path: string, data: Blob | Uint8Array) => {
      const bytes = data instanceof Blob
        ? new Uint8Array(await data.arrayBuffer())
        : data;
      blobStore[path] = bytes;
      return { data: { path }, error: null };
    },
    remove: async (paths: string[]) => {
      for (const p of paths) delete blobStore[p];
      return { data: {}, error: null };
    },
  });

  return {
    from: (table: string) => makeBuilder(table),
    rpc: async (name: string, params: Record<string, unknown>) => rpcImpl(name, params),
    storage: { from: (_bucket: string) => makeStorageBucket() },
  } as unknown as Parameters<typeof upgradeVaultToV3>[0]['supabase'];
}

const ATTACHMENT_ID = 'att-1';
const ATTACHMENT_OLD_PATH = `${ORG_ID}/tx-1/file-uuid`;
const ATTACHMENT_PLAINTEXT = new TextEncoder().encode('receipt content');

async function seedV2Store(opts: { withAttachment?: boolean } = {}) {
  const v2Salt = generateVaultSalt();
  const v2Key = await deriveKeyV2(PASSWORD, USER_ID, v2Salt);
  const v2Verifier = await createVaultVerifier(PASSWORD, USER_ID, v2Salt, 2);

  const contactPlain = {
    name: 'Alice Example',
    street: '1 Main St',
    city: 'Toronto',
    state: 'ON',
    zip: 'M5V',
    country: 'CA',
    email: 'alice@example.com',
    phone: '+16475550100',
    type: 'customer',
  };
  const contactCipher = await encryptContact(contactPlain, (pt) => encryptText(pt, v2Key));

  // Optional attachment row + blob.
  const blobStore: BlobStore = {};
  let attachmentRows: Array<Record<string, unknown>> = [];
  if (opts.withAttachment) {
    const encBlob = await encryptBlob(ATTACHMENT_PLAINTEXT, v2Key);
    blobStore[ATTACHMENT_OLD_PATH] = new Uint8Array(await encBlob.arrayBuffer());
    const encMeta = await encryptAttachment(
      { file_name: 'receipt.pdf', mime_type: 'application/pdf' },
      (pt) => encryptText(pt, v2Key),
    );
    attachmentRows = [{
      id: ATTACHMENT_ID,
      org_id: ORG_ID,
      entity_type: 'transaction',
      entity_id: 'tx-1',
      file_name: encMeta.file_name,
      mime_type: encMeta.mime_type,
      storage_path: ATTACHMENT_OLD_PATH,
      file_size: ATTACHMENT_PLAINTEXT.byteLength,
      key_version: encMeta.key_version,
      uploaded_by: null,
      created_at: new Date().toISOString(),
    }];
  }

  const store: Store = {
    org_settings: [{
      org_id: ORG_ID,
      vault_verifier: v2Verifier,
      vault_salt: v2Salt,
      vault_key_version: 2,
      primary_currency: null,
      secondary_currency: null,
      bitcoin_display: null,
      fiscal_year_type: null,
      encrypted_fiscal_month: null,
      date_format: null,
      time_format: null,
      number_format: null,
      timezone: null,
      key_version: 2,
    }],
    attachments: attachmentRows,
    organizations: [{ id: ORG_ID, name: 'org-plain', key_version: 0 }],
    contacts: [{ id: 'contact-1', org_id: ORG_ID, ...contactCipher }],
    wallets: [],
    transactions: [],
    journal_entries: [],
    journal_entry_lines: [],
    chart_of_accounts: [],
    payment_requests: [],
    audit_logs: [],
  };
  return { store, blobStore, v2Salt, v2Key, contactPlain };
}

describe('upgradeVaultToV3 — happy path', () => {
  it('v2 → v3 round-trip: orchestrator emits re-encrypted rows the v3 MEK can decrypt', async () => {
    const { store, contactPlain } = await seedV2Store();

    let capturedPayload: Record<string, unknown> | null = null;
    const supabase = makeSupabase(store, (name, params) => {
      if (name !== 'rpc_upgrade_vault_to_v3') throw new Error(`unexpected rpc: ${name}`);
      capturedPayload = params;
      const updates = params.p_updates as Record<string, Array<Record<string, unknown>>>;
      for (const row of updates.contacts ?? []) {
        const target = store.contacts.find((c) => c.id === row.id);
        if (!target) continue;
        Object.assign(target, row);
      }
      const settings = store.org_settings[0];
      settings.vault_verifier = params.p_new_verifier;
      settings.vault_salt = params.p_new_salt;
      settings.vault_key_version = 3;
      return { error: null };
    });

    const events: UpgradeProgressEvent[] = [];
    await upgradeVaultToV3({
      password: PASSWORD,
      userId: USER_ID,
      orgId: ORG_ID,
      supabase,
      onProgress: (e) => events.push(e),
    });

    expect(capturedPayload).not.toBeNull();
    const payload = capturedPayload as unknown as {
      p_org_id: string;
      p_new_verifier: string;
      p_new_salt: string;
      p_updates: Record<string, Array<Record<string, unknown>>>;
    };
    expect(payload.p_org_id).toBe(ORG_ID);
    expect(payload.p_updates.contacts).toHaveLength(1);

    const newKey = await deriveKeyV3(PASSWORD, USER_ID, payload.p_new_salt);
    const stagedContact = payload.p_updates.contacts[0];
    expect(await decryptText(stagedContact.name as string, newKey)).toBe(contactPlain.name);
    expect(await decryptText(stagedContact.email as string, newKey)).toBe(contactPlain.email);

    expect(events[events.length - 1]?.phase).toBe('done');
    expect(store.org_settings[0].vault_key_version).toBe(3);
  }, 60_000);

  it('v2 → v3 round-trip: attachment blob is re-encrypted under the new MEK', async () => {
    const { store, blobStore } = await seedV2Store({ withAttachment: true });

    let capturedPayload: Record<string, unknown> | null = null;
    const supabase = makeSupabase(store, (name, params) => {
      if (name !== 'rpc_upgrade_vault_to_v3') throw new Error(`unexpected rpc: ${name}`);
      capturedPayload = params;
      const settings = store.org_settings[0];
      settings.vault_verifier = params.p_new_verifier;
      settings.vault_salt = params.p_new_salt;
      settings.vault_key_version = 3;
      return { error: null };
    }, blobStore);

    const events: UpgradeProgressEvent[] = [];
    await upgradeVaultToV3({
      password: PASSWORD,
      userId: USER_ID,
      orgId: ORG_ID,
      supabase,
      onProgress: (e) => events.push(e),
    });

    expect(capturedPayload).not.toBeNull();
    const payload = capturedPayload as unknown as {
      p_new_salt: string;
      p_updates: Record<string, Array<Record<string, unknown>>>;
    };

    // RPC payload contains the attachment update with a new versioned path.
    expect(payload.p_updates.attachments).toHaveLength(1);
    const stagedAtt = payload.p_updates.attachments[0];
    const expectedNewPath = `${ORG_ID}/v3/${ATTACHMENT_ID}`;
    expect(stagedAtt.id).toBe(ATTACHMENT_ID);
    expect(stagedAtt.storage_path).toBe(expectedNewPath);

    // New blob is in the blob store and decryptable with the v3 MEK.
    const newKey = await deriveKeyV3(PASSWORD, USER_ID, payload.p_new_salt);
    const newBlobBytes = blobStore[expectedNewPath];
    expect(newBlobBytes).toBeDefined();
    // Slice to guard against non-zero byteOffset on the Uint8Array view.
    const ab = newBlobBytes.buffer.slice(
      newBlobBytes.byteOffset,
      newBlobBytes.byteOffset + newBlobBytes.byteLength,
    );
    const decrypted = await decryptBlob(ab as ArrayBuffer, newKey);
    // Compare as plain arrays — vitest's deep-equal on TypedArrays can produce
    // false failures when the underlying buffer references differ.
    expect(Array.from(new Uint8Array(decrypted))).toEqual(Array.from(ATTACHMENT_PLAINTEXT));

    // Old blob was cleaned up after successful commit.
    expect(blobStore[ATTACHMENT_OLD_PATH]).toBeUndefined();

    // Progress included blob phases.
    const phases = events.map((e) => e.phase);
    expect(phases).toContain('blob:download');
    expect(phases).toContain('blob:rewrite');
    expect(phases).toContain('cleanup');
  }, 60_000);
});

describe('upgradeVaultToV3 — rollback / failure semantics', () => {
  it('surfaces the RPC error and leaves the client-side key-version unchanged', async () => {
    const { store } = await seedV2Store();
    const supabase = makeSupabase(store, () => ({ error: new Error('simulated rpc failure') }));

    await expect(
      upgradeVaultToV3({ password: PASSWORD, userId: USER_ID, orgId: ORG_ID, supabase }),
    ).rejects.toBeDefined();

    expect(store.org_settings[0].vault_key_version).toBe(2);
  }, 60_000);

  it('refuses to run when the wrong current password is supplied', async () => {
    const { store } = await seedV2Store();
    const supabase = makeSupabase(store, () => ({ error: null }));

    await expect(
      upgradeVaultToV3({
        password: 'wrong-wrong-wrong-wrong',
        userId: USER_ID,
        orgId: ORG_ID,
        supabase,
      }),
    ).rejects.toThrow(/Incorrect vault password/);
  }, 60_000);

  it('cleans up newly uploaded blobs when the RPC fails', async () => {
    const { store, blobStore } = await seedV2Store({ withAttachment: true });
    const supabase = makeSupabase(
      store,
      () => ({ error: new Error('simulated rpc failure') }),
      blobStore,
    );

    await expect(
      upgradeVaultToV3({ password: PASSWORD, userId: USER_ID, orgId: ORG_ID, supabase }),
    ).rejects.toBeDefined();

    // New blob must have been removed — only the old blob remains.
    const newPath = `${ORG_ID}/v3/${ATTACHMENT_ID}`;
    expect(blobStore[newPath]).toBeUndefined();
    expect(blobStore[ATTACHMENT_OLD_PATH]).toBeDefined();

    // Org stays at v2.
    expect(store.org_settings[0].vault_key_version).toBe(2);
  }, 60_000);
});
