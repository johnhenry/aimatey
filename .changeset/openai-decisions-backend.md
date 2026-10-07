---
"@johnhenry/aimatey-backend": minor
---

`OpenAIBackendAdapter.decide()` speaks OpenAI's Decisions API (`POST /v1/decisions`, preview): `input` plus a `questions` array of `choice` / `predicate` / `score`, answers matched by `name`, probabilities as `{ value, probability }` arrays. It is on by default for api.openai.com and opt-in elsewhere with the new `decisions: true` config (`OpenAIBackendAdapterConfig`); the OpenAI-compatible adapters (Groq, LM Studio, OmniRoute, ...) keep not offering `decide()`. Images are sent as `data:` URLs (a `url` source throws), and an object `state` is sent as JSON text. New exports: `buildOpenAIDecisionsRequest`, `parseOpenAIDecisionsResponse`. The API enforces 2 to 255 choices, 2 to 10 levels and 200 questions, declared in `decisionLimits`.

Removed the never-shipped, unverified `'openai-decisions'` dialect from `SystemOneBackendAdapter` / `SYSTEMONE_DIALECTS` (and the `predicate` / `rubric` answer-type aliases); OpenAI's wire format is not System One, so use `OpenAIBackendAdapter` instead.
