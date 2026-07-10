import { z } from 'zod';

// Read-only ledger tools for slice 1. Each handler forwards to the bridge and returns the
// decrypted result as text content. The handlers never touch keys, passphrases, or
// ciphertext; that is the extension's job by construction.

export function registerReadOnlyTools(server, bridge) {
  server.registerTool(
    'list_accounts',
    {
      title: 'List accounts',
      description:
        "List the accounts in the user's Orange Way Books ledger (chart of accounts). " +
        'Read-only. Returns decrypted account names and types.',
      inputSchema: {},
    },
    async () => toContent(await bridge.listAccounts()),
  );

  server.registerTool(
    'list_transactions',
    {
      title: 'List transactions',
      description:
        'List transactions from the ledger, most recent first. Read-only. Optionally filter ' +
        'by account and cap the number returned.',
      inputSchema: {
        accountId: z.string().optional().describe('Only return transactions for this account id.'),
        limit: z
          .number()
          .int()
          .positive()
          .max(500)
          .optional()
          .describe('Maximum number of transactions to return (default 50).'),
      },
    },
    async ({ accountId, limit }) =>
      toContent(await bridge.listTransactions({ accountId, limit: limit ?? 50 })),
  );

  server.registerTool(
    'get_balance',
    {
      title: 'Get account balance',
      description:
        'Get the current balance of one account. Read-only. Returns the decrypted balance and ' +
        'currency.',
      inputSchema: {
        accountId: z.string().describe('The account id to get the balance for.'),
      },
    },
    async ({ accountId }) => toContent(await bridge.getBalance({ accountId })),
  );
}

function toContent(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
