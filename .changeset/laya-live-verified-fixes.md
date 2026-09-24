---
"@johnhenry/aimatey-native-laya": patch
"@johnhenry/aimatey-frontend": patch
---

Correct two Laya wire-format assumptions that were based on reading source, not running it — caught by adding a real demo app (`examples/laya/triage-demo.ts`) and actually running it against a live `@receptron/laya` response:

- `noul` answers do not reliably include a `confidence` field on the wire (contrary to the original claim). `LayaBackendAdapter.decide()` now derives one (`max(p, 1-p)`) the same way `LayaFrontendAdapter.fromIR()` already did for the reverse direction.
- `score` answers' `value` is confirmed as a probability-weighted expected value over the level indices, not necessarily an integer -- already correctly typed at the IR level, but worth confirming live.
- The RL-agent sub-object Laya answers carry is named `rl_agent` in a live `@receptron/laya` response, not `action` as originally documented (likely a difference between the Python reference this frontend adapter's types model and the TS/ONNX port `native-laya` actually talks to). Still dropped on the way into the IR either way.
