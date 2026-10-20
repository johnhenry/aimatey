---
'@johnhenry/aimatey-backend': minor
---

OpenRouter adapter: tool calling. `fromIR` maps `tools`, `toolChoice`, `tool_use` and `tool_result`; `toIR` and `executeStream` return `tool_calls` as `tool_use` blocks (streamed argument fragments are assembled by index, and the `done` chunk now waits for the trailing usage chunk). `capabilities.tools` is now `true`, and the `tool-unsupported` warning is gone for OpenRouter (#200).
