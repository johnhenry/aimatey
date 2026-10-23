---
'@johnhenry/aimatey-backend': minor
---

Cohere adapter moves from the legacy `/v1/chat` to the v2 Chat API (`/v2/chat`), with native tool calling (#215).

- `capabilities.tools` is now `true`: `tools` / `toolChoice` map to v2 function tools, assistant `tool_calls` become `tool_use` blocks (an optional leading text block, then one block per call), and IR `tool_use` / `tool_result` history is sent as assistant `tool_calls` and `role: 'tool'` messages with `tool_call_id`. Streamed `tool-call-start` / `-delta` / `-end` events become `tool_use` chunks (`id`, `name`, `inputDelta`, `index`) and the `done` message holds the assembled `tool_use` blocks with `finishReason: 'tool_calls'`. The model's `tool_plan` is not surfaced.
- `toolChoice`: v2 only supports forcing or forbidding tools, so `'required'` sends `REQUIRED`, `'none'` sends `NONE`, `'auto'` is the default, and `{ name }` sends `REQUIRED` with only that tool offered.
- Breaking for 0.x: the wire format changed. Requests send a `messages` array (system, user, assistant, tool) instead of `message` / `chat_history` / `preamble`, so the last message no longer has to be from the user. `CohereRequest`, `CohereResponse` and the stream event types are now the v2 shapes. Streaming is real SSE (`content-delta`, `tool-call-*`, `message-end`) instead of newline-delimited JSON, and usage now reaches the final `done` chunk. `seed` is now sent (`supportsSeed: true`) and up to 5 stop sequences are allowed. `finish_reason` `ERROR` and `TIMEOUT` now map to `'error'` (they were `'stop'`); `STOP_SEQUENCE` maps to `'stop'` and `TOOL_CALL` to `'tool_calls'`.
- Removed: the v1-only `connectors` option (`parameters.custom.connectors`) is no longer sent; v2 has no connectors. `parameters.custom.documents` and citations (`metadata.custom.citations`, and `citations` on the `done` chunk) keep working.
- `baseURL` migration: the default is now `https://api.cohere.com/v2`. A custom `baseURL` ending in `/v1` (including the old `https://api.cohere.ai/v1`) is rewritten to `/v2`; a bare origin such as a proxy gets `/v2` appended; any other path is used as given. `listModels()` and `healthCheck()` still call the v1 `/models` and `/check-api-key` endpoints, and `embed()` is unchanged.
- The default model is now `command-r7b-12-2024` when neither `parameters.model` nor `defaultModel` is set (v2 requires a model).
