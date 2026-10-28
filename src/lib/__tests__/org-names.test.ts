// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LOCKED_ORG_NAME, loadOrgList } from '../org-names';

// The open vault can only decrypt names sealed with its own key.
const decrypt = async (s: string) => {
  if (!s.startsWith('open:')) throw new DOMException('decrypt failed', 'OperationError');
  return s.slice('open:'.length);
};

const rows = [
  { id: 'a', name: 'open:Alpha', key_version: 2 },
  { id: 'b', name: 'other:Beta', key_version: 2 },
];

describe('loadOrgList', () => {
  it('keeps every organization when another one is sealed with its own key', async () => {
    expect(await loadOrgList(rows, decrypt, 'a')).toEqual({
      orgs: [
        { id: 'a', name: 'Alpha', locked: false },
        { id: 'b', name: LOCKED_ORG_NAME, locked: true },
      ],
      activeId: 'a',
    });
  });

  it('rethrows when the open organization itself cannot be decrypted', async () => {
    await expect(loadOrgList(rows, decrypt, 'b')).rejects.toThrow('decrypt failed');
  });

  it('falls back to the first organization when the stored one is not a membership', async () => {
    const result = await loadOrgList(rows, decrypt, 'gone');
    expect(result.activeId).toBe('a');
    expect(result.orgs).toHaveLength(2);
  });

  it('passes plaintext names through when there is no key version', async () => {
    expect(
      await loadOrgList([{ id: 'c', name: 'Plain', key_version: null }], decrypt, null),
    ).toEqual({ orgs: [{ id: 'c', name: 'Plain', locked: false }], activeId: 'c' });
  });
});
