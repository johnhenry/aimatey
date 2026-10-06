---
"@johnhenry/aimatey-patterns": minor
---

`createEmulatedDecisionBackend` now coerces near-miss chat-model answers instead of rejecting them: `"true"`/`"false"` (any case) or `1`/`0` for `noul`, numeric strings for `score` indices, and a trimmed, case-insensitive match for `choice` keys and score labels (exact matches win). Each coercion adds a `response-malformed` warning. `createDecisionEscalation` gains `onUnmatchable?: 'throw' | 'skip'` (default `'throw'`); `'skip'` treats a leaf that cannot apply to the request's question types as not matched instead of throwing, and `validateDecisionCondition` takes the same option. Temperature scaling, ensembles, neutral option keys and `decisionBands` now compute `confidence` with the shared `decisionConfidence` / `noulConfidence`, so a computed `noul` confidence is the concentration of `[p, 1 - p]` rather than `max(p, 1 - p)`.
