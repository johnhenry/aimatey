---
'@johnhenry/aimatey-mcp': minor
---

Handle newer MCP result shapes. A task-shaped `tools/call` result (`taskId`, `status`, no `content`) and an `input_required` result no longer throw a `TypeError`: they fail with the typed `McpTaskUnresolvedError` / `McpInputRequiredError`, and an optional `callToolTask` on `McpClientLike` (opt in with `preferTasks`) awaits the final result, cancelling on abort. `McpCallToolResult.structuredContent` is now `unknown` and `content` is optional. An MCP tool's `title`, `annotations` and `outputSchema` are kept on the IR tool under `metadata.mcp`, and `toolFilter` sees them.
