---
"@johnhenry/aimatey-middleware": patch
---

Narrow the decision caching middleware's `DEFAULT_UNCACHEABLE_WARNINGS` and `uncacheableWarnings` option from `string[]` to `WarningCategory[]`, now that `capability-emulated` is a real category. LLM-emulated decision responses are not cached by default.
