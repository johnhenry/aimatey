---
'@johnhenry/aimatey-types': minor
'@johnhenry/aimatey-mcp': minor
'@johnhenry/aimatey-tool-protocols': minor
---

`ToolDefinition.outputSchema` (optional). `aimatey-mcp` carries an MCP tool's `outputSchema` onto its definition and, for such tools, returns `structuredContent` as the result value instead of flattened text. The `code` protocol types tool results from `outputSchema` (`Promise<unknown>` when absent).
