/**
 * Decide, BEFORE anything is written, how a mutation will be signed.
 *
 * The database (verify_mutation_signature_on_write) only demands a
 * signature from an org that has a row in org_signing_keys; an org with no
 * key is in the documented pre-mint rollout state and its writes are
 * accepted unsigned. The client follows the same rule:
 *
 *   - this user holds the org's signing key  -> every write is signed;
 *   - the org has no signing key at all      -> writes go unsigned, exactly
 *                                               as the database allows;
 *   - the org has a key this user cannot use -> refuse now, before the
 *                                               first write.
 *
 * Callers prepare the signer first and sign later, so a refusal can never
 * leave a journal entry behind with no transaction.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

type LoadSigningKeyFn = (orgId: string) => Promise<unknown>;
type SignMutationFn = (
  payloadBytes: Uint8Array,
  orgId: string,
) => { signature_b64: string; key_version: number } | null;

export interface SignatureColumns {
  signature_b64: string | null;
  signature_key_version: number | null;
}

export interface MutationSigner {
  /** True when writes carry a real signature. */
  signed: boolean;
  /** Signature columns for a payload. Never throws for a missing key. */
  sign(payload: string): SignatureColumns;
}

export const SIGNING_KEY_UNAVAILABLE =
  'No signing key available for this org. ' +
  'Please refresh the page; if the problem persists contact support.';

export class SigningKeyUnavailableError extends Error {
  constructor() {
    super(SIGNING_KEY_UNAVAILABLE);
    this.name = 'SigningKeyUnavailableError';
  }
}

export async function prepareMutationSigner(p: {
  client: SupabaseClient;
  orgId: string;
  loadOrgSigningKey: LoadSigningKeyFn;
  signMutation: SignMutationFn;
}): Promise<MutationSigner> {
  const handle = await p.loadOrgSigningKey(p.orgId);
  if (handle) {
    return {
      signed: true,
      sign(payload) {
        const sig = p.signMutation(new TextEncoder().encode(`${p.orgId}|${payload}`), p.orgId);
        if (!sig) throw new SigningKeyUnavailableError();
        return { signature_b64: sig.signature_b64, signature_key_version: sig.key_version };
      },
    };
  }

  const { data, error } = await p.client
    .from('org_signing_keys')
    .select('key_version')
    .eq('org_id', p.orgId)
    .limit(1);
  if (error) throw error;
  if ((data ?? []).length > 0) throw new SigningKeyUnavailableError();

  return {
    signed: false,
    sign: () => ({ signature_b64: null, signature_key_version: null }),
  };
}
