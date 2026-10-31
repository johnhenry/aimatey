---
'@johnhenry/aimatey-frontend': minor
---

New `OllamaGenerateFrontendAdapter` for Ollama's `/api/generate` (use it for that endpoint; `OllamaFrontendAdapter` serves `/api/chat`):

- `toIR` maps `system` to a system message, `prompt` plus `images` to a user message, and `format` and `options` as the chat adapter does.
- `raw`, `suffix`, `template` and the deprecated `context` have no IR equivalent. They are kept in `metadata.custom.ollama`, and each adds a `parameter-unsupported` warning. `keep_alive` is kept there too, with no warning.
- `fromIR` and `fromIRStream` produce the generate shape: `response` text instead of `message`, then a `done: true` line with `done_reason` and token counts, or `{ error }` on failure.
