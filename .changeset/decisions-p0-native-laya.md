---
"@johnhenry/aimatey-native-laya": minor
---

`LayaBackendAdapter` repairs:

- `decide(request, signal)` honours `signal`: it rejects with the signal's `AbortError` before loading, before running `systemOne()`, and after the result arrives (an in-flight ONNX run cannot be cancelled).
- Answers are built by iterating `request.questions`, so a question Laya did not answer throws a `ProviderError` naming it, rather than going missing.
- The per-answer `rl_agent` sub-object is kept, per question, under `response.raw.rl_agent`.
- Declares `capabilities.decisionModels: ['english', 'multilingual', 'typed-decisions']`.
- `@receptron/laya`'s `systemOne(state, questions)` takes no checkpoint, `task` or `lang`, so `parameters.model` (when it differs from the configured `subfolder`) and `parameters.custom.task` / `lang` now produce `parameter-unsupported` warnings on `response.metadata.warnings` instead of being dropped silently.
- Corrects the stale module comment that said `noul` answers carry a real `confidence`.

Also declares `decisionTypes`, `decisionLimits` (20 choice options, 10 score levels, 512 state tokens, 0 images) and `decisionImages: false`, sets `response.provider: 'laya'`, and warns (`capability-unsupported`) when a request carries images.
