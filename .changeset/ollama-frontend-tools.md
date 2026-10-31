---
'@johnhenry/aimatey-frontend': minor
---

Ollama frontend gains tools and the rest of `/api/chat`:

- `toIR` maps `tools` to IR tools, an assistant message's `tool_calls` (object arguments; ids kept or generated) to `tool_use` blocks, and `role: 'tool'` messages to `tool_result` blocks (matched by `tool_call_id`, or by `tool_name` in call order). It also maps `images` (base64, media type sniffed), `format` (`'json'` or a JSON Schema) to `responseFormat`, and the `seed`, `frequency_penalty`, `presence_penalty`, `repeat_penalty` options. Bad requests reject with `AdapterConversionError`.
- `fromIR` returns `message.tool_calls`, `done_reason` and the token counts.
- `fromIRStream` now yields `/api/chat` response objects (one per NDJSON line) instead of pre-serialised strings: text as partial messages, tool calls whole in one partial message, then the `done: true` response with `done_reason` and counts; a failed stream ends with `{ error }` (`isOllamaStreamError()`). Callers that wrote the old strings must now write `JSON.stringify(chunk) + '\n'`.
