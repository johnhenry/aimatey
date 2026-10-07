---
"@johnhenry/aimatey-backend": minor
---

The Ollama adapter now supports tool calling (#168). `capabilities.tools` is `true`; `request.tools` is forwarded to `/api/chat` as `tools`, `message.tool_calls` becomes IR `tool_use` content with `finishReason: 'tool_calls'` (a call without a server-supplied id gets the deterministic id `call_<index>`), and IR `tool_use` / `tool_result` blocks in the history are sent back as assistant `tool_calls` and `role: 'tool'` messages (with `tool_name` when resolvable). Streamed tool calls are emitted as `tool_use` chunks and assembled on the `done` chunk. `toolChoice: 'none'` withholds the tools; `'required'` and a forced tool name have no Ollama equivalent and add a `parameter-unsupported` warning.
