import { decryptOrganization } from '@/lib/crypto-fields';

/** Shown for an organization whose name is sealed with another vault key. */
export const LOCKED_ORG_NAME = 'Locked organization (switch to it to see its name)';

type DecryptFn = (ciphertext: string) => Promise<string>;

export interface OrgListEntry {
  id: string;
  name: string;
  locked: boolean;
}

/**
 * Decrypt the organization names for the switcher.
 *
 * Each organization seals its name with its own vault key, so only the open
 * organization's name can be read with the unlocked vault. Names of other
 * organizations that fail to decrypt are shown as locked instead of failing
 * the whole list. A failure on the open organization itself is a real error
 * and is rethrown.
 *
 * Returns the list and the organization that should be active: the stored
 * one when it is still a membership, otherwise the first in the list.
 */
export async function loadOrgList(
  rows: ReadonlyArray<{ id: string; name: string; key_version?: number | null }>,
  decrypt: DecryptFn,
  storedActiveId: string | null,
): Promise<{ orgs: OrgListEntry[]; activeId: string | null }> {
  const activeId =
    storedActiveId && rows.some((o) => o.id === storedActiveId)
      ? storedActiveId
      : (rows[0]?.id ?? null);

  const orgs = await Promise.all(
    rows.map(async (org) => {
      try {
        const dec = await decryptOrganization(org, decrypt);
        return { id: org.id, name: dec.name, locked: false };
      } catch (error) {
        if (org.id === activeId) throw error;
        return { id: org.id, name: LOCKED_ORG_NAME, locked: true };
      }
    }),
  );

  return { orgs, activeId };
}
