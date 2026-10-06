---
"@johnhenry/aimatey-backend": minor
---

Typed-decision backends share one System One client. New `buildSystemOneRequest`, `parseSystemOneResponse`, `postSystemOne` and `decideViaSystemOne` (plus the `SYSTEMONE_DIALECTS` table and `SystemOneDialect` type) handle the `systemone`, `openrouter`, `vercel-evaluate`, `cloudflare` and (unverified) `openai-decisions` wire dialects: `type` present or inferred, `legend` ignored, object or array score probabilities, optional `probabilities`/`confidence` left absent, snake- and camelCase usage, and a missing answer throws a `ProviderError` naming the question. Responses are checked with `validateDecisionResponse` and its findings land on `metadata.warnings`. `TypeSafeBackendAdapter` is refactored onto it with unchanged behavior.

`OllamaBackendAdapter` gains `decide()` over `/v1/systemone` (base64 images, `parameters.custom.keepAlive`; a `url` image source throws), declares `decisions`, `decisionTypes`, `decisionLimits` (64 questions, 255 options, 26 levels), `decisionImages` and `decisionModels`, and `listModels()` marks decision models (`nimble`, `tev1`, `kev`, `clef`, `strands-decider`, `laya`) with `metadata.kind: 'decision'`; see `isOllamaDecisionModel`.

New decision-only `SystemOneBackendAdapter` for self-hosted Kev, Strands Decider, `laya[serve]` and Nimble servers, Vercel AI Gateway and OpenRouter.
