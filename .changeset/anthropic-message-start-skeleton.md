---
'@johnhenry/aimatey-frontend': patch
---

Anthropic frontend: `message_start` now carries the full message skeleton Anthropic sends (`content: []`, `stop_reason: null`, `stop_sequence: null`, `usage: { input_tokens, output_tokens }`), so Anthropic SDKs that read the first event no longer trip over missing fields. `message_delta` also reports `input_tokens` when the IR usage has them. A failed stream now ends with Anthropic's `error` event carrying an Anthropic error type (`rate_limit_error`, `overloaded_error`, `invalid_request_error`, `authentication_error`, `permission_error`, `not_found_error`, otherwise `api_error`) instead of the IR error code, and nothing is emitted after it (a stream that throws reports `api_error` instead of `stream_error`).
