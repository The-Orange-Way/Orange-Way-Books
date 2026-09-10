import { describe, expect, it } from 'vitest';
import {
  decryptStealthPage,
  decryptStealthRecord,
  decryptStealthTx,
  fetchAllStealthTransactions,
  type SealedStealthTxRow,
  type StealthTransactionsPage,
} from './stealth-transactions';

async function randomAesGcmKey(): Promise<CryptoKey> {
  const raw = window.crypto.getRandomValues(new Uint8Array(32));
  return window.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** Seal a plaintext object the same way the wire contract describes: a
 *  fresh 12-byte IV, AES-256-GCM, ciphertext and auth tag concatenated
 *  (WebCrypto's own output shape). */
async function sealFixture(
  plaintext: unknown,
  key: CryptoKey,
): Promise<SealedStealthTxRow['sealed_record']> {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(JSON.stringify(plaintext));
  const ciphertext = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    iv_b64: bytesToBase64(iv),
    ciphertext_b64: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

const FIXTURE_TX = {
  id: 'stealth-tx-1',
  adapter: 'stealth-btc',
  direction: 'in' as const,
  type: 'onchain' as const,
  amount_sats: 21000,
  currency: 'BTC',
  timestamp: '2026-09-08T00:00:00Z',
  source_wallet_id: null,
};

describe('decryptStealthRecord', () => {
  it('round-trips a sealed record under the correct key', async () => {
    const credKey = await randomAesGcmKey();
    const sealed = await sealFixture(FIXTURE_TX, credKey);
    const json = await decryptStealthRecord(sealed, credKey);
    expect(JSON.parse(json)).toEqual(FIXTURE_TX);
  });

  it('refuses a version other than 1 without touching WebCrypto', async () => {
    const credKey = await randomAesGcmKey();
    const sealed = await sealFixture(FIXTURE_TX, credKey);
    await expect(decryptStealthRecord({ ...sealed, version: 2 }, credKey)).rejects.toThrow(
      /Unsupported sealed_record shape/,
    );
  });

  it('refuses an algorithm other than AES-256-GCM', async () => {
    const credKey = await randomAesGcmKey();
    const sealed = await sealFixture(FIXTURE_TX, credKey);
    await expect(
      decryptStealthRecord({ ...sealed, algorithm: 'AES-128-GCM' }, credKey),
    ).rejects.toThrow(/Unsupported sealed_record shape/);
  });

  it('throws on the wrong key, this is the exact regression this file exists to close', async () => {
    const credKey = await randomAesGcmKey();
    const wrongKey = await randomAesGcmKey();
    const sealed = await sealFixture(FIXTURE_TX, credKey);
    await expect(decryptStealthRecord(sealed, wrongKey)).rejects.toThrow();
  });
});

describe('decryptStealthTx / decryptStealthPage', () => {
  it('decrypts a good row to a per-row success, an unopenable row to a per-row failure, never aborting the page', async () => {
    const credKey = await randomAesGcmKey();
    const wrongKey = await randomAesGcmKey();
    const goodSealed = await sealFixture(FIXTURE_TX, credKey);
    const badSealed = await sealFixture(FIXTURE_TX, wrongKey);

    const page: StealthTransactionsPage = {
      connection_id: 'conn-1',
      transactions: [
        {
          id: 'row-good',
          sealed_record: goodSealed,
          occurred_at: '2026-09-08T00:00:00Z',
          block_height: 900000,
          txid_blind_index_hex: 'a'.repeat(64),
          created_at: '2026-09-08T00:00:00Z',
        },
        {
          id: 'row-bad',
          sealed_record: badSealed,
          occurred_at: '2026-09-08T00:00:00Z',
          block_height: 900001,
          txid_blind_index_hex: 'b'.repeat(64),
          created_at: '2026-09-08T00:00:00Z',
        },
      ],
      total: 2,
      has_more: false,
      next_cursor: null,
    };

    const { ok, failed } = await decryptStealthPage(page, credKey);
    expect(ok).toHaveLength(1);
    expect(ok[0].id).toBe(FIXTURE_TX.id);
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe('row-bad');
    expect(failed[0].error).toBeTruthy();
  });

  it('decryptStealthTx never throws, even on a malformed sealed_record', async () => {
    const credKey = await randomAesGcmKey();
    const { tx, error } = await decryptStealthTx(
      {
        id: 'row-malformed',
        sealed_record: {
          version: 1,
          algorithm: 'AES-256-GCM',
          iv_b64: 'not-base64!!',
          ciphertext_b64: 'also-not-base64!!',
        },
        occurred_at: '2026-09-08T00:00:00Z',
        block_height: 1,
        txid_blind_index_hex: 'c'.repeat(64),
        created_at: '2026-09-08T00:00:00Z',
      },
      credKey,
    );
    expect(tx).toBeNull();
    expect(error).toBeTruthy();
  });
});

describe('fetchAllStealthTransactions', () => {
  it('follows next_cursor until has_more is false', async () => {
    const pages: StealthTransactionsPage[] = [
      {
        connection_id: 'conn-1',
        transactions: [{ id: 'a' } as SealedStealthTxRow],
        total: 3,
        has_more: true,
        next_cursor: { before_block: 100, before_txid_blind_index_hex: 'x'.repeat(64) },
      },
      {
        connection_id: 'conn-1',
        transactions: [{ id: 'b' } as SealedStealthTxRow, { id: 'c' } as SealedStealthTxRow],
        total: 3,
        has_more: false,
        next_cursor: null,
      },
    ];
    const calls: Array<{ before_block?: number; before_txid_blind_index_hex?: string }> = [];
    const fetchPage = async (args: {
      connection_id: string;
      limit?: number;
      before_block?: number;
      before_txid_blind_index_hex?: string;
    }) => {
      calls.push({
        before_block: args.before_block,
        before_txid_blind_index_hex: args.before_txid_blind_index_hex,
      });
      return pages[calls.length - 1];
    };

    const rows = await fetchAllStealthTransactions('conn-1', fetchPage);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b', 'c']);
    expect(calls).toHaveLength(2);
    expect(calls[0].before_block).toBeUndefined();
    expect(calls[1].before_block).toBe(100);
    expect(calls[1].before_txid_blind_index_hex).toBe('x'.repeat(64));
  });

  it('stops at maxPages rather than spinning forever on a server that never clears has_more', async () => {
    let callCount = 0;
    const fetchPage = async (): Promise<StealthTransactionsPage> => {
      callCount++;
      return {
        connection_id: 'conn-1',
        transactions: [{ id: `row-${callCount}` } as SealedStealthTxRow],
        total: 999,
        has_more: true,
        next_cursor: { before_block: callCount, before_txid_blind_index_hex: 'z'.repeat(64) },
      };
    };
    const rows = await fetchAllStealthTransactions('conn-1', fetchPage, 3);
    expect(rows).toHaveLength(3);
    expect(callCount).toBe(3);
  });
});
