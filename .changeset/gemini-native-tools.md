---
'@johnhenry/aimatey-types': minor
'@johnhenry/aimatey-backend': minor
---

Native function calling for the Gemini backend adapter (#214). IR tools map to `tools[].functionDeclarations`, `toolChoice` maps to `toolConfig.functionCallingConfig` (`AUTO` / `ANY` / `NONE`, plus `allowedFunctionNames` for a named tool), `functionCall` parts become `tool_use` blocks (finish reason `tool_calls`), and `tool_result` blocks become `functionResponse` parts with the function name resolved from the earlier `tool_use`. Gemini sends no call ids, so `call_<n>` ids are generated. Streamed calls are assembled into `tool_use` chunks and `done` message blocks like the other adapters. `capabilities.tools` is now `true` and the tool-unsupported warning is gone.

`ToolUseContent` and the `tool_use` stream chunk gain an optional, backward-compatible `providerMetadata` field. Gemini keeps its `thoughtSignature` at `providerMetadata.gemini.thoughtSignature` and echoes it on the `functionCall` part when the block is sent back; other adapters ignore it.

Fix: `executeStream` now calls `streamGenerateContent` with `alt=sse`. Without it Gemini returns a JSON array, so no `data:` lines were parsed and streaming yielded no content.
