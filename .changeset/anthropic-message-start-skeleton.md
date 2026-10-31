---
'@johnhenry/aimatey-frontend': patch
---

Anthropic frontend: `message_start` now carries the full message skeleton Anthropic sends (`content: []`, `stop_reason: null`, `stop_sequence: null`, `usage: { input_tokens, output_tokens }`), so Anthropic SDKs that read the first event no longer trip over missing fields. `message_delta` also reports `input_tokens` when the IR usage has them.
