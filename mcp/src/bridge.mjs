// Extension bridge interface.
//
// This is the seam between the MCP server (which holds no keys and no plaintext) and the
// browser extension (which holds the user's key in service-worker RAM and does the
// decryption locally). The MCP server asks the bridge for data; the extension pulls
// ciphertext under the user's normal auth, decrypts it inside its offscreen document using
// the app's existing crypto lib, and returns plaintext.
//
// The concrete transport (native messaging, localhost handshake, or other) is defined by
// the bridge contract. Until that contract is published, this module exposes the interface
// the server codes against and a stub that fails loudly with a clear instruction, so the
// server is runnable in an MCP client for tool discovery today without ever inventing a
// crypto path here.

export class BridgeNotConnectedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BridgeNotConnectedError';
  }
}

// The shape every real bridge implementation must satisfy. Each method returns already
// decrypted, plain JavaScript data. No method on this interface ever receives or returns a
// key, a passphrase, or a ciphertext blob; that boundary lives entirely inside the extension.
//
//   listAccounts(): Promise<Account[]>
//   listTransactions(params: { limit?: number, accountId?: string }): Promise<Transaction[]>
//   getBalance(params: { accountId: string }): Promise<{ accountId: string, balance: number, currency: string }>

export function createBridge() {
  // Slice 1 skeleton: no live transport yet. Replace this with the extension bridge client
  // once the bridge contract is published. The server needs no other change: it already
  // codes against the interface above.
  const notConnected = (tool) => {
    throw new BridgeNotConnectedError(
      `The browser extension is not connected, so "${tool}" cannot run yet. ` +
        'Slice 1 is a walking skeleton: tool discovery works, live data is wired once the ' +
        'bridge contract lands. Connect the extension and reload.',
    );
  };

  return {
    listAccounts: async () => notConnected('list_accounts'),
    listTransactions: async () => notConnected('list_transactions'),
    getBalance: async () => notConnected('get_balance'),
  };
}
