/**
 * OWB Invoicing, Bitwarden Send pattern for the customer-facing hosted view.
 *
 * When an org sends an invoice, the org's browser:
 *   1. Builds the payload (decrypted invoice + line items) to render
 *   2. Generates a fresh 256-bit AES-GCM key
 *   3. Encrypts the payload under that key
 *   4. Persists the encrypted blob + a non-secret 16-char url id
 *   5. Returns a share URL of the form
 *        https://books.orangeway.app/i/<urlId>#<key-base64url>
 *      The fragment (after `#`) is the key. Browsers never send fragments
 *      to the server, so the decryption key is invisible to OWB.
 *
 * Customer's browser:
 *   1. Loads /i/<urlId>
 *   2. Reads key from location.hash
 *   3. Calls anon RPC get_public_invoice(p_url_id) → encrypted blob
 *   4. Decrypts in-browser
 *   5. Renders + calls record_public_invoice_view(p_url_id) for status hook
 *
 * ZKA preserved end-to-end: server holds ciphertext + non-secret metadata only.
 */

const URL_ID_LENGTH = 16;
const URL_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

export interface InvoiceSharePayload {
  invoice_number: string;
  status: string;
  currency: string;
  amount: number;
  issue_date: string | null;
  due_date: string | null;
  customer_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  customer_address: string | null;
  memo: string | null;
  payment_instructions: string | null;
  lines: Array<{
    description: string;
    amount: number;
    quantity: number | null;
    unit_price: number | null;
  }>;
}

export interface InvoiceShareCreate {
  publicUrlId: string;
  encryptedShareBlob: string;
  /** base64url-encoded AES-256-GCM key. Goes in the URL fragment. */
  shareKey: string;
  /** Full share URL ready to embed in the customer email. */
  shareUrl: string;
}

function randomUrlId(): string {
  const bytes = new Uint8Array(URL_ID_LENGTH);
  window.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += URL_ALPHABET[bytes[i] % URL_ALPHABET.length];
  }
  return out;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4;
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Build the encrypted share blob client side. Returns the urlId (non-secret),
 * the encrypted blob, the AES key (to embed in the URL fragment), and the
 * full share URL.
 *
 * Caller persists `publicUrlId` + `encryptedShareBlob` to the invoices row.
 */
export async function buildInvoiceShare(
  payload: InvoiceSharePayload,
  baseUrl: string,
): Promise<InvoiceShareCreate> {
  // 1. Generate a fresh 32-byte AES-256-GCM key (no reuse across invoices)
  const keyBytes = new Uint8Array(32);
  window.crypto.getRandomValues(keyBytes);
  const key = await window.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  // 2. Encrypt the JSON payload
  const iv = new Uint8Array(12);
  window.crypto.getRandomValues(iv);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = new Uint8Array(
    await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );

  // 3. Pack iv + ciphertext as base64. Server stores this exact string.
  const blob = new Uint8Array(iv.length + cipher.length);
  blob.set(iv, 0);
  blob.set(cipher, iv.length);
  const encryptedShareBlob = bytesToBase64Url(blob);

  // 4. Generate a non-secret url id + share URL with the key in the fragment
  const publicUrlId = randomUrlId();
  const shareKey = bytesToBase64Url(keyBytes);
  const cleanBase = baseUrl.replace(/\/$/, '');
  const shareUrl = `${cleanBase}/i/${publicUrlId}#${shareKey}`;

  return { publicUrlId, encryptedShareBlob, shareKey, shareUrl };
}

/**
 * Customer-side: decrypt the share blob using the key from the URL fragment.
 * Returns the original payload or throws on tamper / bad key.
 */
export async function decryptInvoiceShare(
  encryptedShareBlob: string,
  shareKey: string,
): Promise<InvoiceSharePayload> {
  const blob = base64UrlToBytes(encryptedShareBlob);
  if (blob.length < 13) {
    throw new Error('Encrypted blob too short to contain an IV');
  }
  const iv = blob.slice(0, 12);
  const cipher = blob.slice(12);
  const keyBytes = base64UrlToBytes(shareKey);
  const key = await window.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plain = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  const text = new TextDecoder().decode(plain);
  return JSON.parse(text) as InvoiceSharePayload;
}
