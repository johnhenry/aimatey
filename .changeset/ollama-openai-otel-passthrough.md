---
'@johnhenry/aimatey-backend': minor
'@johnhenry/aimatey-frontend': minor
'@johnhenry/aimatey-middleware': patch
---

Stop dropping request options on the way through:

- Ollama backend: `responseFormat` is now native (sent as Ollama's `format` JSON Schema instead of a prompt instruction), and `seed`, `frequencyPenalty`, `presencePenalty` and `parameters.custom.repeatPenalty` (as `repeat_penalty`) are forwarded.
- OpenAI frontend: `response_format` (`json_schema`, `json_object`) maps to `responseFormat`, and `top_k` maps to `parameters.topK`.
- Middleware: importing the package root no longer breaks bundlers (esbuild, webpack, Vite) when the optional OpenTelemetry peers aren't installed.
