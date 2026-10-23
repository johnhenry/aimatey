---
'@johnhenry/aimatey-backend': minor
---

Native tool calling for more OpenAI-compatible adapters (#207). Together AI, Fireworks, Mistral, xAI, Cerebras, DashScope, DeepInfra, Inception and AI21 now declare `capabilities.tools: true` and map `request.tools` / `toolChoice` to function schemas, blocking `tool_calls` to `tool_use` blocks, streamed tool-call fragments (assembled by index) to `tool_use` stream chunks and the final `done` message, and `tool_use` / `tool_result` history to assistant `tool_calls` and `role: 'tool'` messages. The mapping is shared (`buildOpenAICompatToolFields`, `convertIRMessageToOpenAICompat`, `buildOpenAICompatResponseMessage`, `ToolCallAssembler`, exported from `shared`) and the OpenRouter adapter now uses it too. AI21 sends `tools` only, since its docs do not list `tool_choice`. The OpenAI adapter (and the adapters built on it) no longer fails on a `content: null` reply that carries `tool_calls`.
