---
'@johnhenry/aimatey-core': patch
'@johnhenry/aimatey-types': patch
---

`Router.dispatchParallel()` now translates the model for each backend it dispatches to (backend-specific mapping, global mapping, patterns, default), as `dispatch()` and streaming already did, instead of sending every backend the caller's model name. The `'custom'` strategy now calls `customAggregator` with every successful leg and returns its answer (it may be async); it fails fast when no aggregator is given, and `allResponses` is filled for `'custom'` as for `'all'`.
