# @johnhenry/aimatey-native-laya

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
