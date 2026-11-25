# @johnhenry/aimatey-tool-protocols

## 0.1.0

### Minor Changes

- b10e69e: `code` protocol prompt v2: a worked two-step example (fetch and log, then answer in a later reply), a rule never to call `final()` in the same snippet as a tool call whose result has not been seen, and a rule to read result types from the interface instead of guessing. New `codeProtocol({ systemPrompt })` option to supply your own prompt builder; the old prompt is available as the internal `buildLegacyCodePrompt` for ablations.
- 671abac: Add the `code` tool protocol: the model writes JavaScript against a generated `tools.*` API and a `CodeExecutor` runs it. Includes `codeProtocol()`, `registerCodeProtocol()`, `generateToolsInterface()` and `andboxExecutor()` (sandboxed via the optional peer `@johnhenry/andbox` in wasm mode). Every tool call from a snippet goes through the same validation, gate and execute path as native calls.
- 2c0700d: `ToolDefinition.outputSchema` (optional). `aimatey-mcp` carries an MCP tool's `outputSchema` onto its definition and, for such tools, returns `structuredContent` as the result value instead of flattened text. The `code` protocol types tool results from `outputSchema` (`Promise<unknown>` when absent).
- 1b89457: Add the `text` tool protocol (tool calling through a fenced JSON block, for models with no native tool support), `autoProtocol()` (native when the backend supports tools, else text) and `registerTextProtocols()`.

### Patch Changes

- Updated dependencies [2c0700d]
- Updated dependencies [211dc02]
  - @johnhenry/aimatey-types@0.10.0
  - @johnhenry/aimatey-utils@0.6.4
