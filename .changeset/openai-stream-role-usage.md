---
'@johnhenry/aimatey-frontend': patch
---

OpenAI frontend streams now pass the official `openai` SDK's stream helpers (`chat.completions.stream()`, `finalChatCompletion()`):

- The first delta carries `role: 'assistant'`, as OpenAI sends it. Without it the SDK failed with "missing role for choice 0", for text and tool-call streams alike.
- The chunk with `finish_reason` carries `usage` (`prompt_tokens`, `completion_tokens`, `total_tokens`) when the backend reported it, so `stream_options: { include_usage: true }` clients get the token counts. `OpenAIStreamChunk` gains the optional `usage` field.
