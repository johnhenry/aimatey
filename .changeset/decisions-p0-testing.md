---
"@johnhenry/aimatey-testing": minor
---

Add `createMockDecisionBackend(config)`: a decision-only mock backend taking `{ answers?, handler?, latencyMs?, error?, name?, model? }` and exposing a `calls` log of every `IRDecisionRequest` it received. Exports the `MockDecisionBackend` and `MockDecisionBackendConfig` types.
