---
"@johnhenry/aimatey-patterns": minor
---

Add `createEmulatedDecisionBackend(chatBackend, opts?)`: wraps any chat backend as a decision backend that answers `choice` / `score` / `noul` questions in one structured-output chat call (schema generated from the questions; `includeReasoning` populates `answer.reasoning`). It is opt-in, never applied by `Bridge` or `Router`, and returns **no** `probabilities` or `confidence`: it does not fake a distribution. Every response carries a `capability-unsupported` warning and the adapter declares `decisionsEmulated: true`. An answer outside its enum rejects with a `ProviderError` naming the question.
