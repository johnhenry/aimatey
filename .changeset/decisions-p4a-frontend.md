---
"@johnhenry/aimatey-frontend": minor
---

Add `VercelDecideFrontendAdapter` (AI SDK `decide()` shapes: `boolean` questions, `{ type: 'boolean', probability }` answers, camelCase usage, `providerMetadata.gateway`) and `OpenRouterDecisionsFrontendAdapter` (`/api/alpha/decisions` shapes: `provider`/`trace`/`session_id`/`user`, `id`/`provider`/`usage.cost` envelope). Both implement the decision hooks only; use them with `Bridge.decideFrom()`. `TypeSafeFrontendAdapter` is now documented as also the Ollama `/v1/systemone` shape.
