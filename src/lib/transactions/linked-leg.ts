import { decryptTransaction } from '@/lib/crypto-fields';

/**
 * Amount of the other leg of a transfer, as a positive number.
 * Encrypted rows store 0 in the plain `amount` column and the real value in
 * `encrypted_amount`, so the row must be decrypted before it is read.
 */
export async function linkedLegAmount(
  row: Record<string, unknown>,
  decrypt: (v: string) => Promise<string>,
): Promise<number> {
  const fields = await decryptTransaction(row, decrypt);
  return Math.abs(Number(fields.amount));
}
