# @johnhenry/aimatey-mcp

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-mcp.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-mcp)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-mcp.svg)](LICENSE)

> **Note:** Previously published as `aimatey-mcp@0.1.0`.

MCP (Model Context Protocol) tool-calling for the [aimatey](https://github.com/johnhenry/aimatey)
Universal AI Adapter System — translate an MCP server's tools into the agentic tool-execution
loop `@johnhenry/aimatey-core`'s `Bridge` already ships (`bridge.runTools()`), via an injectable client.

```bash
npm install @johnhenry/aimatey-mcp
```

No hard (or peer) dependency on any MCP SDK — `@johnhenry/aimatey-mcp` depends only on `@johnhenry/aimatey-types` and
a small structural interface (`McpClientLike`: `listTools`, `callTool`) that any MCP client can
satisfy: the official `@modelcontextprotocol/sdk`, [`mcp-query`](https://github.com/johnhenry/mcp-query)
(`@johnhenry/mcpq`), or a test fake.

## Why this is small

`@johnhenry/aimatey-core` already has a complete agentic loop (`Bridge.runTools()` / `createRunTools()`):
execute → if the model requests tools, run them → append results → re-execute, until the model
answers. This package doesn't reimplement any of that — it just converts MCP tools into the
`ToolDefinition` shape that loop already consumes, so MCP tool-calling gets the same validation,
iteration limits, and parallel execution for free.

## Quick start

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend';
import { runMcpTools } from '@johnhenry/aimatey-mcp';

// Any client satisfying McpClientLike - e.g. an mcp-query MCPClient already
// connected to one or more servers.
declare const mcpClient: import('@johnhenry/aimatey-mcp').McpClientLike;

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY })
);

const result = await runMcpTools(bridge.runTools, {
  client: mcpClient,
  prompt: 'What files changed in the last commit?',
});

console.log(result.text);
```

## API

| Export | Purpose |
|---|---|
| `McpClientLike` | The structural interface an injected MCP client must satisfy (`listTools`, `callTool`) |
| `mcpToolToIRTool(tool)` | Convert one MCP tool schema to an `IRTool` |
| `extractMcpResultText(result)` | Best-effort text extraction from an MCP `CallToolResult` |
| `mcpToolsToDefinitions(client, options?)` | List an MCP client's tools and build a `Record<string, ToolDefinition>` |
| `runMcpTools(runTools, options)` | Run `bridge.runTools()` (or any compatible `runTools` function) against an MCP client's tools |

`mcpToolsToDefinitions` and `runMcpTools` both accept:
- `server?: string` — which server to list/call tools against, for multi-server clients
- `toolFilter?: (tool: McpToolSchema) => boolean` — only include matching tools
- `signal?: AbortSignal` — forwarded to `callTool`

## Using your own tools object

If you want more control than `runMcpTools` gives you (e.g. mixing MCP tools with hand-written
ones), use `mcpToolsToDefinitions` directly and call `bridge.runTools()` yourself:

```typescript
import { mcpToolsToDefinitions } from '@johnhenry/aimatey-mcp';

const mcpTools = await mcpToolsToDefinitions(mcpClient);

const result = await bridge.runTools({
  prompt: 'Summarize the open issues.',
  tools: { ...mcpTools, myOwnTool: { description: '...', parameters: {...}, execute: async () => {...} } },
});
```

## WebMCP compatibility

Works with WebMCP-exposed tools (tools registered in-page via `document.modelContext`, consumed by
a browser-side agent) without any changes here - `mcp-query` ships `webMcpToolServer()`, an
in-memory MCP-server shim you can plug into `new MCPClient({ servers: { page: webMcpToolServer() } })`.
Any `MCPClient` built that way already satisfies `McpClientLike`.

## Protocol versions

`@johnhenry/aimatey-mcp` is protocol-version-agnostic by design: it never speaks MCP's wire protocol
(JSON-RPC, transports, capability negotiation) itself — it only calls `client.listTools()` and
`client.callTool()` through the `McpClientLike` structural interface. Whichever MCP protocol
revision(s) the *injected client* negotiates are supported transparently, with zero code in this
package caring about the difference.

Concretely, for the reference client [`mcp-query`](https://github.com/johnhenry/mcp-query)
(`@johnhenry/mcpq`), `ConnectionConfig` supports:

| Revision | Era | Notes |
|---|---|---|
| `2025-11-25` | legacy (v1) | Classic `initialize` handshake, unsolicited notifications, `resources/subscribe`, optional session resumption. **Default** when neither `versions` nor `versionNegotiation` is set. |
| `2026-07-28` | modern | `server/discover`-based negotiation, change notifications over a client-opened `subscriptions/listen` stream, no sessions/ping/`logging/setLevel`. |

```typescript
new MCPClient({
  servers: {
    // Default: legacy-only, no probe.
    a: { transport },
    // Additive: probe for modern, fall back losslessly to legacy.
    b: { transport, versions: ['2026-07-28', '2025-11-25'] },
    // Exclusive: pin to modern only - connect fails against a legacy-only server.
    c: { transport, versions: ['2026-07-28'] },
  },
});
```

Unknown revision strings are passed through to the SDK verbatim, so a future MCP revision needs
no change in `mcp-query` (or `@johnhenry/aimatey-mcp`) to support — only a new `versions` entry at the call
site. If you inject a different `McpClientLike` implementation (the official SDK wrapped by hand,
or your own), consult its docs for which revisions it negotiates; `@johnhenry/aimatey-mcp`'s behavior is
identical either way.

## License

MIT
