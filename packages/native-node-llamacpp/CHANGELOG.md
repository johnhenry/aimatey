# @johnhenry/aimatey-native-node-llamacpp

## 0.1.5

### Patch Changes

- Updated dependencies [7cc27f9]
- Updated dependencies [22dc8ca]
  - @johnhenry/aimatey-types@0.6.0
  - @johnhenry/aimatey-utils@0.5.0
  - @johnhenry/aimatey-errors@0.2.3

## 0.1.4

### Patch Changes

- 305af90: Give `sequence` a contract and make every adapter keep it, and let a warning say the
  delivery was degraded rather than the translation (#120, #123, #131).

  ## `sequence` had no contract, and 27 adapters broke the one it turned out to have

  `BaseStreamChunk.sequence` shipped with no doc comment at all. Nothing said whether it
  starts at 0, whether it increments by one, whether a `metadata` chunk between two `content`
  chunks consumes a number, or what a consumer should do on a gap. In-process none of that
  matters: an async generator cannot drop or reorder its own yields, so the field is
  decoration. Across a wire it is the only loss-detection primitive the IR has, and a gap can
  only mean loss if a gap is illegal.

  It is now documented as **monotonic and contiguous from 0, across all chunk types of one
  stream**. That is not a new rule -- it is the rule `validateChunkSequence()` and
  `validateStream()` in `@johnhenry/aimatey-utils` have always enforced. It was simply never
  written down, so nothing checked that the library's own adapters obeyed it.

  They did not. Every streaming adapter emitted its terminal `error` chunk from a `catch` that
  could not see the counter, so it hardcoded `sequence: 0`:

  ```ts
  } catch (error) {
    yield { type: 'error', sequence: 0, ... };   // after 40 content chunks
  }
  ```

  A provider failing part-way through a generation therefore produced `0, 1, 2, … 40, 0` --
  a duplicate and a decrease in the one place a consumer most needs to trust the numbering.
  Passed through this repo's own strict `validateStream()`, that stream throws
  `Out-of-order chunk: sequence 0 after 41`, replacing the provider's real error with a
  validator artefact. A consumer using `sequence` to detect a severed connection sees a reset
  instead.

  Fixed in all 27 emitters -- 22 HTTP providers, `chrome-ai`, `litert-lm`, `native-apple`,
  `native-model-runner` and `native-node-llamacpp` -- by hoisting the counter above the `try`.
  `native-model-runner`, which delegates with `yield*`, now tracks the delegated stream's
  numbering so its own terminal chunk continues it.

  `Router.executeStream` had the same fault twice over. Its synthesized error chunk was
  numbered 0 after it had already delivered a committed stream's chunks; and a _backend's_
  error chunk was forwarded with the number the backend gave it, even though the router may
  have withheld that backend's preamble or failed over from it -- opening a stream at
  `sequence: 3` with nothing before it. The terminal chunk is now renumbered onto the stream
  the consumer actually received.

  ## `WarningCategory` could not say a turn was served badly

  All thirteen existing members describe a **translation** problem: a parameter normalized or
  clamped, a capability missing, content redacted, a model substituted. Coherent, and with no
  room for a turn that was translated faithfully and then _delivered_ badly. The only thing to
  reach for was `capability-unsupported`, which says the backend could not do what was asked
  -- a different claim, and one that stops carrying information after a few stretches.

  Three additive members, and a factory for each in `@johnhenry/aimatey-utils`:
  - **`request-queued`** -- a store-and-forward transport held the request and ran it later.
    `createRequestQueuedWarning(queuedMs, source)`; the wait goes in `details`, because a
    caller that has already shown a spinner needs the elapsed time and not just the fact.
  - **`transport-degraded`** -- the link degraded the turn: a stream that reconnected
    mid-response, a re-send after a transport failure, a hop an order of magnitude slower than
    the same request served locally. `createTransportDegradedWarning(reason, { details, source })`.
  - **`provenance-lost`** -- a response arrived where the receiver had reason to expect
    `IRMetadata.provenance` and there was none. `createProvenanceLostWarning(expectedFrom, source)`.

  The last one closes a gap that only exists across a wire. `provenance` is optional, so
  `undefined` means both "the chain recorded nothing" and "the chain recorded something and
  the trip ate it" -- dropped by a transport, a re-serialization, or a hop that rebuilt
  `metadata` without spreading the old one. In one process the second never happens; across a
  boundary it is the difference between "we do not know where this ran" and "something ate the
  answer", and an application whose rule is that unknown provenance renders as _no_ trust label
  needs "unknown" to stay rare and honest.

  It is the **receiving hop's claim about what it expected**, never an inference by a walker
  and never attached by an adapter that had no such expectation -- so an absent provenance
  carrying no `provenance-lost` warning still means "not recorded", exactly as before.

  Adding members to a union is additive for producers. Consumers that switch exhaustively on
  `WarningCategory` will need the usual new-member arms.

- Updated dependencies [c26ae12]
- Updated dependencies [305af90]
  - @johnhenry/aimatey-types@0.5.0
  - @johnhenry/aimatey-utils@0.4.0
  - @johnhenry/aimatey-errors@0.2.2

## 0.1.3

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

> Previously published as `aimatey-native.node-llamacpp`, last unscoped version `0.2.2`.

## 0.2.2

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

## 0.2.1

### Patch Changes

- New LiteRT-LM backend adapter: run Gemma on-device in the browser via WebGPU
  (`@litert-lm/core`, optional peer). Streaming-native with engine caching per model URL,
  AbortSignal cancellation, and semantic-drift warnings for the Web SDK's dropped features
  (sampler params, tools, non-text content). Registry entries for Gemma-4 E2B/E4B. Also:
  node-llama-cpp is now properly declared as an optional peer dependency of
  aimatey-native.node-llamacpp.
- Updated dependencies
  - aimatey-utils@0.4.1
