// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { LOCKED_ORG_NAME, decryptOrgNames } from '../org-names';

// The open vault can only decrypt names sealed with its own key.
const decrypt = async (s: string) => {
  if (!s.startsWith('open:')) throw new DOMException('decrypt failed', 'OperationError');
  return s.slice('open:'.length);
};

describe('decryptOrgNames', () => {
  it('keeps every organization when one name is sealed with another key', async () => {
    const result = await decryptOrgNames(
      [
        { id: 'a', name: 'open:Alpha', key_version: 2 },
        { id: 'b', name: 'other:Beta', key_version: 2 },
      ],
      decrypt,
    );
    expect(result).toEqual([
      { id: 'a', name: 'Alpha', locked: false },
      { id: 'b', name: LOCKED_ORG_NAME, locked: true },
    ]);
  });

  it('passes plaintext names through when there is no key version', async () => {
    expect(await decryptOrgNames([{ id: 'c', name: 'Plain', key_version: null }], decrypt)).toEqual(
      [{ id: 'c', name: 'Plain', locked: false }],
    );
  });
});
