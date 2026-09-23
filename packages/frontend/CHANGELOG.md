# @johnhenry/aimatey-frontend

## 0.3.0

### Minor Changes

- 7cc27f9: Add `LayaFrontendAdapter`, translating `Router.predict()`/`Agent.system_one()`-shaped calls (ConvAI's Laya, a self-hosted typed-decision model) into the Decision IR.

  Frontend only, deliberately: Laya has no hosted API today -- confirmed, not assumed (no web-framework dependency in its `pyproject.toml`, and its only running instance is a quota-limited `ZeroGPU` demo Space, not something to build a production backend against). `LayaBackendAdapter` needs a new, separately-hosted Python wrapper service that doesn't exist yet; see `laya.ts`'s module comment for the exact contract that service should expose so the eventual backend adapter can be as thin as `TypeSafeBackendAdapter` is today.

  Along the way: `IRDecisionAnswer`'s `noul` variant gained an optional `confidence` field. Laya reports one (`max(p, 1-p)`); Jev's wire format doesn't -- it's optional rather than absent so a provider that has it isn't forced to throw it away, and `LayaFrontendAdapter` derives it when the upstream response doesn't supply one.

- 22dc8ca: Add a typed-decision capability, sibling to chat and embeddings, plus a backend/frontend adapter pair for TypeSafe's Jev.

  A typed-decision request ("System One" models: TypeSafe's Jev, ConvAI's Laya) sends a state and a set of typed questions (`choice`/`score`/`noul`) and gets back typed answers with calibrated probabilities in a single forward pass -- no generated text, nothing to parse. This is not a chat variant: it has its own IR (`IRDecisionRequest`/`IRDecisionResponse` in `decisions.ts`, mirroring `embeddings.ts`), its own `Bridge.decide()`/`useDecision()` entry point, and its own capability flags (`IRCapabilities.decisions`/`decisionModels`).

  **Breaking-adjacent, but backward compatible for every existing implementer:** `BackendAdapter.fromIR`/`toIR`/`execute`/`executeStream` are now optional. A decision-only backend (like the new `TypeSafeBackendAdapter`) implements only `metadata` and `decide()` -- it is not forced to fake a chat capability it doesn't have. Every existing chat backend still implements all four; nothing changes for it. `Bridge`/`Router`/the SDK wrappers (`packages/wrapper`) and the CLI's `ollama run`/proxy server now check for chat support up front and throw a clear `UNSUPPORTED_FEATURE` error if a decision-only backend is used somewhere that requires chat, instead of a raw "not a function" crash.

  New: `TypeSafeBackendAdapter` (`packages/backend/src/providers/typesafe.ts`) calling Jev's real `/systemone` API, and `TypeSafeFrontendAdapter` (`packages/frontend/src/adapters/typesafe.ts`) translating `@typesafe-ai/sdk`-shaped `systemOne()` calls into the Decision IR -- deliberately not an implementation of the (chat-typed) `FrontendAdapter` interface, since a decision request isn't a chat request in a costume.

### Patch Changes

- 6f5e0a9: Add `LayaBackendAdapter`, running ConvAI's Laya typed-decision model in-process via `@receptron/laya` -- a real TypeScript/ONNX Runtime port (github.com/receptron/laya), not a hosted API. No network call, no API key, no Python service.

  Split into two packages: `@johnhenry/aimatey-native-onnx` is a general `onnxruntime-node` integration layer (shared execution-provider/session/cache config, a lazy-load helper, consistent error mapping) not tied to Laya, so a future ONNX-backed adapter shares it rather than reinventing it -- mirroring how `native-model-runner` already generalizes subprocess-based local backends. `@johnhenry/aimatey-native-laya` is the first consumer, implementing only `metadata`/`decide()`/`estimateDecisionCost()` (decision-only, like `TypeSafeBackendAdapter`).

  Both are Node-only, deliberately: `onnxruntime-node` is native bindings and cannot run in a browser. A browser-capable variant needs `onnxruntime-web` instead (WASM/WebGPU, a genuinely different API), which would be a separate package -- see `native-onnx`'s module comment.

  Corrects `LayaFrontendAdapter`'s module comment, which previously assumed Laya needed a new, separately-hosted Python wrapper service before a backend adapter was possible. That assumption is now known wrong; `@receptron/laya` made it unnecessary.

- Updated dependencies [7cc27f9]
- Updated dependencies [22dc8ca]
  - @johnhenry/aimatey-types@0.6.0
  - @johnhenry/aimatey-utils@0.5.0
  - @johnhenry/aimatey-errors@0.2.3

## 0.2.1

### Patch Changes

- Updated dependencies [c26ae12]
- Updated dependencies [305af90]
  - @johnhenry/aimatey-types@0.5.0
  - @johnhenry/aimatey-utils@0.4.0
  - @johnhenry/aimatey-errors@0.2.2

## 0.2.0

### Minor Changes

- 2ef419e: Carry the served model on the chat response instead of improvising it per provider (#113).

  ## The gap

  The IR had no typed place to record **which model answered**. `IRParameters.model` is the
  request side, so the only source was the provider's own payload in `raw` -- which couples any
  generic reader to provider payload shapes. Two independent improvisations existed because of
  it: `openrouter`'s `metadata.custom.actualModel` (a write with no reader) and the dead
  `provenance.backendModel` read removed by #112.

  ## `IRProvenance.servedModel`

  ```ts
  { frontend: 'openai', backend: 'openai-backend', servedModel: 'gpt-4-0613' }
  ```

  **On provenance, not flat on the response**, because the served model is the one response
  fact whose value genuinely differs per hop. In `phone -> desktop -> llama-cpp` the model that
  answered belongs to the last hop, and the tunnel served nothing at all:

  ```ts
  {
    backend: 'tunnel',                                     // no servedModel: it forwarded
    upstream: { backend: 'llama-cpp', servedModel: 'qwen2.5-7b-instruct' }
  }
  ```

  A flat field -- on `IRChatResponse` or on `IRMetadata` -- could record only one of those two,
  reintroducing one field over the exact ambiguity #110 removed from `backend`. A consumer
  could not tell whether the phone ran qwen locally or the desktop did, which for a privacy
  surface is not a rounding error.

  The symmetry argument for a top-level `IRChatResponse.model` (matching `IREmbedResponse`) was
  considered and rejected: `IREmbedResponse.model` is **required** and falls back to the
  _requested_ model (`backend/src/shared.ts:349`, `json.model ?? model`), so it does not mean
  "the model that served" and copying it here would have meant asserting a model that never ran
  in precisely the substitution case this field exists to record.

  `resolveServedModel(provenance)` ships alongside `withUpstreamProvenance` in the types
  package (which `backend` depends on and `core` does not) and walks a chain **nearest-first**.
  Because a forwarding hop leaves its own `servedModel` unset, that returns the far end in the
  canonical proxy chain, while still resolving to a nearer hop that did report when the far one
  is a provider that reports nothing.

  `servedModel` is assigned as a **plain key**, not with the conditional-spread idiom used
  elsewhere in these metadata blocks. Excess-property checking does not see through a spread of
  a conditional expression, so a misspelled key written that way compiles silently -- which is
  how the non-existent `provenance.backendModel` survived until #112. Deleting the declaration
  now produces 18 `error TS2353`s, one per write site.

  ## Provider coverage, stated plainly

  **26 of 30** backend adapters populate it; **4** correctly leave it `undefined`.
  - **Direct (18):** ai21, anthropic, anyscale, azure-openai, cerebras, cloudflare, dashscope,
    deepinfra, fireworks, gemini, github-models, mistral, ollama, openai, openrouter,
    perplexity, together-ai, xai.
  - **Inherited (8):** deepseek, groq, inception, lmstudio, moonshot, nvidia, omniroute,
    sambanova -- all extend `OpenAIBackendAdapter` and none overrides `toIR()`.
  - **Absent (4):** cohere (v1 `/chat` returns no model field), aws-bedrock (Converse returns
    none, and an inference profile deliberately does not disclose it), huggingface
    (`{ generated_text }` only), replicate (`version` is what you _sent_, so echoing it back
    would look like coverage and be wrong).

  **Gemini is the one that changes.** #112's `raw.model` read could never see it: Gemini has no
  top-level `model` key at all, and reports the served model as `modelVersion` ("Output only.
  The model version used to generate the response"). `GeminiResponse` now declares that field
  and `toIR()` maps it, so the difference is the adapter's problem rather than tracing's.

  ## OpenTelemetry

  `ai.response.model` now reads the typed field first. `raw.model` is kept strictly as a
  **fallback** -- an out-of-tree `BackendAdapter` written before the field existed still
  compiles while setting only `raw`, and a cache or fixture may predate it; dropping the
  fallback would take those from "attribute set" to "attribute unset". It is deliberately not
  extended with per-provider keys: teaching it `raw.modelVersion` for Gemini would re-couple
  tracing to payload shapes in the same change that decouples it.

  When neither source reports, the attribute stays **absent** -- never filled from
  `parameters.model`. #112's rule is unchanged and still enforced by test.

  ## `'model-substituted'` is now verifiable end to end

  The router emits that warning when it routes to a model other than the one requested. A
  consumer was told a substitution happened but could not learn _what_ answered without parsing
  `raw` per provider. Both halves are now on the response: `warning.originalValue` is what was
  asked for, `resolveServedModel(...)` is what answered.

  ## Behaviour changes worth naming
  1. **The frontend wire projection.** `frontend/adapters/openai.ts` and `anthropic.ts` emitted
     `provenance.backend` as the payload's `model`, so an HTTP client of an aimatey server was
     handed `"model": "openai-backend"` in an otherwise OpenAI-shaped response. They now emit
     the served model, falling back to the old value so nothing that had a value loses one.
     **This changes bytes on the wire** and is the literal "improvising it per provider" of the
     issue title. **It applies to `chat()` only.** `chatStream()` builds its payload on a
     different path and still emits the backend adapter's name as `model` for every provider,
     so a client that streams sees no change from this release and a client that does both sees
     the two disagree. Closing that needs a served model on `StreamDoneChunk`, which has no
     metadata slot today -- a separate change, not an oversight of this one.
  2. **Two more dead reads fixed.** `frontend/adapters/mistral.ts` and `ollama.ts` read
     `metadata.custom.model`, whose only writer in the monorepo is Anthropic's _stream start
     chunk_ -- so on an `IRChatResponse` they always took their constant fallback
     (`'mistral-small'` / `'unknown'`). Same defect class as #112, in two more places.
  3. **`metadata.custom.actualModel` is kept**, as a deprecated alias computed from the same
     read so the two cannot disagree. Removal is uniquely un-warnable here: `custom` is
     `Record<string, unknown>`, so an external consumer loses the key with no compile error and
     no lint warning, just `undefined` rendered into a UI. Removed in the next major.

  Not breaking at the type level: the property is optional, `exactOptionalPropertyTypes` is
  off, and there is no `satisfies IRProvenance`, `Required<IRProvenance>` or
  `keyof IRProvenance` anywhere in the tree.

  ## Not in scope

  **Streaming.** OpenAI-shaped adapters emit their `start` chunk before any provider bytes are
  parsed, so covering streams needs a new `metadata` chunk emission -- an ordering-sensitive
  change across ~20 adapters. Anthropic alone could have been done for free, but that would
  make `chat()` and `chatStream()` agree for one provider and disagree for the rest, which is
  worse than deferring uniformly. Filed as follow-up.

### Patch Changes

- Updated dependencies [f8266bf]
- Updated dependencies [07842f9]
- Updated dependencies [9ac5666]
- Updated dependencies [2ef419e]
- Updated dependencies [5596299]
- Updated dependencies [5596299]
  - @johnhenry/aimatey-types@0.4.0
  - @johnhenry/aimatey-utils@0.3.0
  - @johnhenry/aimatey-errors@0.2.1

## 0.1.2

### Patch Changes

- 9fd19f4: Fix package readmes that documented APIs which do not exist (#61).

  These readmes ship in the published tarball (`files: ["dist", "readme.md", ...]`),
  so the wrong examples reached npm:
  - `@johnhenry/aimatey-middleware`: the quick-start built a bridge with
    `new Bridge({ frontend, backend, middleware: [...] })`. `Bridge` takes
    positional arguments and `BridgeConfig` has no `middleware` field, so that
    snippet produced a bridge with **no middleware, silently** - the same
    fail-quiet mode as #46, reached by following the readme. Middleware is
    registered with `bridge.use()`. Also corrected `initialDelayMs`/`maxDelayMs`
    to `initialDelay`/`maxDelay`, `ttlMs` to `ttl`, and `detectPromptInjection`
    to `preventPromptInjection`.
  - `@johnhenry/aimatey-frontend` and `@johnhenry/aimatey-http`: the same
    `new Bridge({ frontend, backend })` object form, corrected to the real
    positional constructor.
  - `@johnhenry/aimatey-http-core`: the entire quick-start and API reference
    described `createCorsMiddleware`, `validateApiKey` and `parseRequestBody`,
    none of which exist. Replaced with the real `CoreHTTPHandler` class and its
    `CoreHandlerOptions`.
  - `@johnhenry/aimatey-testing`: listed `MockBackendAdapter`, `createMockResponse`
    and `assertChatRequest` as its exports; none exist in this package. Replaced
    with the real fixture / assertion / property-testing surface, and a pointer to
    `MockBackendAdapter` in `@johnhenry/aimatey-backend-browser/mock`.
  - `@johnhenry/aimatey-utils`: documented `asyncGeneratorToReadableStream` and
    `readableStreamToAsyncGenerator`, which do not exist. Replaced with the real
    `splitStream` / `teeStream` helpers.
  - `@johnhenry/aimatey-react-core`: `OpenAIBackend` -> `OpenAIBackendAdapter`.

- Updated dependencies [3467132]
- Updated dependencies [681fa2d]
- Updated dependencies [22b9273]
- Updated dependencies [32415cc]
- Updated dependencies [30629d4]
- Updated dependencies [f8d20bf]
- Updated dependencies [eb8580b]
- Updated dependencies [9fd19f4]
- Updated dependencies [8b89edb]
- Updated dependencies [e800f3d]
- Updated dependencies [582a4e5]
- Updated dependencies [71e5631]
- Updated dependencies [0abfa0b]
- Updated dependencies [bb69513]
  - @johnhenry/aimatey-types@0.3.0
  - @johnhenry/aimatey-utils@0.2.0
  - @johnhenry/aimatey-errors@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [6e79fa1]
- Updated dependencies [213b23e]
- Updated dependencies [0ac4957]
  - @johnhenry/aimatey-types@0.2.0
  - @johnhenry/aimatey-errors@0.1.1
  - @johnhenry/aimatey-utils@0.1.1

## 0.1.0

### Minor Changes

- Republish from current main with a real fresh build.

  The 0.0.0 scope-import publishes (2026-08-26) shipped stale dist output --
  local npm publish without a rebuild, so the tarballs were missing everything
  after mid-July: the OmniRoute/GitHub Models/DashScope/Moonshot/SambaNova/
  Inception providers, litert-lm, the embeddings types module, and the
  provider-default-model fixes. This release republishes every package from
  current main (which also includes the 2026-08-26 audit fixes) via the CI
  release workflow, which always builds fresh before publishing.

### Patch Changes

- Updated dependencies
  - @johnhenry/aimatey-errors@0.1.0
  - @johnhenry/aimatey-types@0.1.0
  - @johnhenry/aimatey-utils@0.1.0

> Previously published as `aimatey-frontend`, last unscoped version `0.4.1`.

## 0.4.1

### Patch Changes

- 73aa9f1: Fix broken CJS entry points across the whole package family. Every package declares
  `"type": "module"` for ESM subpath resolution, but shipped `dist/cjs/` builds with no nested
  override - Node walked up to the package root, saw `"type": "module"`, and misinterpreted the
  compiled CommonJS as ESM, so `require("aimatey-x")` failed with `Cannot find module './y.js'`
  on every package in the family (ESM `import` was unaffected). Each package's build now emits a
  `dist/cjs/package.json` containing `{"type":"commonjs"}` (via a new
  `scripts/fix-cjs-package-json.js` post-build step) to correctly scope the CJS build's module
  type. No source or `exports` map changes - verified via `npm pack` + fresh install against the
  exact repro in #23, both direct `require()` and the `require` export condition on subpaths (e.g.
  `aimatey-backend.browser/chrome-ai`).

  (#23)

- Updated dependencies [73aa9f1]
  - aimatey-errors@0.2.1
  - aimatey-types@0.5.1
  - aimatey-utils@0.4.2

## 0.4.0

### Minor Changes

- 7b80cb3: Multimodal attachment content types in the IR: `AudioContent`, `DocumentContent`, and
  `VideoContent` join the `MessageContent` union, with provider mappings for OpenAI
  (`input_audio` for base64 audio; text fallbacks elsewhere), Anthropic (native `document`
  blocks), and Gemini (`inline_data`/`file_data` parts). The Chrome AI backend now supports the
  Chrome 138+ API surface (`create()`/`availability()`/`params()`) alongside the legacy Chrome
  129-137 methods (`createTextSession()`/`capabilities()`), detected at runtime. (#10)

### Patch Changes

- Updated dependencies [7b80cb3]
  - aimatey-types@0.4.0

## 0.3.0

### Minor Changes

- 58ebc03: Streaming tool-call support end-to-end. OpenAI and Anthropic backends now emit `tool_use` IR chunks
  for streamed tool-call deltas (previously dropped with a console warning) and assemble complete
  `ToolUseContent` blocks on the final `done` chunk. The Anthropic backend reports the real
  provider stop reason (previously fabricated, e.g. `max_tokens` streams reported `stop`) and
  captures usage from every `message_delta`. The OpenAI backend folds the trailing
  `stream_options.include_usage` chunk into the done chunk. Frontend adapters re-emit tool deltas in
  native formats (OpenAI index-based `tool_calls` deltas; Anthropic `content_block_start`/
  `input_json_delta` events — the leading text block is now opened lazily so tool-only streams do not
  fabricate an empty text block). `StreamAccumulator` assembles streamed tool calls.

  Note: when tools are streamed, the done chunk's `message.content` is now a structured
  `MessageContent[]` (text + tool_use blocks) rather than a plain string, and finish reasons are now
  truthful (`tool_calls`/`length` where `stop` was previously reported).

- c7693ac: Complete non-streaming tool-calling support. The OpenAI backend now sends `tools`/`tool_choice`,
  converts assistant `tool_use` blocks to `tool_calls`, expands `tool_result` blocks into
  `role: 'tool'` messages, and parses `tool_calls` from responses (malformed arguments degrade to
  `{}`). The Anthropic backend now sends `tools`/`tool_choice`. Frontend adapters accept
  `tools`/`tool_choice` in their native formats and round-trip tool calls and tool results through
  the IR. OpenAI streaming requests now request usage accounting via `stream_options.include_usage`.

### Patch Changes

- e7df1d0: Remove vestigial `aimatey-backend` runtime dependency from `aimatey-frontend` (frontend adapters
  never imported it). Document `StreamToolUseChunk` delta semantics and add an optional `index` field
  identifying the tool call's position within the assistant message.
- Updated dependencies [dae4d01]
- Updated dependencies [e7df1d0]
- Updated dependencies [2912b7d]
- Updated dependencies [78731bb]
- Updated dependencies [b7e2312]
- Updated dependencies [58ebc03]
  - aimatey-types@0.3.0
  - aimatey-utils@0.3.0
