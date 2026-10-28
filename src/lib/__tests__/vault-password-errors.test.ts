// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  WRONG_CURRENT_VAULT_PASSWORD,
  describeVaultPasswordChangeError,
} from '../vault-password-errors';

describe('describeVaultPasswordChangeError', () => {
  it('reports a wrong current password when the unwrap fails with an empty OperationError', () => {
    expect(describeVaultPasswordChangeError(new DOMException('', 'OperationError'))).toBe(
      WRONG_CURRENT_VAULT_PASSWORD,
    );
  });

  it('reports a wrong current password from a real Web Crypto decrypt failure', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'encrypt',
      'decrypt',
    ]);
    const err = await crypto.subtle
      .decrypt({ name: 'AES-GCM', iv: new Uint8Array(12) }, key, new Uint8Array(32))
      .catch((e: unknown) => e);
    expect(describeVaultPasswordChangeError(err)).toBe(WRONG_CURRENT_VAULT_PASSWORD);
  });

  it('keeps the message of other errors, including ones that mention "operation"', () => {
    expect(describeVaultPasswordChangeError(new Error('The operation was aborted'))).toBe(
      'The operation was aborted',
    );
    expect(
      describeVaultPasswordChangeError({ message: 'permission denied for table org_settings' }),
    ).toBe('permission denied for table org_settings');
  });

  it('never returns an empty message', () => {
    expect(describeVaultPasswordChangeError(new Error(''))).toBe(
      'Failed to change vault password.',
    );
    expect(describeVaultPasswordChangeError(undefined)).toBe('Failed to change vault password.');
  });
});
