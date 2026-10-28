// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it, vi } from 'vitest';
import { prepareMutationSigner, SigningKeyUnavailableError } from '../mutation-signer';

const ORG = '00000000-0000-0000-0000-000000000001';

// Just enough of the query builder for .from().select().eq().limit().
function client(keyRows: Array<{ key_version: number }>, error: { message: string } | null = null) {
  const from = vi.fn(() => ({
    select: () => ({
      eq: () => ({
        limit: async () => ({ data: error ? null : keyRows, error }),
      }),
    }),
  }));
  return { from } as unknown as SupabaseClient & { from: typeof from };
}

const sig = { signature_b64: 'sig', key_version: 3 };

/** Source of `async function <name>(` up to the next `async function`. */
function fnBody(code: string, name: string): string {
  const start = code.indexOf(`async function ${name}(`);
  if (start === -1) throw new Error(`${name} not found`);
  const next = code.indexOf('async function ', start + 1);
  return code.slice(start, next === -1 ? undefined : next);
}

/** True when the signer is prepared and no table write comes before it. */
function firstWriteAfterSigner(body: string): boolean {
  const signerAt = body.indexOf('await prepareSigner()');
  const writes = [
    ...body.matchAll(
      /\.from\(\s*'(journal_entries|journal_entry_lines|transactions)'\s*\)\s*\.(insert|update|delete|upsert)\(/g,
    ),
  ];
  return signerAt !== -1 && writes.length > 0 && writes.every((m) => (m.index ?? 0) > signerAt);
}

describe('prepareMutationSigner', () => {
  it('signs with the org-scoped payload when the user holds the key', async () => {
    const signMutation = vi.fn(() => sig);
    const c = client([]);
    const signer = await prepareMutationSigner({
      client: c,
      orgId: ORG,
      loadOrgSigningKey: async () => ({ keyVersion: 3 }),
      signMutation,
    });
    expect(signer.signed).toBe(true);
    expect(signer.sign('transfer-src|je|2026-01-01|USD|5')).toEqual({
      signature_b64: 'sig',
      signature_key_version: 3,
    });
    const bytes = (signMutation.mock.calls[0] as unknown as [Uint8Array])[0];
    expect(new TextDecoder().decode(bytes)).toBe(`${ORG}|transfer-src|je|2026-01-01|USD|5`);
    // No need to look up the org's key when the user already holds it.
    expect(c.from).not.toHaveBeenCalled();
  });

  it('writes unsigned when the org has no signing key yet', async () => {
    const signMutation = vi.fn(() => sig);
    const signer = await prepareMutationSigner({
      client: client([]),
      orgId: ORG,
      loadOrgSigningKey: async () => null,
      signMutation,
    });
    expect(signer.signed).toBe(false);
    expect(signer.sign('anything')).toEqual({ signature_b64: null, signature_key_version: null });
    expect(signMutation).not.toHaveBeenCalled();
  });

  it('refuses up front when the org has a key this user cannot use', async () => {
    await expect(
      prepareMutationSigner({
        client: client([{ key_version: 1 }]),
        orgId: ORG,
        loadOrgSigningKey: async () => null,
        signMutation: () => sig,
      }),
    ).rejects.toBeInstanceOf(SigningKeyUnavailableError);
  });

  it('refuses rather than guessing when the key lookup fails', async () => {
    await expect(
      prepareMutationSigner({
        client: client([], { message: 'network' }),
        orgId: ORG,
        loadOrgSigningKey: async () => null,
        signMutation: () => sig,
      }),
    ).rejects.toEqual({ message: 'network' });
  });

  it('is prepared before the first write in the split and transfer save paths', () => {
    const code = readFileSync(
      join(__dirname, '..', '..', '..', 'components', 'transactions', 'transaction-modal.tsx'),
      'utf8',
    );
    for (const name of ['handleSaveSplit', 'handleSaveTransfer']) {
      expect(firstWriteAfterSigner(fnBody(code, name))).toBe(true);
    }
    // Negative control: a body that writes before preparing is caught.
    const broken = `await supabase.from('journal_entries').insert(x);\nconst signer = await prepareSigner();`;
    expect(firstWriteAfterSigner(broken)).toBe(false);
  });

  it('refuses at sign time if a held key cannot sign', async () => {
    const signer = await prepareMutationSigner({
      client: client([]),
      orgId: ORG,
      loadOrgSigningKey: async () => ({ keyVersion: 1 }),
      signMutation: () => null,
    });
    expect(() => signer.sign('x')).toThrow(SigningKeyUnavailableError);
  });
});
