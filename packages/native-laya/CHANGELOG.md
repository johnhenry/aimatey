# @johnhenry/aimatey-native-laya

## 0.2.0

### Minor Changes

- b74fe24: `LayaBackendAdapter` repairs:
  - `decide(request, signal)` honours `signal`: it rejects with the signal's `AbortError` before loading, before running `systemOne()`, and after the result arrives (an in-flight ONNX run cannot be cancelled).
  - Answers are built by iterating `request.questions`, so a question Laya did not answer throws a `ProviderError` naming it, rather than going missing.
  - The per-answer `rl_agent` sub-object is kept, per question, under `response.raw.rl_agent`.
  - Declares `capabilities.decisionModels: ['english', 'multilingual', 'typed-decisions']`.
  - `@receptron/laya`'s `systemOne(state, questions)` takes no checkpoint, `task` or `lang`, so `parameters.model` (when it differs from the configured `subfolder`) and `parameters.custom.task` / `lang` now produce `parameter-unsupported` warnings on `response.metadata.warnings` instead of being dropped silently.
  - Corrects the stale module comment that said `noul` answers carry a real `confidence`.

  Also declares `decisionTypes`, `decisionLimits` (20 choice options, 10 score levels, 512 state tokens, 0 images) and `decisionImages: false`, sets `response.provider: 'laya'`, and warns (`capability-unsupported`) when a request carries images.

### Patch Changes

- a75dfb1: Every shipped adapter now sets `IRProvenance.locality` on the hop it adds (#174). Cloud providers declare `'external'`. The OpenAI-compatible family (including LM Studio and OmniRoute), Ollama and the System One adapters derive it from the resolved base URL: `'same-host'` for loopback or a unix socket, `'external'` otherwise, with `servedBy` set to the URL's `host[:port]`. `native-apple`, `native-laya`, `native-node-llamacpp` and the in-browser adapters declare `'in-process'`; `native-model-runner` stamps `'same-host'` (its runner is a child process) on whatever its subclasses build. The function backend takes an optional `locality` config, since only its author knows what the function does.

  Warm-up signals: Ollama reports `MODEL_LOADING` for a 503 "loading model" and for a deadline that expired while `/api/ps` shows the model not resident (also in-band on a stream); `native-model-runner` reports it for a request that arrives while `start()` is still waiting for the process; `native-node-llamacpp` reports it for a request that arrives while another request's load is running, and no longer loads the model twice in that case.

- 07d9bc7: Declare `decisionLimits.maxConcurrency: 1` (one ONNX session), so `Bridge.decideBatch` runs sequentially by default.
- Updated dependencies [291c3a5]
- Updated dependencies [f787563]
- Updated dependencies [bb94242]
- Updated dependencies [3a3c98b]
- Updated dependencies [ce029c0]
- Updated dependencies [e853983]
- Updated dependencies [5936850]
- Updated dependencies [07d9bc7]
- Updated dependencies [af22382]
- Updated dependencies [cee0de7]
- Updated dependencies [c115285]
- Updated dependencies [88ce5c7]
- Updated dependencies [88ce5c7]
- Updated dependencies [d28c9a8]
- Updated dependencies [e501444]
  - @johnhenry/aimatey-types@0.7.0
  - @johnhenry/aimatey-errors@0.3.0
  - @johnhenry/aimatey-native-onnx@0.1.1

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
