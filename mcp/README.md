# owb-mcp (Orange Way Books local MCP server)

Read-only MCP server that lets any MCP client read your Orange Way Books ledger, while your keys
and plaintext never leave your machine. MCP is an open standard, so this works with Claude Desktop,
Cursor, and any other MCP-compatible client. Nothing here is Claude-specific.

This is slice 1 of the plan "MCP ZKA agent access for OWB". It is intentionally small and
read-only. Writes come in a later, separately founder-gated slice. Orange Way Me ships the twin of
this server; the two are kept at parity.

## How it holds zero-knowledge

This process holds no key and no plaintext at rest. It exposes tools to the MCP client and
forwards each data request to a browser extension. The extension holds your data key in
service-worker RAM only, pulls ciphertext under your normal auth, and decrypts locally in its
offscreen document using the Orange Way Books crypto lib. Your servers only ever see ciphertext.

One honest trade-off: the decrypted result is handed to the model as a tool result. Your servers
never see it, but you are choosing to show your books to whichever LLM you connect. That is your
call.

## Status

Walking skeleton. The three read tools (`list_accounts`, `list_transactions`, `get_balance`) are
defined and discoverable in an MCP client today. Live data is wired once the browser extension
bridge contract is published; until then, calling a tool returns a clear "connect the extension"
message. No crypto is implemented in this folder by design.

## Run it (tool discovery)

```
cd mcp
npm install
npm start
```

## Add it to an MCP client

Any MCP-compatible client works. Add an entry under `mcpServers` in the client's config. For
Claude Desktop the config file is:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

Cursor and other clients use the same `mcpServers` shape in their own config.

```json
{
  "mcpServers": {
    "orange-way-books": {
      "command": "node",
      "args": ["/absolute/path/to/Orange-Way-Books/mcp/src/server.mjs"]
    }
  }
}
```

Replace the path with the absolute path to this file on your machine. If you use bun instead of
node, set `"command": "bun"` and `"args": ["run", "/absolute/path/.../mcp/src/server.mjs"]`. Restart
the client, and the three tools appear. Until the extension bridge is connected, calling a tool
returns a clear connect-the-extension message.

## Boundaries this code keeps

- No key, passphrase, or ciphertext is ever received or returned by the bridge interface.
- No persistence and no logging of ledger data.
- No crypto is reimplemented here. Decryption is the extension's job, reusing the audited OWB lib.
