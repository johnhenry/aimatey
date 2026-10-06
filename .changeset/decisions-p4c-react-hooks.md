---
"@johnhenry/aimatey-react-hooks": minor
---

New `useDecision(questions, options?)` and `useDecisionBatch(questions, options?)` hooks for typed-decision models, on `Bridge.decide` / `Bridge.decideBatch`. `useDecision` returns `{ answers, response, decide, isLoading, error, abort, reset }`: `decide()` aborts the call in flight and drops its response, `auto` + `initialState` runs on mount and when the questions' content changes, and unmounting aborts. `useDecisionBatch` adds `progress` and per-state `PromiseSettledResult`s. A `DecisionBridgeProvider` context supplies the bridge.
