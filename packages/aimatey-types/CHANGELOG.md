# @johnhenry/aimatey-types

## 0.6.0

### Minor Changes

- 22dc8ca: Add a typed-decision capability, sibling to chat and embeddings, plus a backend/frontend adapter pair for TypeSafe's Jev.

  A typed-decision request ("System One" models: TypeSafe's Jev, ConvAI's Laya) sends a state and a set of typed questions (`choice`/`score`/`noul`) and gets back typed answers with calibrated probabilities in a single forward pass -- no generated text, nothing to parse. This is not a chat variant: it has its own IR (`IRDecisionRequest`/`IRDecisionResponse` in `decisions.ts`, mirroring `embeddings.ts`), its own `Bridge.decide()`/`useDecision()` entry point, and its own capability flags (`IRCapabilities.decisions`/`decisionModels`).

  **Breaking-adjacent, but backward compatible for every existing implementer:** `BackendAdapter.fromIR`/`toIR`/`execute`/`executeStream` are now optional. A decision-only backend (like the new `TypeSafeBackendAdapter`) implements only `metadata` and `decide()` -- it is not forced to fake a chat capability it doesn't have. Every existing chat backend still implements all four; nothing changes for it. `Bridge`/`Router`/the SDK wrappers (`packages/wrapper`) and the CLI's `ollama run`/proxy server now check for chat support up front and throw a clear `UNSUPPORTED_FEATURE` error if a decision-only backend is used somewhere that requires chat, instead of a raw "not a function" crash.

  New: `TypeSafeBackendAdapter` (`packages/backend/src/providers/typesafe.ts`) calling Jev's real `/systemone` API, and `TypeSafeFrontendAdapter` (`packages/frontend/src/adapters/typesafe.ts`) translating `@typesafe-ai/sdk`-shaped `systemOne()` calls into the Decision IR -- deliberately not an implementation of the (chat-typed) `FrontendAdapter` interface, since a decision request isn't a chat request in a costume.

### Patch Changes

- 7cc27f9: Add `LayaFrontendAdapter`, translating `Router.predict()`/`Agent.system_one()`-shaped calls (ConvAI's Laya, a self-hosted typed-decision model) into the Decision IR.

  Frontend only, deliberately: Laya has no hosted API today -- confirmed, not assumed (no web-framework dependency in its `pyproject.toml`, and its only running instance is a quota-limited `ZeroGPU` demo Space, not something to build a production backend against). `LayaBackendAdapter` needs a new, separately-hosted Python wrapper service that doesn't exist yet; see `laya.ts`'s module comment for the exact contract that service should expose so the eventual backend adapter can be as thin as `TypeSafeBackendAdapter` is today.

  Along the way: `IRDecisionAnswer`'s `noul` variant gained an optional `confidence` field. Laya reports one (`max(p, 1-p)`); Jev's wire format doesn't -- it's optional rather than absent so a provider that has it isn't forced to throw it away, and `LayaFrontendAdapter` derives it when the upstream response doesn't supply one.

## 0.5.0

### Minor Changes

- c26ae12: Make `Router.isBackendAvailable()` public (#134).

  `isBackendAvailable(name)` was `private` while `isCircuitBreakerOpen(name)` was public, so a
  caller wanting to pre-flight "will this actually go where I asked?" could see the circuit half
  of the predicate but not the health half, and had to approximate the rest:

  ```ts
  // what was reachable                    // what routing actually asks
  !router.isCircuitBreakerOpen(name)       state.isHealthy && state.circuitBreakerState !== 'open'
  ```

  A backend that failed its last health check is unhealthy and will not be routed to even though
  its circuit is closed, so the approximation is wrong in exactly the case a caller cares about.

  The method is now public on the `Router` class and declared on the `Router` interface in
  `@johnhenry/aimatey-types`. Behaviour is unchanged — this only widens visibility.

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

## 0.4.0

### Minor Changes

- f8266bf: Let `IRProvenance` nest, so an adapter that fronts another Router can say what actually
  served the request (#110).

  ## One hop was all it could name

  `IRProvenance` was four flat optional fields -- `frontend`, `backend`, `middleware[]`,
  `router` -- with no slot holding another `IRProvenance`. That is enough for a request that
  begins and ends in one process, and not enough for one that crosses a device boundary.

  When a `BackendAdapter` fronts another aimatey instance -- a tunnel, a gateway, a
  self-hosted relay, two Bridges composed in one app, a test double wrapping a real `Router`
  -- the far side runs its _own_ Router and picks its _own_ backend. For
  `phone -> desktop -> llama-cpp` the phone had two things it could say, and both were wrong:

  | what the phone reports | what is lost                                                 |
  | ---------------------- | ------------------------------------------------------------ |
  | `backend: 'tunnel'`    | `llama-cpp` -- the model that actually ran                   |
  | `backend: 'llama-cpp'` | that another _device_ ran it -- a false claim about this one |

  The second is not merely lossy, it is untrue, and nothing in the type distinguished it from
  a phone that genuinely ran llama-cpp locally.

  ## Why the ambiguity matters

  Provenance is a privacy surface, not telemetry. A UI whose claim is that you are told when
  a reply came from somewhere other than your own device renders a chip from exactly this
  field. "Your own desktop" and "a third-party API" must not render the same -- and a field
  that cannot separate them makes an honest chip impossible to build, however careful the UI
  code is.

  ## What changed
  - **`IRProvenance.upstream?: IRProvenance`** -- provenance reported by the next hop, set
    only when `backend` is itself a proxy. The chain nests to whatever depth the request
    actually travelled.
  - **`withUpstreamProvenance(local, upstream)`**, exported from `@johnhenry/aimatey-types`
    -- attaches a far side beneath a proxy's own hop. It lives in the types package because
    `@johnhenry/aimatey-backend` depends on types and _not_ on core, so a proxying adapter
    can reach it.

  The helper exists to prevent the one-line version of the bug:

  ```ts
  // WRONG -- the far side's backend silently becomes this process's backend.
  metadata: { ...farResponse.metadata }

  // RIGHT -- this adapter names itself, and the far side nests beneath it.
  provenance: withUpstreamProvenance(
    { backend: this.metadata.name },
    farResponse.metadata.provenance
  )
  ```

  An `upstream` that is `undefined`, `{}`, or all-undefined is dropped rather than recorded.
  Adapters that report no provenance conventionally return `{}` rather than `undefined`, and
  an empty link would claim a hop exists while saying nothing about it -- stopping any
  consumer that walks the chain looking for the far end.

  ## The Bridge needed no behaviour change, which is worth stating explicitly

  `enrichResponse()` -> `resolveProvenance()` builds its result with `{ ...provenance, ... }`,
  so an `upstream` written by the backend is already carried through untouched; the bridge
  stamps its own `frontend` over the near hop and overwrites nothing beneath it. The change
  there is a doc comment recording that the spread is load-bearing, plus tests that fail if
  it stops being. A survey of every provenance reader in the monorepo found none that
  rebuilds the object field-by-field, which is the pattern that would have dropped the chain.

  The bridge could not build the chain itself in any case -- only the proxying adapter knows
  it forwarded.

  ## Compatibility

  Purely additive. `upstream` is optional, so every existing value stays valid and every
  existing reader keeps compiling. The four flat fields keep describing the **nearest** hop,
  which is already what their readers mean: `Bridge`'s `backendUsage` counter and its
  circuit-breaker narrowing both key off `provenance.backend` to decide which adapter to stop
  calling, and crediting or blaming a far-side backend this process cannot reach would be
  wrong. A consumer that wants the far end walks `upstream` to the last link.

  The IR stays plain JSON -- `ir.ts` still contains no `AbortSignal`, `Date`, `Map`, `Blob` or
  function type -- so a nested chain survives the wire that a proxy has to cross to produce
  one.

- 07842f9: Make `apiKey` optional on `BackendAdapterConfig`, and required on the adapters that use one (#104).

  ## A required credential with no consumer

  `BackendAdapterConfig.apiKey` was `readonly apiKey: string` -- required. AWS Bedrock
  authenticates with SigV4 from `awsAccessKeyId` / `awsSecretAccessKey` and reads
  `config.apiKey` **zero times**, so every Bedrock user had to invent a dummy string to satisfy
  a field the adapter ignores. Nothing in the type said it was inert, and a required credential
  field invites a caller to put a _real_ secret in it, on the reasonable assumption that it is
  required for a reason.

  ## The survey said Bedrock is not a special case

  The issue offered a contained fix (narrow `apiKey` to `never` on `AWSBedrockConfig`) and a
  real one (make it optional at the base), and said the choice depended on whether other
  adapters had the same shape. Grepping every adapter:

  **Never read `config.apiKey`, yet required one:**

  | adapter                    | config                                                  |
  | -------------------------- | ------------------------------------------------------- |
  | `AWSBedrockBackendAdapter` | `AWSBedrockConfig extends BackendAdapterConfig`         |
  | `OllamaBackendAdapter`     | takes `BackendAdapterConfig` directly                   |
  | model-runner backend       | `ModelRunnerBackendConfig extends BackendAdapterConfig` |

  **Read it only to paper over its inertness:**
  - `lmstudio.ts:68` -- `apiKey: config.apiKey || 'not-needed'`
  - `omniroute.ts:48` -- `apiKey: config.apiKey || 'not-needed'`

  **And a workaround already in the tree:**
  - `NodeLlamaCppConfig extends Partial<BackendAdapterConfig>` -- weakening _every_ field just
    to escape this one.

  Both of the local adapters also had `config: BackendAdapterConfig = {} as BackendAdapterConfig`
  in their factories: a cast that existed only because `{}` was not assignable.

  Three adapters ignoring it, two substituting a placeholder, and one resorting to `Partial<>`
  is not a Bedrock special case. Option 1.

  ## What changed
  - `BackendAdapterConfig.apiKey` is now `readonly apiKey?: string`.
  - New `ApiKeyBackendAdapterConfig = BackendAdapterConfig & { readonly apiKey: string }`,
    exported from `@johnhenry/aimatey-types`.
  - The 26 adapters that genuinely authenticate with a key now take
    `ApiKeyBackendAdapterConfig`, so they still refuse to be constructed without one. This is
    **not** a blanket weakening.
  - Bedrock, Ollama and the model runner keep the base config and no longer demand a key.
  - LM Studio and OmniRoute keep the base config on their _constructors_ -- a caller need not
    supply a key -- and annotate the config they hand to the OpenAI parent as the narrowed type,
    since they fill in `'not-needed'` themselves.
  - DeepSeek requires a key: it is a cloud provider documented as needing `DEEPSEEK_API_KEY`
    and inherits the actual read from `OpenAIBackendAdapter`.

  ## Compatibility

  Passing `apiKey` where it is no longer required is still valid, so existing callers -- including
  everyone currently passing a dummy string to Bedrock -- keep compiling. What changes is that
  `BackendAdapterConfig` is now assignable from objects without `apiKey`, so code that _reads_
  `config.apiKey` off the base type sees `string | undefined` and must narrow. That is the
  breaking edge, and on 0.x it makes this `minor`.

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

## 0.3.0

### Minor Changes

- 3467132: Scope cache entries to a caller, and stop caching requests that name none.

  `createCachingMiddleware`'s default key was a hash of model, messages and parameters, and
  `createEmbeddingCachingMiddleware`'s of input, model and parameters. Neither had any notion
  of who was asking. One process answering for several users therefore had a single cache
  bucket shared by all of them: the second user to send a prompt was handed the first user's
  completion. That is a disclosure bug wearing a performance bug's clothes, and nothing in
  the API made it visible - a caller who configured caching and nothing else got it (#44).

  A `scopeKey` option was added in #45 so a deployment _could_ scope entries by tenant. It
  had to be opted into, which is the wrong way round for this failure mode: the deployment
  that never heard of the option is exactly the one that is leaking.

  **Identity is now a first-class IR field.** `IRMetadata.principal` is an opaque,
  deployment-defined string - a tenant ID, a user ID, an API-key fingerprint, a composite
  like `tenant-7:user-42`. It is compared verbatim, never parsed, and never sent to a
  provider. `Bridge.chat()`, `chatStream()` and `embed()` set it from a typed request option:

  ```typescript
  await bridge.chat(request, { principal: `tenant-${tenantId}:user-${userId}` });
  ```

  It is deliberately not a convention inside `metadata.custom`. `custom` is an unstructured
  bag whose keys mean whatever an application decided they mean, so no middleware can read
  identity out of it safely; scoping that exists to keep users apart needs a field with one
  defined meaning. (The previous documentation suggested `metadata.custom.tenantId`, which
  worked only because you wrote both halves of the convention yourself.)

  **The default is now to cache less.** The cache key mixes in a scope taken from `scopeKey`
  if set, otherwise from `metadata.principal`. A request with neither is not cached at all:
  it goes to the backend, the response comes back with a `cache-bypassed` warning on
  `metadata.warnings` and `metadata.custom.cacheBypassed === true`, and nothing is written.
  Nothing written is nothing that can later be read by the wrong caller.

  The alternative default - keep sharing, and warn - was rejected. The two failure modes are
  not symmetric: defaulting to sharing discloses one user's completion to another and does so
  silently, while defaulting to bypassing costs cache hits until somebody sets one option and
  says so in a warning on every response. The expensive mistake is the recoverable one.

  **Single-tenant deployments say so once.** One process, one audience, every entry safe to
  share - that is why caching was switched on, and it keeps working:

  ```typescript
  bridge.use(createCachingMiddleware({ ttl: 3_600_000, unidentified: 'share' }));
  ```

  `unidentified: 'share'` restores the pre-#44 behaviour for requests that carry no identity.
  Requests that _do_ carry a principal stay scoped to it even in this mode.

  **Existing cache entries survive.** The scope is dropped from the hashed payload when it is
  undefined, so `unidentified: 'share'` produces byte-identical keys to the ones this
  middleware produced before caller scoping existed: an external cache (Redis and friends)
  keeps every entry across the upgrade, and a test pins that. Deployments that adopt
  principals get new keys for newly-scoped requests, which is the point - the old unscoped
  entries are simply never read again rather than being served to somebody they do not belong
  to.

  Nothing here reintroduces a Node-only dependency: keys are still hashed with the pure-JS
  `stableHash` that #48 moved to, so the middleware keeps working in browsers, webviews and
  Electron renderers.

  **Why minor rather than patch.** Two reasons, either of which would be enough. New public
  API is added - `IRMetadata.principal`, `RequestOptions.principal`, `EmbedOptions.principal`,
  `CachingConfig.unidentified`, `EmbeddingCachingConfig.unidentified`, and a `cache-bypassed`
  member on `WarningCategory`. And a deployment that upgrades without reading anything sees
  its cache stop serving hits until it supplies a principal or opts into sharing. That is a
  behaviour change in the safe direction, but it is a behaviour change, and it should not
  arrive in a patch that reads as "no action required".

  A custom `keyGenerator` is unaffected: supplying one still takes over key derivation
  entirely, `scopeKey`, `principal` and `unidentified` are all bypassed, and the generator
  remains responsible for mixing in caller identity itself.

- 681fa2d: Remove the dead `MiddlewareOptions` and `MiddlewareWithMetadata` types (#63).

  Both were exported from `@johnhenry/aimatey-types` and referenced by nothing -
  two declarations, zero uses. All 16 factories in `@johnhenry/aimatey-middleware`
  return plain `Middleware` functions, and no registration path ever accepted a
  metadata wrapper, so neither type was usable even in principle.

  `MiddlewareOptions.supportsStreaming` was the reason to delete rather than keep.
  It read like the switch controlling whether a middleware ran on streaming
  requests - exactly the question #46 was about - while being inert, so it cost
  every reader the time to work out that it did nothing. It was also opt-**in**: a
  middleware would default to _not_ running on streams, which is the bug #46
  fixed, not a design anyone would want now. #50 added a doc comment saying the
  flag was decorative, which patched over the problem rather than resolving it.

  Nothing in the repository referenced either type; the `MiddlewareWithMetadata`
  builder they imply survives only in `specs/001-universal-ai-adapter/contracts/`,
  which declares its own copies and is unaffected. Removing an exported type is
  breaking in the strictest sense, hence `minor` (the breaking-change bump on a 0.x
  package) rather than `patch`.

  The `Middleware` / `StreamingMiddleware` function types and
  `bridge.use()` / `bridge.useStreaming()` are unchanged and remain the whole
  registration surface. `packages/aimatey-types/src/middleware.ts` now carries a
  note in place of the removed block, explaining why there is no metadata wrapper.

- eb8580b: Name middleware, so a failure says which one failed.

  `MiddlewareError.middlewareName` existed, was typed and documented, and never
  held a middleware name. The four sites that set it hardcoded the literal
  `'unknown'`; the two that actually wrap a middleware failure omitted it. A
  stack of eight middleware reported `Middleware execution failed: <message>`
  with no indication of which one broke - the one piece of provenance the wrapper
  exists to add was always either absent or a placeholder.

  The blocker was that `MiddlewareStack` entries carried no name, so naming
  middleware was the prerequisite.

  `use()` and `useStreaming()` - on both `MiddlewareStack` and `Bridge` - now
  take an optional second argument:

  ```ts
  bridge.use(createRetryMiddleware({ maxAttempts: 3 }), { name: 'retry' });
  ```

  and a failure reads:

  ```
  Middleware "retry" failed: connection reset
  ```

  The name is resolved at registration, in order:
  1. `options.name`;
  2. the function's own `.name` - free for `function rateLimit()` and for
     `const rateLimit = async (ctx, next) => ...`, and skipped when it carries no
     information (`middleware`, `handler`, `fn`, …);
  3. the registration position, `middleware[3]`.

  The position is the index across _both_ `use()` and `useStreaming()`, so the
  same middleware is named identically on the streaming and the non-streaming
  path. It is never `'unknown'`: a position is less useful than a name and far
  more useful than nothing. The four lock-guard errors now name the middleware
  being added or removed instead of claiming `'unknown'`, and report no name at
  all when the function is anonymous.

  Every middleware factory in `@johnhenry/aimatey-middleware` ends in
  `return async (context, next) => {…}`, which produces an anonymous function -
  so pass `{ name }` for anything built by one, or it can only be identified by
  position.

  **API addition, fully backward compatible.** The new parameter is optional;
  every existing `use(middleware)` and `useStreaming(middleware)` call keeps
  working unchanged, and `remove()`/`getMiddleware()` identity is unaffected.
  The only observable change is the wording of the failure message, which gained
  the middleware's name.

- e800f3d: Classify `isRetryable` the same way everywhere.

  Four sites decided retryability and they disagreed, so the same fault was
  transient or permanent depending on which path reached it - and `isRetryable`
  is the only thing retry logic keys off.

  **`RouterError` derives `ALL_BACKENDS_FAILED` from its leaves, not from its
  code.** It asserted `isRetryable: options.code === ALL_BACKENDS_FAILED`, so a
  router whose every backend rejected the API key produced a "retryable" error
  and the caller burned its whole retry budget on a fault that was permanent at
  every leaf. `RouterErrorOptions` gains an optional `backendErrors`, and
  retryability is now `true` only when at least one attempted backend failed
  retryably - `some`, not `every`, because retrying helps as soon as one leg
  could succeed. This is the same principle as the `MiddlewareError` fix: a
  composite has no more standing to reclassify its parts than a wrapper has to
  reclassify its cause.

  **The router builds every `ALL_BACKENDS_FAILED` through `RouterError`.** There
  were four construction sites and three answers: `isRetryable: true` in parallel
  dispatch and parallel fallback, `false` on the embeddings and sequential
  fallback paths, none of them going through `RouterError`, which said `true` for
  all of them. All four now go through `RouterError`, which carries the leaf
  errors where they exist and derives one answer from them.

  **Neither retry implementation retries an unclassified error.** `Bridge`'s
  `config.retries` loop treated a non-`AdapterError` as retryable while
  `defaultShouldRetry` in `createRetryMiddleware` did not. `Bridge` now agrees
  with the middleware: an unclassified throwable is as likely a bug in the
  caller's own adapter or middleware as a transient fault, retrying it re-runs
  every middleware side effect for something that cannot succeed, and `Bridge`
  already wrapped such an error as a non-retryable `INTERNAL_ERROR` on the way
  out - so retrying it contradicted the classification it then handed the caller.

  **`408 Request Timeout` and `425 Too Early` are retryable.**
  `createErrorFromHttpResponse` had explicit branches for 401, 403, 429, 400 and
  5xx and fell through to `statusCode >= 500` for everything else, so the two
  statuses whose entire meaning is "try again" were marked permanent. `404`,
  `409` and `422` were checked and stay non-retryable: an identical retry
  reproduces each of them.

  Both flags are read duck-typed rather than through `instanceof AdapterError`,
  so a second copy of the errors package across the ESM/CJS boundary does not
  silently disable retries.

  **Behaviour changes.**
  - A `RouterError` built with `ALL_BACKENDS_FAILED` and no `backendErrors` is
    now non-retryable. If you construct one yourself and want the old answer,
    pass the failures it composes:

    ```ts
    new RouterError({
      code: ErrorCode.ALL_BACKENDS_FAILED,
      message: 'All backends failed',
      attemptedBackends: ['openai', 'anthropic'],
      backendErrors: [openaiError, anthropicError], // <- new
    });
    ```

  - `bridge.chat()` with `config.retries` no longer retries a backend failure
    that is not an `AdapterError` (or does not carry `isRetryable: true`). A
    backend that wants its failures retried should raise a classified error -
    `NetworkError`, `RateLimitError`, or an `AdapterError` with
    `isRetryable: true`.
  - The router's `ALL_BACKENDS_FAILED` errors are now `RouterError` instances
    rather than bare `AdapterError`s. `RouterError extends AdapterError` and the
    `code` is unchanged, so `instanceof AdapterError` and `error.code` checks are
    unaffected; only a check on `error.name === 'AdapterError'` would notice.

- 71e5631: Make `createSecurityMiddleware` actually secure the request (#55).

  `createSecurityMiddleware` computed a `securityHeaders` object, wrote it to
  `request.metadata.custom.securityHeaders`, and returned. Nothing in the
  repository ever read that key - no backend adapter consulted it, and none of the
  24 providers attached it to an outgoing request. Registered on a Bridge, a
  middleware named `createSecurityMiddleware` passed every request through
  untouched: `card 4111 1111 1111 1111` reached the backend verbatim. It made an
  application look protected in code review while doing nothing at runtime.

  **Request protection.** The middleware now sanitizes message content, redacts
  PII, and detects prompt injection _before_ the request reaches the backend, on
  both `chat()` and `chatStream()`:

  ```ts
  bridge.use(createSecurityMiddleware());
  await bridge.chat({ messages: [{ role: 'user', content: 'card 4111 1111 1111 1111' }] });
  // backend receives: "card [REDACTED_CREDITCARD]"
  ```

  New `SecurityConfig` options: `redactPII` (default `true`), `piiPatterns`,
  `promptInjectionAction` (`'warn'` default, or `'block' | 'log' | 'ignore'`),
  `injectionPatterns`, `sanitizeContent` (default `true`), `sanitizer`,
  `logWarnings`. `createProductionSecurityMiddleware` blocks injection attempts;
  `createDevelopmentSecurityMiddleware` warns. The default is `'warn'` rather than
  `'block'` because `DEFAULT_INJECTION_PATTERNS` is deliberately broad - it matches
  the bare word `DAN`, so blocking by default would reject innocent prompts.

  **One PII implementation, not two.** `createSecurityMiddleware` delegates to
  `createValidationMiddleware` rather than reimplementing `detectPII` /
  `redactPII` / `detectPromptInjection` / `sanitizeRequest`. The two middleware
  are now preset vs. knobs: security is a small, safe-by-default, security-only
  surface; validation keeps the full configuration (message and token limits,
  allowed models, moderation callbacks, `piiAction: 'block' | 'warn'`). Security
  deliberately does _not_ inherit validation's data-quality rules - an empty
  message is not a security failure.

  **Redaction is recorded, not silent.** When redaction changes content, a
  `content-redacted` `IRWarning` naming the PII types found is appended to
  `request.metadata.warnings`. `WarningCategory` gains the `'content-redacted'`
  member for it.

  **The header policy.** `Content-Security-Policy`, `Strict-Transport-Security`,
  `X-Frame-Options` and friends are browser _response_ headers; merging them into
  `BackendAdapterConfig.headers` would send them upstream to a provider API, where
  they mean nothing. They are still computed, and now have real consumers:
  - `buildSecurityHeaders(config)` - exported pure function, for
    `createCoreHandler({ bridge, headers: buildSecurityHeaders() })`, which does
    apply them to HTTP responses.
  - `getSecurityHeaders(request)` - exported reader for the metadata key, which is
    still written under `SECURITY_HEADERS_METADATA_KEY` for back-compat.

  Also adds `ValidationConfig.injectionAction` (`'block'` default - existing
  behaviour unchanged - plus `'warn' | 'log' | 'ignore'`), mirroring `piiAction`,
  and `ValidationConfig.logPrefix` so console output names the middleware that
  produced it.

  **Behavioural change.** A `createSecurityMiddleware` that previously passed
  everything through now mutates the request by default. That is why this is a
  `minor` rather than a `patch`: on a 0.x package a minor is the breaking-change
  bump, and this changes what an existing registration does. Pass
  `redactPII: false, sanitizeContent: false, promptInjectionAction: 'ignore'` to
  restore the old pass-through behaviour, though at that point the middleware only
  computes a header policy.

  Tests: 1667 -> 1709 passing; 42 new in `tests/unit/security-middleware.test.ts`,
  including the issue's reproduction on both `chat()` and `chatStream()`, which
  fails against the previous implementation.

### Patch Changes

- 30629d4: Fix `MiddlewareContext.backend` and `.backendName` being documented but never populated.

  Both fields were declared and documented - "backend that will process (or processed) the
  request, available after routing decision" - and were `undefined` on every path, for every
  backend type. The bridge simply never set them.

  The cost is bigger than a missing field: **a middleware could not execute a turn of its
  own**, which rules out the whole class of middleware that needs a second pass - an agentic
  tool loop, retry with a modified request, failover. Middleware written against the
  documented type reads `context.backend` and guards with `if (!backend) …`; through a real
  `Bridge` that guard always fired. One consumer hit exactly this: the tool ran, the model
  never saw the result, and stripping the tool-call syntax left the user with an empty reply.
  Unit tests passed because a hand-built context had `backend` set, which is what the type
  invites. Middleware that merely _branches_ on `backendName` was hit more quietly - it took
  its fallback path every time, with no error.

  `Bridge` now populates both fields on all four paths (`chat`, `chatStream`, `executeIR`,
  `executeIRStream`), through new optional `backend` parameters on `createMiddlewareContext`
  and `createStreamingMiddlewareContext`.

  **Which backend they name.** The fields are seeded before the chain runs and narrowed once
  the routing decision resolves:
  - Before dispatch they are whatever the bridge is about to call. For a router-backed bridge
    that is the router, because the provider genuinely has not been chosen yet - and it is
    the useful value there, since executing through the router routes an extra turn the same
    way the original request was routed.
  - After a response comes back they are narrowed to the backend that actually served it,
    read from the response provenance the backend reports, with `backend` resolved through
    the router's registry so `backendName` always equals `backend.metadata.name`. On the
    streaming path the narrowing happens off the `start` chunk, early enough that the
    response phase of every middleware sees it.

  That is what "available after routing decision" describes, and it means a follow-up turn
  taken after `next()` goes to the backend that just answered - usually what a follow-up
  wants. To re-route deliberately, execute through `bridge.getRouter()` instead. Narrowing is
  driven from the bridge's innermost dispatch, so a middleware that calls `next()` more than
  once sees the value for its most recent dispatch rather than a stale one.

  Predicting the selected backend _before_ dispatch was considered and rejected: `Router`
  has no access to the middleware context (`BackendAdapter.execute()` takes only a request),
  and calling `Router.selectBackend()` up front would advance round-robin and re-roll random
  selection, so the context could name a backend other than the one that answered. Naming
  the router until the answer is known is honest; guessing is not.

  `backend` and `backendName` are no longer `readonly` on `MiddlewareContext`, since they are
  refined in place as the decision resolves. Dropping `readonly` does not affect assignability,
  so no existing implementation of the interface breaks.

  `createFailoverMiddleware()` in `@johnhenry/aimatey-patterns` is **not** affected: it takes
  its fallback adapters through `FailoverConfig.fallbacks` and never reads `context.backend`.
  It was already working, and keeps working.

- 582a4e5: Router: `clone()` keeps translation mappings, stats and circuit-breaker state (#58)

  `Router.clone()` copied `modelMapping`, `modelPatterns` and `fallbackChain` but
  not `modelTranslationMapping` or `backendTranslationMappings` — exactly the
  configuration that makes cross-provider fallback produce a valid request. A
  cloned router would fall back to a backend and send it a model name it had
  never heard of. Both are now copied, as independent maps.

  `clone()` also re-`register`ed each adapter, so every backend started fresh:
  request counts, latency samples and `totalCost` zeroed, and any **open circuit
  breaker silently closed**. Since `clone({ … })` reads like "same router,
  different config", cloning to change one option quietly re-armed a backend the
  breaker had just taken out of rotation.

  A clone is now documented, and implemented, as _this router with different
  settings_. It inherits:
  - **Routing configuration** — backend registrations in the same order, sharing
    the same adapter instances, plus the fallback chain, model mappings, model
    patterns, and the global and per-backend model translation mappings.
  - **Routing state** — the round-robin cursor, so a clone continues the rotation
    rather than restarting it.
  - **Accounting** — router-level and per-backend request counts, latency samples
    and `totalCost`, on the same reasoning as `replace()`: a cumulative record of
    traffic really sent and money really spent, which a configuration change does
    not un-spend.
  - **Health verdict** — `isHealthy`, `lastHealthCheck`, `consecutiveFailures`
    and the circuit-breaker state.

  That last point is where `clone()` deliberately differs from `replace()`, which
  _resets_ the health verdict. Both follow the same underlying rule: a health
  verdict survives exactly as long as the thing it judged. `replace()` swaps in a
  different adapter, so the verdict is stale by construction. `clone()` carries
  the _same adapter instances_ across, so an open circuit is still an accurate
  statement about them — and silently re-arming a backend the breaker had just
  removed, merely because the caller cloned to change an unrelated setting, is
  the more dangerous default.

  One exception: a clone that turns the circuit breaker **off** starts with every
  circuit closed. Nothing in such a router calls the breaker, so an inherited open
  circuit would never move back to half-open and the backend would be unroutable
  forever.

  Callers who want a genuinely fresh slate can follow the clone with
  `resetStats()` and `resetCircuitBreaker()`.

  Tests: `tests/unit/router-clone.test.ts` (16 cases).

## 0.2.0

### Minor Changes

- 213b23e: Make a registered router backend reconfigurable: add `Router.replace()` and stop `unregister()`
  from refusing the default or the last backend.

  There was previously no way to change a backend's configuration once it was registered. The common
  case is a rotated API key: `register()` rejected a name that already existed, and `unregister()`
  refused to remove the default backend or the last remaining one, so both doors were closed at once.
  A single-backend router — the most common shape — was stuck with whatever adapter it was built with.

  **New: `Router.replace(name, adapter)`** (added to the `Router` interface in
  `@johnhenry/aimatey-types` and implemented in `@johnhenry/aimatey-core`)

  ```ts
  router.replace('openai', new OpenAIBackendAdapter({ apiKey: rotatedKey }));
  ```

  Swaps the adapter behind an existing name and keeps everything that refers to that backend _by
  name_: registration order, the fallback chain, model mappings, model patterns, and
  backend-specific translation mappings. An unregister/register round trip loses all of that, which
  is why it is not a substitute.

  `register()` deliberately stays strict rather than becoming an upsert — a duplicate name is almost
  always a double-initialization bug, and silently swapping the adapter would hide it. `replace()`
  correspondingly throws `ROUTING_FAILED` for a name that is _not_ registered; callers who want
  upsert semantics can write `router.has(n) ? router.replace(n, a) : router.register(n, a)`.

  State handling across a `replace()` is split deliberately:
  - **Carried over** — `totalRequests`, `successfulRequests`, `failedRequests`, `latencies`,
    `totalCost`. These are a cumulative accounting record of traffic sent to this logical backend.
    Zeroing `totalCost` on a credential change would silently corrupt spend tracking.
  - **Reset** — `isHealthy`, `circuitBreakerState`, `consecutiveFailures`, `circuitOpenedAt`,
    `lastHealthCheck`. These are a live judgement about a configuration that no longer exists.
    Keeping them would defeat the motivating use case: an expired key trips the circuit breaker, and
    a breaker left open would keep refusing the _new_, working key until `circuitBreakerTimeout`
    elapsed — or fail every request outright if this is the only backend.

  Follow `replace()` with `resetStats()` for a fully clean slate.

  **Changed: `Router.unregister()`**
  - The "cannot unregister last backend" guard is gone. Zero backends is a legitimate transient state
    — it is also the state of a freshly constructed `new Router()`, so the guard was not upholding an
    invariant that otherwise held. An app whose only provider was just disconnected is in exactly that
    state, and it now surfaces as a routing error on the next request rather than as a failure to
    remove the backend.
  - Unregistering the backend named by `config.defaultBackend` no longer throws. `defaultBackend` is
    cleared instead, and a `routing-config-changed` warning is emitted through
    `RouterConfig.onWarning` so the change is not silent.
  - Unregistering now also prunes every routing rule that named the removed backend: fallback-chain
    entries, model mappings, model patterns, and its backend-specific translation mapping. These were
    previously left dangling, violating the invariant that each `setFallbackChain` /
    `setModelMapping` / `setModelPatterns` / `setBackendTranslationMapping` call validates — and a
    later `register()` of a _different_ adapter under the same name silently inherited the removed
    backend's routing rules and translation mappings.
  - Unregistering a name that is not registered still throws `ROUTING_FAILED`.

  **Also new:** the `routing-config-changed` `WarningCategory` in `@johnhenry/aimatey-types`, for
  warnings about the router rewriting its own configuration (there is no request to attach these to,
  so `onWarning` is the only channel).

  Compatibility: removing a thrown error is not a breaking change for correct callers, but code that
  relied on `unregister()` throwing for the default or last backend will now see it succeed. Adding
  `replace()` to the `Router` interface is a breaking change only for third-party classes that
  `implement Router` directly.

### Patch Changes

- 6e79fa1: Fix `RequestOptions.backend` being silently ignored, so a request that explicitly asks for
  one provider is no longer served by another.

  `Router` reads its explicit-routing decision from `request.metadata.custom.backend`, but
  `Bridge.enrichRequest()` only ever merged `options.metadata` into that object - it never
  read `options.backend`. The documented per-request override was therefore inert on every
  path (`chat`, `chatStream`, `executeIR`, `executeIRStream`), while the undocumented
  `metadata.custom.backend` was the only mechanism that actually worked. A request asking
  for `{ backend: 'expensive' }` was answered by the router's `defaultBackend` with no error
  and no warning.

  `enrichRequest()` now folds `options.backend` into `metadata.custom.backend`. It is
  applied after `options.metadata`, so the typed, first-class option is authoritative over
  both a `metadata.custom.backend` already on the request and an untyped `backend` key
  passed through `options.metadata`. Omitting `options.backend` leaves an existing
  `metadata.custom.backend` untouched, so the pre-existing channel keeps working.

  **Unregistered backend names now fail fast.** `Router.selectBackend()` treats an
  unavailable preference as "fall through to strategy selection", which means a typo like
  `{ backend: 'antropic' }` also routed elsewhere in silence. For an explicit override that
  is the wrong behaviour, so the bridge now rejects a name the router has never had
  registered with an `AdapterError` carrying `ErrorCode.ROUTING_FAILED`, before any work is
  done. This is scoped deliberately:
  - Only _unregistered_ names are rejected. A backend that is registered but currently
    unhealthy or has an open circuit breaker is still handled by the router's fallback -
    that is what fallback is for.
  - Only the `options.backend` channel is affected. It was previously inert, so nothing can
    depend on its old behaviour. The lenient `metadata.custom.backend` channel is unchanged,
    to avoid breaking callers that rely on it under a non-`explicit` routing strategy.
  - On a bridge whose backend is a single adapter rather than a router there is no routing
    to override, so the option stays inert rather than throwing.

  Also documents the contract on `RequestOptions.backend`, and adds the previously
  undocumented `options` parameter of `chat()` / `chatStream()` to the Bridge API reference.

- 0ac4957: Fix middleware being silently skipped on every streaming request.

  `MiddlewareStack` kept two separate registries - `middleware` and
  `streamingMiddleware` - and `executeStream()` early-returned the backend stream
  whenever `streamingMiddleware` was empty. `Bridge.use()` only ever wrote to
  `middleware`, and `MiddlewareStack` was `private` on the Bridge, so
  `streamingMiddleware` was _always_ empty through the public API. Every
  middleware registered with `bridge.use()` - retry, caching, logging, telemetry,
  cost tracking, validation, security - ran for `chat()` and did nothing at all
  for `chatStream()`, while `getMiddleware()` kept reporting it as registered. For
  a chat app, where streaming is the normal path, that meant PII redaction and
  prompt-injection detection quietly never ran.

  **`bridge.use()` now runs on both paths.** The stack keeps one ordered
  registry and adapts each `Middleware` onto the stream via a new exported
  `adaptMiddlewareToStreaming()`, preserving the onion shape:
  - the request phase (before `await next()`) runs before the backend is called;
  - chunks pass straight through - no buffering, no added latency;
  - the response phase (after `await next()`) runs once the stream has been
    consumed, against a real `IRChatResponse` assembled from the delivered chunks,
    so logging, telemetry, cost tracking, caching and conversation history see
    genuine content, usage and finish reason rather than a stub.

  **Request rewrites now reach the backend.** `Bridge` called the backend with the
  request it had captured before the chain ran, so a middleware that reassigned
  `context.request` - `createValidationMiddleware`'s PII redaction and
  sanitization, `createTransformMiddleware`, `createSecurityMiddleware`,
  `createConversationHistoryMiddleware` - had its rewrite thrown away on _both_
  paths. `chat()`, `chatStream()`, `executeIR()` and `executeIRStream()` now read
  `context.request` when they call the backend.

  **New: `bridge.useStreaming(mw)`** for stream-native middleware that transforms
  chunks directly, plus `removeStreamingMiddleware()` and
  `getStreamingMiddleware()`. `createStreamingCostTrackingMiddleware()` -
  previously unreachable through `Bridge` at all - can now be registered.
  `use()` and `useStreaming()` registrations interleave in registration order.

  **Documented limitations of the adapted path** (a middleware that needs the
  assembled response cannot behave identically on a stream, and this does not
  pretend otherwise):
  - The chunks have already reached the consumer when the response phase runs, so
    **modifications a middleware makes to the assembled response are dropped**.
    The response is explicitly marked: `metadata.custom.assembledFromStream` is
    `true` and an `info`-severity `capability-unsupported` `IRWarning` states the
    drift. Use `useStreaming()` to change what the consumer sees.
  - Errors thrown _after_ `next()` surface while the consumer iterates the stream,
    not from the `chatStream()` call. Errors thrown _before_ `next()` propagate
    from `chatStream()` exactly as they do from `chat()`.
  - A middleware that short-circuits without calling `next()` (a cache hit) has
    its response replayed as a synthetic stream, with a `capability-unsupported`
    warning on the start chunk noting the chunk boundaries are synthetic.
  - A partially delivered stream cannot be restarted: a second `next()` call
    throws a `MiddlewareError` rather than silently advancing the chain.
  - A consumer that abandons the stream still runs the response phase, with a
    partial response whose `finishReason` is `cancelled`.

  `MiddlewareOptions.supportsStreaming` was left unused. It belongs to a
  `MiddlewareWithMetadata` builder that does not exist anywhere in the repo, and
  it is an opt-_in_ boolean - which would mean middleware defaults to being
  skipped on streams, the very bug being fixed. The opt-in that is actually
  needed is the opposite one, chunk-level control, and the `StreamingMiddleware`
  type plus `useStreaming()` already express it. The field's doc comment now says
  so.

  (#46)

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

> Previously published as `aimatey-types`, last unscoped version `0.5.1`.

## 0.5.1

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

## 0.5.0

### Minor Changes

- b69566f: Add `responseFormat` to the IR request for per-provider structured/schema-constrained
  output. `IRChatRequest.responseFormat` (`{ type: 'json_schema', schema, strict? }`) reuses
  the existing `JSONSchema` type. OpenAI, Anthropic, Gemini, and their OpenAI-compatible
  inheritors (Groq, DeepSeek, Inception, Moonshot, NVIDIA, LM Studio, SambaNova) map it to
  their native structured-output mechanism; all other backends emulate it via prompt
  injection and best-effort JSON extraction. `IRCapabilities.structuredOutput` and
  `response.metadata.custom.responseFormatEnforced` let callers tell which path was used.
  (#16)

## 0.4.0

### Minor Changes

- 7b80cb3: Multimodal attachment content types in the IR: `AudioContent`, `DocumentContent`, and
  `VideoContent` join the `MessageContent` union, with provider mappings for OpenAI
  (`input_audio` for base64 audio; text fallbacks elsewhere), Anthropic (native `document`
  blocks), and Gemini (`inline_data`/`file_data` parts). The Chrome AI backend now supports the
  Chrome 138+ API surface (`create()`/`availability()`/`params()`) alongside the legacy Chrome
  129-137 methods (`createTextSession()`/`capabilities()`), detected at runtime. (#10)

## 0.3.0

### Minor Changes

- dae4d01: Embeddings support: `bridge.embed()` / `router.embed()` with batch chunking, dimension
  normalization, and an embed middleware chain; provider implementations for OpenAI, Mistral,
  Gemini, Cohere, Ollama, Together, Fireworks, DeepInfra, NVIDIA, and LM Studio; caching and
  cost-tracking embedding middleware.
- 2912b7d: Introduce a shared, data-driven model registry in `aimatey-utils` as the single source of truth
  for model metadata (pricing, context windows, capabilities, quality/latency). The registry ships
  with a mid-2026 seed (GPT-5.x/o-series, Claude 4.x, Gemini 2.5/3, Grok, current Mistral/DeepSeek,
  plus embedding models) and is runtime-extensible via `registerModels()` / `overrideModelPricing()`,
  with alias and longest-prefix fallback so new dated snapshots of known families still resolve.

  `aimatey-core`'s model-pricing API is now a thin delegate over the registry (no API break; legacy
  models keep their prices, marked `deprecated`). Capability inference recognizes current families.
  Cost-tracking middleware consults the registry before provider-level defaults. `useTokenCount`
  consults the registry for context windows. Backend default models updated:
  `claude-3-haiku-20240307` → `claude-sonnet-4-5-20250929` (Anthropic), `gpt-3.5-turbo` →
  `gpt-5-mini` (OpenAI) — note this changes behavior for requests that omit a model. `estimateCost()`
  on both backends now prices the actual requested model. Refreshed `deepseek-chat` pricing.

- 78731bb: Router emits `model-substituted` warnings (metadata + new `RouterConfig.onWarning` callback) when
  hybrid translation falls back to a backend default model. http.core gains a framework-agnostic
  `GenericRateLimiter`; `RouteMatcher.match()` accepts any structurally-compatible request.
- b7e2312: Tool-calling helpers (`extractToolCalls`, `createToolResultMessage`, `validateToolArgs`, ...)
  and an agentic loop: `bridge.runTools({ prompt, tools })` executes model-requested tools and
  feeds results back until completion. `bridge.executeIR()` exposes the IR pipeline directly.

### Patch Changes

- e7df1d0: Remove vestigial `aimatey-backend` runtime dependency from `aimatey-frontend` (frontend adapters
  never imported it). Document `StreamToolUseChunk` delta semantics and add an optional `index` field
  identifying the tool call's position within the assistant message.
