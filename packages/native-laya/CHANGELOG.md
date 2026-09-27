# @johnhenry/aimatey-native-laya

## 0.1.1

### Patch Changes

- 2a4d7e4: Correct two Laya wire-format assumptions that were based on reading source, not running it — caught by adding a real demo app (`examples/laya/triage-demo.ts`) and actually running it against a live `@receptron/laya` response:
  - `noul` answers do not reliably include a `confidence` field on the wire (contrary to the original claim). `LayaBackendAdapter.decide()` now derives one (`max(p, 1-p)`) the same way `LayaFrontendAdapter.fromIR()` already did for the reverse direction.
  - `score` answers' `value` is confirmed as a probability-weighted expected value over the level indices, not necessarily an integer -- already correctly typed at the IR level, but worth confirming live.
  - The RL-agent sub-object Laya answers carry is named `rl_agent` in a live `@receptron/laya` response, not `action` as originally documented (likely a difference between the Python reference this frontend adapter's types model and the TS/ONNX port `native-laya` actually talks to). Still dropped on the way into the IR either way.

## 0.1.0

### Minor Changes

- 6f5e0a9: Add `LayaBackendAdapter`, running ConvAI's Laya typed-decision model in-process via `@receptron/laya` -- a real TypeScript/ONNX Runtime port (github.com/receptron/laya), not a hosted API. No network call, no API key, no Python service.

  Split into two packages: `@johnhenry/aimatey-native-onnx` is a general `onnxruntime-node` integration layer (shared execution-provider/session/cache config, a lazy-load helper, consistent error mapping) not tied to Laya, so a future ONNX-backed adapter shares it rather than reinventing it -- mirroring how `native-model-runner` already generalizes subprocess-based local backends. `@johnhenry/aimatey-native-laya` is the first consumer, implementing only `metadata`/`decide()`/`estimateDecisionCost()` (decision-only, like `TypeSafeBackendAdapter`).

  Both are Node-only, deliberately: `onnxruntime-node` is native bindings and cannot run in a browser. A browser-capable variant needs `onnxruntime-web` instead (WASM/WebGPU, a genuinely different API), which would be a separate package -- see `native-onnx`'s module comment.

  Corrects `LayaFrontendAdapter`'s module comment, which previously assumed Laya needed a new, separately-hosted Python wrapper service before a backend adapter was possible. That assumption is now known wrong; `@receptron/laya` made it unnecessary.

### Patch Changes

- Updated dependencies [6f5e0a9]
- Updated dependencies [7cc27f9]
- Updated dependencies [22dc8ca]
  - @johnhenry/aimatey-native-onnx@0.1.0
  - @johnhenry/aimatey-types@0.6.0
  - @johnhenry/aimatey-errors@0.2.3
