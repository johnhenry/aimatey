# @johnhenry/aimatey-mcp

## 0.1.5

### Patch Changes

- Updated dependencies [7cc27f9]
- Updated dependencies [22dc8ca]
  - @johnhenry/aimatey-types@0.6.0

## 0.1.4

### Patch Changes

- Updated dependencies [c26ae12]
- Updated dependencies [305af90]
  - @johnhenry/aimatey-types@0.5.0

## 0.1.3

### Patch Changes

- Updated dependencies [f8266bf]
- Updated dependencies [07842f9]
- Updated dependencies [2ef419e]
  - @johnhenry/aimatey-types@0.4.0

## 0.1.2

### Patch Changes

- Updated dependencies [3467132]
- Updated dependencies [681fa2d]
- Updated dependencies [30629d4]
- Updated dependencies [eb8580b]
- Updated dependencies [e800f3d]
- Updated dependencies [582a4e5]
- Updated dependencies [71e5631]
  - @johnhenry/aimatey-types@0.3.0

## 0.1.1

### Patch Changes

- Updated dependencies [6e79fa1]
- Updated dependencies [213b23e]
- Updated dependencies [0ac4957]
  - @johnhenry/aimatey-types@0.2.0

## 0.1.0

### Minor Changes

- Republish from current main with a real fresh build.

  The 0.0.0 scope-import publishes (2026-08-26) shipped stale dist output --
  local npm publish without a rebuild, so the tarballs were missing everything
  after mid-July: the OmniRoute/GitHub Models/DashScope/Moonshot/SambaNova/
  Inception providers, litert-lm, the embeddings types module, and the
  provider-default-model fixes. This release republishes every package from
  current main (which also includes the 2026-08-26 audit fixes) via the CI
  release workflow, which always builds fresh before publishing.

### Patch Changes

- Updated dependencies
  - @johnhenry/aimatey-types@0.1.0

> Previously published as `aimatey-mcp`, last unscoped version `0.1.0`.

## 0.1.0

### Minor Changes

- d21fe3d: New package: `aimatey-mcp` - MCP (Model Context Protocol) tool-calling for Aimatey.

  Translates MCP tools into the `ToolDefinition` shape consumed by `aimatey-core`'s
  `Bridge.runTools()` agentic loop, via an injectable `McpClientLike` client - no hard (or peer)
  dependency on any MCP SDK. Any client satisfying the small structural interface (`listTools`,
  `callTool`) works: the official `@modelcontextprotocol/sdk` wrapped by hand,
  [`mcp-query`](https://github.com/johnhenry/mcp-query) (`@johnhenry/mcpq`), or a test fake.
  Also compatible with WebMCP-exposed tools via `mcp-query`'s `webMcpToolServer()` shim, with no
  changes needed on either side.

  Exports: `McpClientLike`/`McpToolSchema`/`McpCallToolResult` (structural types),
  `mcpToolToIRTool`/`extractMcpResultText` (pure MCP↔IR conversion), `mcpToolsToDefinitions`
  (MCP tools → `Record<string, ToolDefinition>`), and `runMcpTools` (a convenience wrapper composing
  `mcpToolsToDefinitions` with an already-bound `runTools` function, e.g. `bridge.runTools`).

  Depends only on `aimatey-types` - `aimatey-core` itself is untouched by this change.
