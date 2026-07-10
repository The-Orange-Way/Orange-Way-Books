// Extension bridge interface.
//
// This is the seam between the MCP server (which holds no keys and no plaintext) and the
// browser extension (which holds the user's key in service-worker RAM and does the
// decryption locally). The MCP server asks the bridge for data; the extension reads the
// ledger from the database as sealed ciphertext plus plaintext metadata, under the user's
// own auth, and decrypts it locally in its offscreen document using the app's existing
// crypto lib. The server never sees a key or plaintext ciphertext.
//
// The transport between this server process and the extension is defined by the bridge
// contract. Until that contract is published, this module exposes the interface the server
// codes against and a stub that fails closed with a clear instruction, so the server is
// runnable in an MCP client for tool discovery today without inventing a crypto or transport
// path here.

// Fail-closed error taxonomy, agreed with the bridge and Auditor. A locked or missing key,
// or a decrypt that does not verify, must throw one of these and surface nothing. Never
// return an empty-but-success list: an empty list reads as "no data" and is a silent
// data-loss trap.
//
// - KEY_LOCKED: the session is locked; the user must unlock it.
// - KEY_MISSING: no key is provisioned for this session; re-provision.
// - DECRYPT_FAILED: the AEAD tag did not verify (tamper or corruption). Hard error.
// - EXTENSION_DISCONNECTED: the bridge transport is not connected (this skeleton's state).
//
// Hard rule for DECRYPT_FAILED: the thrown value must be opaque. It carries the code only.
// No plaintext, no ciphertext fragment, and no AEAD tag bytes ever appear in the error.
export const BridgeErrorCode = Object.freeze({
  KEY_LOCKED: 'KEY_LOCKED',
  KEY_MISSING: 'KEY_MISSING',
  DECRYPT_FAILED: 'DECRYPT_FAILED',
  EXTENSION_DISCONNECTED: 'EXTENSION_DISCONNECTED',
});

export class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
  }
}

// The shape every real bridge implementation must satisfy. Each method returns already
// decrypted, plain JavaScript data. No method on this interface ever receives or returns a
// key, a passphrase, or a ciphertext blob; that boundary lives entirely inside the extension.
//
//   listAccounts(): Promise<Account[]>
//   listTransactions({ accountId?, cursor?, limit }): Promise<{ transactions: Transaction[], nextCursor: string | null }>
//     Ordered (booked_at desc, id desc). Keyset pagination: pass back nextCursor to page.
//   getBalance({ accountId }): Promise<{ accountId, balance, currency }>

export function createBridge() {
  // Slice 1 skeleton: no live transport yet. Replace this with the extension bridge client
  // once the bridge contract is published. The server needs no other change: it already
  // codes against the interface above and the error taxonomy.
  const disconnected = (tool) => {
    throw new BridgeError(
      BridgeErrorCode.EXTENSION_DISCONNECTED,
      `The browser extension is not connected, so "${tool}" cannot run yet. ` +
        'Slice 1 is a walking skeleton: tool discovery works, live data is wired once the ' +
        'bridge contract lands. Connect the extension and reload.',
    );
  };

  return {
    listAccounts: async () => disconnected('list_accounts'),
    listTransactions: async () => disconnected('list_transactions'),
    getBalance: async () => disconnected('get_balance'),
  };
}
