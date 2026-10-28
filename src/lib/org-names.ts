import { decryptOrganization } from '@/lib/crypto-fields';

/** Shown for an organization whose name is sealed with another vault key. */
export const LOCKED_ORG_NAME = 'Locked organization (switch to it to see its name)';

type DecryptFn = (ciphertext: string) => Promise<string>;

/**
 * Decrypts each organization's name with the open vault. Every organization
 * has its own vault key, so only the open one is guaranteed to decrypt; the
 * others get LOCKED_ORG_NAME instead of failing the whole list.
 */
export async function decryptOrgNames(
  rows: ReadonlyArray<{ id: string; name: string; key_version?: number | null }>,
  decrypt: DecryptFn,
): Promise<Array<{ id: string; name: string; locked: boolean }>> {
  return Promise.all(
    rows.map(async (org) => {
      try {
        const dec = await decryptOrganization(org, decrypt);
        return { id: org.id, name: dec.name, locked: false };
      } catch {
        return { id: org.id, name: LOCKED_ORG_NAME, locked: true };
      }
    }),
  );
}
