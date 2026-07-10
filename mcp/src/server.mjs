#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createBridge } from './bridge.mjs';
import { registerReadOnlyTools } from './tools.mjs';

// Orange Way Books local MCP server (slice 1, read-only).
//
// Runs on the user's own machine over stdio and is added to an MCP client such as Claude
// Desktop. It exposes ledger read tools and delegates every data request to the browser
// extension through the bridge. This process holds no key, no passphrase, and no
// plaintext at rest: it forwards decrypted results the extension hands back, in memory,
// scoped to the call. There is no persistence and no logging of ledger data here.

async function main() {
  const server = new McpServer({
    name: 'owb-mcp',
    version: '0.0.1',
  });

  const bridge = createBridge();
  registerReadOnlyTools(server, bridge);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // Never print ledger data or key material. A startup failure is the only thing worth
  // surfacing, and the bridge is designed to carry no secrets in its errors.
  process.stderr.write(`owb-mcp failed to start: ${err?.message ?? err}\n`);
  process.exit(1);
});
