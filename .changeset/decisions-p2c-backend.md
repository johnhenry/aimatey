---
"@johnhenry/aimatey-backend": minor
---

`TogetherAIBackendAdapter` implements `decide()` for Together's Tev1 models (`together/Tev1-4B-experimental`, `together/Tev1-0.8B-experimental`). Tev1 is not a System One API: each question is one chat-completions call (fixed system prompt, a JSON user message of `state` / `question` / `options`, `temperature: 0`, `logprobs` with `top_logprobs: 24`) and the model answers one letter, A to X. Questions run concurrently, 4 at a time by default (`parameters.custom.concurrency`).

- `choice` is native (2 to 24 options; more throws a `ProviderError` naming the question). `noul` and `score` are emulated on the same protocol with neutral option keys (`0`/`1`, `0`..`N-1`) to avoid option-name bias, and each emulated answer carries a warning.
- `probabilities` are the softmax of the first token's `top_logprobs` over the valid option letters (letters missing from it get 0), `confidence` is `1 - H(p) / ln(n)`. When Together returns no logprobs the answer has neither, plus a warning.
- Capabilities: `decisions`, `decisionTypes: ['choice']`, `decisionsEmulatedTypes: ['noul', 'score']`, `decisionLimits: { maxChoiceOptions: 24 }`, `decisionModels`, `decisionImages: false`. `estimateDecisionCost()` reads the registry ($0.042 per 1M input tokens).
