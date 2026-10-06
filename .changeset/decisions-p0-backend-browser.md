---
"@johnhenry/aimatey-backend-browser": patch
---

`MockBackendAdapter` gains `decide()` (configured with `decisionAnswers` or `decisionHandler`, with an `allDecisionRequests` log) and now reports `capabilities.decisions: true`, so it can stand in for a decision backend as well as a chat one.
