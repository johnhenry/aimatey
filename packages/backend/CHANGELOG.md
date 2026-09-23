# @johnhenry/aimatey-backend

## 0.4.0

### Minor Changes

- 22dc8ca: Add a typed-decision capability, sibling to chat and embeddings, plus a backend/frontend adapter pair for TypeSafe's Jev.

  A typed-decision request ("System One" models: TypeSafe's Jev, ConvAI's Laya) sends a state and a set of typed questions (`choice`/`score`/`noul`) and gets back typed answers with calibrated probabilities in a single forward pass -- no generated text, nothing to parse. This is not a chat variant: it has its own IR (`IRDecisionRequest`/`IRDecisionResponse` in `decisions.ts`, mirroring `embeddings.ts`), its own `Bridge.decide()`/`useDecision()` entry point, and its own capability flags (`IRCapabilities.decisions`/`decisionModels`).

  **Breaking-adjacent, but backward compatible for every existing implementer:** `BackendAdapter.fromIR`/`toIR`/`execute`/`executeStream` are now optional. A decision-only backend (like the new `TypeSafeBackendAdapter`) implements only `metadata` and `decide()` -- it is not forced to fake a chat capability it doesn't have. Every existing chat backend still implements all four; nothing changes for it. `Bridge`/`Router`/the SDK wrappers (`packages/wrapper`) and the CLI's `ollama run`/proxy server now check for chat support up front and throw a clear `UNSUPPORTED_FEATURE` error if a decision-only backend is used somewhere that requires chat, instead of a raw "not a function" crash.

  New: `TypeSafeBackendAdapter` (`packages/backend/src/providers/typesafe.ts`) calling Jev's real `/systemone` API, and `TypeSafeFrontendAdapter` (`packages/frontend/src/adapters/typesafe.ts`) translating `@typesafe-ai/sdk`-shaped `systemOne()` calls into the Decision IR -- deliberately not an implementation of the (chat-typed) `FrontendAdapter` interface, since a decision request isn't a chat request in a costume.

### Patch Changes

- Updated dependencies [7cc27f9]
- Updated dependencies [22dc8ca]
  - @johnhenry/aimatey-types@0.6.0
  - @johnhenry/aimatey-utils@0.5.0
  - @johnhenry/aimatey-errors@0.2.3

## 0.3.2

### Patch Changes

- 778276a: Refresh the default OpenAI/Anthropic/Gemini model catalogs and add current-generation Azure OpenAI pricing entries.

  **Retired/retiring model IDs removed from `DEFAULT_OPENAI_MODELS`**: `gpt-4o`, `gpt-4o-mini`,
  `gpt-4-turbo`, `gpt-3.5-turbo` are all on OpenAI's own retirement schedule (some already
  unreachable, the rest by Oct/Dec 2026). Replaced with `gpt-6-astra`, OpenAI's current flagship,
  alongside the existing `gpt-5.6-sol`/`terra`/`luna` tier.

  **`DEFAULT_ANTHROPIC_MODELS` updated to the current lineup**: added `claude-fable-5-1` (current
  top tier), `claude-opus-5`, and `claude-haiku-4-5-20251001` (used elsewhere in this adapter as the
  runtime default, but was missing from this catalog entirely - a real inconsistency). Removed
  confirmed-retired snapshots: `claude-3-5-sonnet-20241022` (retired 2025-10-28),
  `claude-3-5-haiku-20241022` (retired 2026-02-19), `claude-sonnet-4-20250522` and
  `claude-opus-4.1-20250805` (both deprecated/retiring). `claude-opus-4.5-20251124` and
  `claude-sonnet-4.5-20250929` are kept since they're still served, one generation behind current.

  **`DEFAULT_GEMINI_MODELS`**: removed `gemini-2.0-flash`/`gemini-2.0-flash-lite` (shut down
  2026-06-01 per Google's own migration guidance). `gemini-3-pro` renamed to `gemini-3.1-pro`,
  the current agentic/coding flagship. Left `gemini-2.5-flash`/`gemini-2.5-pro` in place -
  Google's own deprecation page has flip-flopped on a 2.5 shutdown date, so removing them now would
  be guessing, not verifying.

  **Azure OpenAI's `estimateCost()` pricing table**: added entries for `gpt-6-astra` and the
  `gpt-5.6-*` family. The existing `gpt-4o`/`gpt-4-turbo`/etc. entries and the `gpt-4o` default
  deployment-name fallback are deliberately left alone - Azure deployment IDs are arbitrary names
  the resource owner chose, not a selectable provider model list, so an older deployment may well
  still be named `gpt-4o` long after OpenAI's own API retires that name (same reasoning already
  documented in the provider-default-model-fixes changeset).

  Not touched: Mistral's default catalog. Research on Mistral's exact current model IDs was
  aggregator-sourced rather than verified against Mistral's own docs, so no changes were made there
  rather than guess.

## 0.3.1

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

## 0.3.0

### Minor Changes

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

### Patch Changes

- 7368d9a: Stop caller-supplied headers overwriting AWS Bedrock's computed SigV4 material (#103).

  ## Auth failed open

  `getHeaders()` ended with:

  ```ts
  return { ...headers, ...this.config.headers };
  ```

  `this.config.headers` was spread **last**, so any caller-supplied header won over the ones
  signing had just computed -- `Authorization`, `X-Amz-Date` and `X-Amz-Security-Token`
  included. A caller who set any of them replaced the SigV4 material _after_ the signature had
  been calculated over the real values. The request then failed with a generic AWS signature
  error that points nowhere near `config.headers`, so the cause was invisible from the call
  site.

  ## Precedence is now explicit

  Lowest to highest:
  1. transport defaults (`Content-Type`, `Accept`)
  2. `config.headers` from the caller
  3. the computed SigV4 material

  ```ts
  return { ...defaultHeaders, ...this.config.headers, ...authHeaders };
  ```

  The auth headers are built into their own object so they can be applied after the caller's,
  rather than being mixed into the defaults before them.

  **Caller headers still beat the transport defaults.** That is deliberate. The reported defect
  is about auth, and demoting `config.headers` beneath _everything_ -- which the minimal
  one-line reversal would have done -- would silently remove `Content-Type` / `Accept`
  overrides that work today and are none of signing's business.

  **When no AWS credentials are configured, nothing changes.** The auth object is empty, so a
  caller supplying their own `Authorization` (a fronting proxy, a sidecar signer) still gets it
  through. There is no signature to protect in that case.

  | config                            | before                           | after                   |
  | --------------------------------- | -------------------------------- | ----------------------- |
  | creds + caller `Authorization`    | caller's wins, AWS rejects it    | computed signature wins |
  | creds + caller `X-Amz-Date`       | caller's wins, signature invalid | computed date wins      |
  | creds + caller `X-Custom-*`       | passed through                   | passed through          |
  | creds + caller `Accept`           | caller's wins                    | caller's wins           |
  | no creds + caller `Authorization` | caller's wins                    | caller's wins           |

  ## Scope

  The signed set remains `host` + `x-amz-date` (+ the session token when present), and caller
  headers are still not part of it. That is legal SigV4 -- you sign what you declare in
  `SignedHeaders` -- and is unchanged here. The defect was the override, not the coverage.

  Header names differing only in case (`authorization` vs `Authorization`) are still not
  normalized; `Record<string, string>` can hold both and `fetch` would collide them on the
  wire. That is a separate surface from the precedence bug fixed here.

  `patch`, not `minor`: the only behaviour that changes is a combination that could not have
  worked -- a caller overriding the signature material while the adapter was signing produced
  an AWS rejection, not a working request.

- Updated dependencies [f8266bf]
- Updated dependencies [07842f9]
- Updated dependencies [9ac5666]
- Updated dependencies [2ef419e]
- Updated dependencies [5596299]
- Updated dependencies [5596299]
  - @johnhenry/aimatey-types@0.4.0
  - @johnhenry/aimatey-utils@0.3.0
  - @johnhenry/aimatey-errors@0.2.1

## 0.2.0

### Minor Changes

- f8df89f: Make AWS Bedrock's SigV4 signing spec-correct and browser-safe (#38).

  Issue #38 reported that the Bedrock adapter's `Authorization` header was a
  placeholder with no computed signature. Real signing landed in #45, so the
  headline defect was already fixed; verifying it turned up two further
  problems, both fixed here and both now pinned by AWS's own published
  `aws-sig-v4-test-suite` vectors (12 cases, copied verbatim from the suite
  rather than generated by this implementation).
  - **Canonical header values were not fully normalized.** SigV4 requires
    leading/trailing whitespace to be trimmed _and_ runs of internal whitespace
    collapsed to a single space; the signer only trimmed. Any signed header
    containing repeated spaces or a folded continuation line therefore produced
    a signature AWS would reject. AWS's `get-header-value-trim` vector
    (`"a   b   c"` must canonicalize to `"a b c"`, collapsing inside quotes too)
    and `get-header-value-multiline` both failed before this change. Bedrock
    itself only signs `host`, `x-amz-date` and `x-amz-security-token`, none of
    which carry such values in practice, so this was a latent defect in the
    exported signer rather than a live Bedrock outage.
  - **The signer imported `node:crypto`.** Because
    `packages/backend/src/index.ts` re-exports the Bedrock provider, that import
    landed in the module graph of _every_ `@johnhenry/aimatey-backend` consumer,
    breaking browser, webview, Capacitor/Electron-renderer and edge bundles
    where bundlers externalize `crypto` and `createHmac` is `undefined` at
    runtime -- the same failure mode as #48. Signing now uses the Web Crypto API
    (`globalThis.crypto.subtle`), available in Node 18+, browsers, Deno, Bun and
    edge runtimes, and raises a clear `ProviderError` where it is absent instead
    of failing obscurely. A test asserts the provider source imports no `node:`
    builtin, so this cannot silently regress.

  **Breaking:** because Web Crypto is async, the exported `signAwsRequestV4()`
  now returns `Promise<SigV4SignResult>` instead of `SigV4SignResult`. It shipped
  synchronously in 0.1.1, so direct callers must add `await`. This is why the
  bump is `minor` rather than `patch`: on a 0.x package `minor` is the breaking
  bump. The adapter's own callers were already `await`-ing `getHeaders()`, so
  adapter behaviour is unchanged apart from the two fixes above. Streaming
  (`/converse-stream`) is signed over its own path, and is covered by a test.

### Patch Changes

- a505d09: Count multi-part message content, and stop re-multiplying a dollar amount, in `estimateCost()` (#40, #41)

  The fixes themselves landed in `eb34ba4` without a changeset, so they would
  have shipped with no version bump and no changelog line despite changing every
  number `estimateCost()` returns. This records them.

  **Multi-part content was priced as if it were empty (#40).** Seventeen provider
  adapters (`ai21`, `anyscale`, `aws-bedrock`, `azure-openai`, `cerebras`,
  `cloudflare`, `cohere`, `deepinfra`, `fireworks`, `inception`, `mistral`,
  `moonshot`, `openrouter`, `perplexity`, `sambanova`, `together-ai`, `xai`)
  counted input tokens with `typeof msg.content === 'string' ? msg.content : ''`.
  Any message whose `content` is an array of blocks — which is every message
  carrying an image, and any message split into multiple text blocks — collapsed
  to the empty string, so its input tokens were counted as zero. The output-token
  half of the estimate was unaffected, so the symptom was not a zero cost but a
  silently _partial_ one: the entire prompt vanished from the bill while the
  completion still showed up.

  ```ts
  const req = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'a'.repeat(1800) },
          { type: 'image', source: { type: 'url', url: '...' } },
        ],
      },
    ],
    parameters: { model: 'jamba-instruct', maxTokens: 1024 },
  };
  await ai21.estimateCost(req);
  // before: 0.0007168  (450 input tokens dropped)
  // after:  0.0009418  (identical to the same text sent as a plain string)
  ```

  All seventeen now route through the existing `estimateTokens()` helper in
  `packages/backend/src/shared.ts`, which already walked structured content
  blocks correctly — the same helper `openai` and `anthropic` were using. No new
  abstraction was introduced: the shared helper predates the bug, and the
  seventeen call sites were simply not using it.

  **Groq and NVIDIA multiplied dollars by a per-token rate (#41).** Both took
  `super.estimateCost()` — `OpenAIBackendAdapter`'s, which returns a **dollar
  amount** — and fed it in as a token count:

  ```ts
  const estimatedInputTokens = (await super.estimateCost(request)) || 0;
  const inputCost = (estimatedInputTokens * 1000 * 0.05) / 1_000_000;
  ```

  A dollars-per-million-tokens rate applied to a dollar figure is dimensionally
  meaningless, and the `* 1000` made it worse rather than cancelling. For a
  450-token prompt Groq reported `$0.1024` against a true `$0.0001249` — 820x
  over. Both adapters now call `estimateTokens(request)` directly, like every
  other adapter, and no longer call `super.estimateCost()` at all.

  Because the unit confusion came from a bare `number` crossing a boundary,
  `shared.ts` already carries the antidote and it is worth preferring at new call
  sites: `estimateCost(inputTokens, outputTokens, rates: CostRates)`, whose
  `CostRates` fields are named `inputPer1M` / `outputPer1M` so the rate's unit is
  visible at the call site rather than implied by a comment.

  Consumers who route on cost are affected beyond the reported number:
  `Router` accrues `estimateCost()` output per backend, so cost-optimised routing
  was choosing between wrong figures — understated for any vision or multi-block
  request, and wildly overstated for Groq.

  Tests: `tests/unit/backend-estimate-cost-multipart.test.ts` (7 cases, including
  a source-level sweep asserting no provider file has regressed to the string-only
  check) and `tests/unit/groq-nvidia-estimate-cost.test.ts` (5 cases). Reverting
  either fix fails 4 and 2 of those respectively.

- 32415cc: Keep Hugging Face's `repetition_penalty` inside its accepted domain (#87).

  `packages/backend/src/providers/huggingface.ts` mapped IR `frequencyPenalty`
  with `frequencyPenalty ? 1 + frequencyPenalty : undefined`, which had two
  defects on one line -- the same falsy-zero class as #42 (Gemini temperature),
  missed by that fix.
  - **`frequencyPenalty: 0` was dropped.** Zero is falsy, so an explicit `0` --
    a valid neutral value, distinct from "unset", and the value used by the IR's
    own documented example -- became `undefined`.
  - **Negatives left the parameter's domain.** Negatives are truthy, so they
    passed the guard and went through `1 + x`: `-1` produced
    `repetition_penalty: 0` and `-2` produced `-1`.

  The second defect was worse than "inaccurate". `repetition_penalty` is a
  strictly positive _multiplicative_ parameter, and Hugging Face enforces that:
  text-generation-inference rejects the request when
  `repetition_penalty <= 0.0` (`ValidationError::RepetitionPenalty`; its OpenAPI
  schema declares `exclusive_minimum = 0.0`), and `transformers`'
  `RepetitionPenaltyLogitsProcessor` raises `` `penalty` has to be a strictly
positive float ``. So any `frequencyPenalty <= -1` produced a request the
  provider refuses outright, not merely a differently-tuned generation.

  **The mapping.** IR `frequencyPenalty` is _additive_ on `-2..2` with neutral
  at `0`; HF `repetition_penalty` is _multiplicative_ on `(0, inf)` with neutral
  at `1.0`, where `> 1` discourages repetition and `0 < p < 1` _encourages_ it.
  The two agree in sense but not in shape, so the fix is not just a corrected
  guard -- `1 + x` is the wrong shape for the negative half, because it walks
  out of the domain at `x = -1`. The new mapping is piecewise and
  reciprocal-symmetric, so `f(-x) === 1 / f(x)`:

  ```text
    x >= 0  ->  1 + x        in [1, 3]
    x <  0  ->  1 / (1 - x)  in [1/3, 1)
  ```

  It is continuous at `0` (both branches give `1`), monotonically increasing
  across the IR range, and strictly positive everywhere, so it needs no clamp to
  an arbitrary epsilon to stay in domain. Reciprocal is also how `transformers`
  itself inverts this parameter (`self.penalty = 1 / penalty`). Positive
  penalties keep their existing `1 + x` wire values, so no currently-accepted
  request changes behaviour.

  **Why the bumps are what they are.** `backend` is `patch`: no request that
  worked before changes its generation. `frequencyPenalty: 0` now sends an
  explicit `1.0` where it previously omitted the field, but `1.0` is exactly
  TGI's documented default for an absent `repetition_penalty`, so the model sees
  the same thing; positives are unchanged; and the only requests whose outcome
  changes are the negative ones, which previously failed validation at the
  provider. `utils` is `minor` because it gains new public API.

  **The shared helper.** The transform lives in
  `packages/aimatey-utils/src/parameter-normalizer.ts` as
  `normalizeRepetitionPenalty()`, exercised directly by unit tests, rather than
  inline in the adapter. It has exactly one caller today and is not expected to
  gain many -- every other provider takes OpenAI-style additive
  `frequency_penalty` straight through. It is shared anyway because that module
  already exports `normalizePenalty()`, whose linear `-2..2 -> {min, max}` remap
  is an active trap for this parameter: it sends neutral `0` to the midpoint of
  the target range rather than to `1.0`, and any target minimum at or below zero
  reproduces exactly the out-of-domain bug being fixed here. A correctly named,
  documented helper sitting beside it is what stops the next adapter author from
  reaching for the wrong one.

- 700469b: Express greedy decoding to Hugging Face the way Hugging Face spells it, instead of
  sending a `temperature` it rejects (#93).

  `packages/backend/src/providers/huggingface.ts` contradicted itself inside a single
  object literal. For `temperature: 0` it computed `do_sample: false` — **correctly**,
  since that is how greedy decoding is expressed for this provider — and then sent
  `temperature: 0` alongside it, which is exactly what the provider rejects. So the IR's
  deterministic setting, and the one callers reach for most deliberately, was the one
  that hard-failed on a provider the library advertises as supported.

  **What text-generation-inference actually does**, read from its source rather than from
  its docs:
  - **`temperature` is validated unconditionally.** `router/src/validation.rs` does
    `let temperature = temperature.unwrap_or(1.0); if temperature <= 0.0 { return
Err(ValidationError::Temperature) }` — "`temperature` must be strictly positive".
    That check runs before and independently of `do_sample`, so `do_sample: false` does
    **not** excuse the zero: the request fails validation in the router and never reaches
    the model. An _omitted_ temperature defaults to `1.0` and passes.
  - **`top_p`/`top_k` are neither rejected nor ignored under `do_sample: false` — they
    override it.** TGI's server picks its decoding strategy in
    `server/text_generation_server/utils/tokens.py`:

    ```python
    has_warpers = (
        (temperature is not None and temperature != 1.0)
        or (top_k is not None and top_k != 0)
        or (top_p is not None and top_p < 1.0)
        or (typical_p is not None and typical_p < 1.0)
    )
    sampling = do_sample or has_warpers
    self.choice = Sampling(seed, device) if sampling else Greedy()
    ```

    `sampling = do_sample or has_warpers`, so any `top_k != 0` or `top_p < 1.0` silently
    _promotes_ the request back to `Sampling()` however explicitly `do_sample: false` was
    set. The batched `HeterogeneousNextTokenChooser` promotes the same way, per request
    (`do_sample = [sample or x != 0 for x, sample in zip(top_k, do_sample)]`). Sending
    them on a greedy request would therefore have defeated the greedy request.

  **The fix.** An explicit `temperature: 0` now omits `temperature`, `top_p` and `top_k`
  together and sends `do_sample: false`. TGI's own defaults for the three absent fields
  (`1.0`, `1.0`, `0`) collapse `has_warpers` to `false`, so `do_sample` is what decides,
  and the request decodes greedily as asked. Greedy decoding is one payload _shape_ for
  this provider, not three independent parameters, which is why the three fields are
  dropped as a unit.

  Only an explicit `temperature: 0` counts as greedy intent. An unset temperature already
  omitted `temperature`, and still forwards `top_p`/`top_k` exactly as before — it is not
  a request to decode greedily, so that path is deliberately untouched.

  **Why `patch`.** This follows #87 (`backend: patch`, "no request that previously worked
  changes behaviour") and #89 (`http: patch` for a code path that had never worked at
  all). The reasoning holds exactly here: every request whose payload changes is one with
  `temperature: 0`, and every such request is refused by TGI's router today with
  `ValidationError::Temperature`, so none of them can be working. Requests with a positive
  temperature, and requests with no temperature at all, are byte-identical on the wire.
  The only outcomes that change are failures becoming successes. Unlike #87 this adds no
  public API, so there is no `utils` bump to go with it.

  **Why the transform stayed in the adapter.** #87 put `normalizeRepetitionPenalty()` in
  `parameter-normalizer.ts` despite having one caller, because the neighbouring
  `normalizePenalty()` was an active trap that would silently reproduce the bug. That
  justification does not transfer. This change is not a value transform that a second
  adapter could reach for wrongly — it is a decision about which keys to omit from a
  text-generation-inference payload, and `huggingface.ts` is the only adapter in the repo
  that emits that `{ inputs, parameters }` envelope. Hoisting a one-provider protocol
  detail into shared utils would invent an abstraction with no second caller and no
  sibling to disambiguate it from, so the logic lives at its one call site with the
  provider behaviour documented beside it.

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

> Previously published as `aimatey-backend`, last unscoped version `0.9.0`.

## 0.9.0

### Minor Changes

- de73756: Fix missing, stale, and non-lite default models across the backend provider adapters.

  **Missing/broken defaults** (adapter had no sensible fallback at all):
  - `NVIDIABackendAdapter` and `LMStudioBackendAdapter` set no `defaultModel`, so an unspecified
    request silently inherited `OpenAIBackendAdapter`'s `gpt-5.6-terra` fallback via subclassing - a
    model neither NVIDIA NIM nor a local LM Studio server serves. Now default to
    `meta/llama-3.1-8b-instruct` and `local-model` respectively.
  - `HuggingFaceBackendAdapter` had no fallback at all (sent an empty model string). Now defaults to
    the ungated `Qwen/Qwen3.5-9B` (Meta's Llama repos require accepting a gated license, which would
    break a default that's supposed to "just work").
  - `OllamaBackendAdapter`'s `fromIR` ignored `config.defaultModel` entirely and always fell back to
    the retired `llama2`. Now respects `config.defaultModel` and falls back to `llama3.2`.

  **Retired model IDs** (still accepted the old default, but the model itself is gone):
  - `AnyscaleBackendAdapter` / `ReplicateBackendAdapter`: Llama 2 (2023) → Llama 3.1/3 8B Instruct.
  - `PerplexityBackendAdapter`: `llama-3.1-sonar-small-128k-online` (retired when Perplexity renamed
    to the plain `sonar` family) → `sonar`.
  - `AWSBedrockBackendAdapter`: `anthropic.claude-3-haiku-20240307-v1:0` (2024) →
    `global.anthropic.claude-haiku-4-5-20251001-v1:0`. The bare Haiku 4.5 model ID 400s on Bedrock
    ("on-demand throughput isn't supported for this model") - it must go through the `global.`
    cross-region inference profile.

  **Mid-tier → lite-tier bumps** (default worked fine, but pointed at the balanced/flagship tier
  instead of the provider's cheaper lite tier - verified live against each platform's current docs
  on 2026-08-01, not assumed):
  - OpenAI: `gpt-5.6-terra` (balanced) → `gpt-5.6-luna` (fast, low-cost tier).
  - Anthropic: `claude-sonnet-5` → `claude-haiku-4-5-20251001` (lightweight tier; also updates the
    `estimateCost()` fallback rate from a Sonnet-tier $3.00/1M to Haiku's actual $1.00/1M).
  - Groq: `llama-3.3-70b-versatile` → `llama-3.1-8b-instant` (Groq's cheapest/fastest tier).
  - DashScope: `qwen3.7-plus` (mid) → `qwen3.7-flash` (budget tier).

  **Deliberately left unchanged** (no reliable lite alternative found):
  - xAI's `grok-4.5` - xAI's own docs describe it as "the most intelligent and fastest model," with
    no distinct cheaper tier confirmed live in the current model lineup.
  - Together AI's `deepseek-ai/DeepSeek-V4-Pro` - `DeepSeek-V4-Flash` exists on other platforms but
    Together AI's own blog still lists it as "coming soon," not yet live there.
  - Azure OpenAI's `gpt-4o` deployment-name guess - Azure deployment IDs are arbitrary names the
    resource owner chose, not a selectable provider model list, so there's no reliable lite
    equivalent to guess at.
  - Mistral, Cohere, AI21, Cerebras, Cloudflare, GitHub Models, OpenRouter, Fireworks, DeepInfra,
    Gemini, Moonshot, DeepSeek, SambaNova, Inception - already default to their smallest documented
    tier.

## 0.8.2

### Patch Changes

- 18abe46: Add `OmniRouteBackendAdapter` for [OmniRoute](https://github.com/diegosouzapw/OmniRoute), a
  self-hosted AI gateway fronting 290+ providers (90+ free) behind one OpenAI-compatible endpoint.
  Extends `OpenAIBackendAdapter` (same pattern as `LMStudioBackendAdapter`), since OmniRoute
  speaks the OpenAI wire format verbatim. Defaults to `http://localhost:20128/v1` and the special
  `auto` model (lets OmniRoute pick a healthy provider from your configured pool); no API key is
  required for local/keyless-free usage. `estimateCost()` returns `null` since the actual routed
  provider/cost isn't knowable from the request alone.

## 0.8.1

### Patch Changes

- 248ce3d: Add two new backend provider adapters:
  - `GitHubModelsBackendAdapter` - GitHub Models, an OpenAI-compatible gateway free to any GitHub
    account (rate limits scale with Copilot subscription tier), fronting models from OpenAI, Meta,
    DeepSeek, Mistral, Microsoft, and Cohere. Defaults to `openai/gpt-4o-mini` (the most generously
    rate-limited tier). `estimateCost()` returns `null` since usage is metered against Copilot rate
    limits, not billed per-token.
  - `DashScopeBackendAdapter` - Alibaba Cloud Model Studio's OpenAI-compatible mode, hosting the
    Qwen model family. Defaults to `qwen3.7-plus` and the international (Singapore)
    `dashscope-intl.aliyuncs.com` endpoint; override `baseURL` for mainland China deployments.
    `estimateCost()` returns `null` - DashScope pricing isn't consistently published across
    regions/models in English-language docs.

  Both follow the same OpenAI-compatible-passthrough pattern as `together-ai`/`fireworks`/
  `openrouter`: `structuredOutput: 'fallback'` and `tools: false` (with a warning) rather than
  claiming native tool-calling support that isn't actually mapped.

## 0.8.0

### Minor Changes

- 5b44733: July 23 2026 provider refresh, plus a real bug fix.

  **Bug fix (Anthropic)**: Claude Opus 4.7+ (including 4.8) and Claude Sonnet 5 return HTTP 400 if
  `temperature`/`top_p`/`top_k` are set to a non-default value. `AnthropicBackendAdapter` now omits
  these params for those models (new exported `supportsSamplingParams()` helper) and surfaces a
  `parameter-unsupported` `IRWarning` instead of forwarding a request that would be rejected.

  **Default model bumps** (all confirmed stale/deprecated against provider docs as of 2026-07-23):
  - OpenAI: `gpt-5-mini` → `gpt-5.6-terra` (the dated `gpt-5-mini-2025-08-07` snapshot is deprecated,
    shuts down 2026-12-11)
  - Anthropic: `claude-sonnet-4-5-20250929` → `claude-sonnet-5` (Anthropic's current default)
  - xAI: `grok-4.3` → `grok-4.5`
  - Moonshot: `moonshot-v1-8k` → `kimi-k3` (2.8T-param flagship, 1,048,576 context, native
    multimodal - `multiModal`/`maxContextTokens` updated accordingly)
  - Gemini: `gemini-2.0-flash-lite` → `gemini-3.6-flash`

  **Aggregator adapter defaults** (OpenRouter, Fireworks, Together AI route to many vendors' models
  rather than owning a single lineage - their defaults were verified directly against each
  platform's live catalog on 2026-07-23, not assumed):
  - OpenRouter: `anthropic/claude-3-haiku` → `anthropic/claude-haiku-4.5` (Claude 3 Haiku is retired
    on Anthropic's own API and EOL on Bedrock 2026-09-10; `anthropic/claude-haiku-4.5` confirmed
    live via OpenRouter's public `/api/v1/models` endpoint, pricing matches Anthropic's own rate
    exactly)
  - Fireworks AI: `accounts/fireworks/models/llama-v3p1-8b-instruct` →
    `accounts/fireworks/models/deepseek-v4-flash` (confirmed listed on fireworks.ai/models);
    `maxContextTokens` raised 128000 → 1000000 to match
  - Together AI: `meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo` → `deepseek-ai/DeepSeek-V4-Pro`
    (confirmed listed on together.ai/models); `maxContextTokens` raised 128000 → 1000000 to match

  **Registry additions** (`aimatey-utils`'s `MODEL_REGISTRY_SEED`): `gpt-5.6-sol/terra/luna`
  (marking the deprecated dated GPT-5/o3 snapshots - `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `o3` -
  `deprecated: true`), `claude-opus-4-8`, `claude-fable-5`, `grok-4.5`, `gemini-3.6-flash`,
  `gemini-3.5-flash-lite`, and a new Moonshot AI section (`kimi-k3`, pricing confirmed via
  OpenRouter's live catalog). Some pricing figures for other brand-new SKUs (Gemini 3.6
  Flash/3.5 Flash-Lite, Grok 4.5, Fable 5, Opus 4.8) are estimates flagged in code comments, not
  independently confirmed - override via `registerModels()` if you have exact numbers.

  **Capability inference** (`aimatey-core`): adds a `moonshot` family (`kimi`/`moonshot` name
  matching) so Kimi K3 and future Moonshot models get sensible capability defaults instead of
  falling through to nothing.

  **Known gaps, not addressed by this refresh** (see the research thread for detail): whether any
  new inference-speed/open-weight/regional LLM providers outside aimatey's current 24 are worth
  adding, and the state of MCP/agent-interop/computer-use/prompt-caching/batch-API standardization
  across providers - both remain open follow-up research, not confirmed non-issues.

### Patch Changes

- Updated dependencies [5b44733]
  - aimatey-utils@0.5.0

## 0.7.2

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

## 0.7.1

### Patch Changes

- f460203: Fix two backend adapter bugs:
  - `OpenAIBackendAdapter` now sends `max_completion_tokens` instead of `max_tokens` for
    gpt-5.x and o1/o3/o4 reasoning-model families, which reject `max_tokens` outright. (#19)
  - 10 adapters (Azure OpenAI, Cerebras, Cloudflare, DeepInfra, Fireworks, Gemini, Mistral,
    OpenRouter, Together AI, xAI) previously advertised `capabilities.tools: true` while
    silently dropping any `request.tools`/`toolChoice` - they now correctly report
    `tools: false` and surface a `tool-unsupported` `IRWarning` instead of silent data loss.
    Full native tool-calling support for these adapters remains a follow-up. (#17)

## 0.7.0

### Minor Changes

- b69566f: Add `responseFormat` to the IR request for per-provider structured/schema-constrained
  output. `IRChatRequest.responseFormat` (`{ type: 'json_schema', schema, strict? }`) reuses
  the existing `JSONSchema` type. OpenAI, Anthropic, Gemini, and their OpenAI-compatible
  inheritors (Groq, DeepSeek, Inception, Moonshot, NVIDIA, LM Studio, SambaNova) map it to
  their native structured-output mechanism; all other backends emulate it via prompt
  injection and best-effort JSON extraction. `IRCapabilities.structuredOutput` and
  `response.metadata.custom.responseFormatEnforced` let callers tell which path was used.
  (#16)

### Patch Changes

- Updated dependencies [b69566f]
  - aimatey-types@0.5.0

## 0.6.0

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

## 0.5.0

### Minor Changes

- Three new backend adapters: Inception Labs (`InceptionBackendAdapter`), Moonshot AI
  (`MoonshotBackendAdapter`), and SambaNova (`SambaNovaBackendAdapter`), all OpenAI-compatible with
  subpath exports (`aimatey-backend/inception`, `/moonshot`, `/sambanova`). (#12) These adapters do
  not advertise embeddings support (`capabilities.embeddings: false`) since their embeddings
  endpoints are absent or unverified.

## 0.4.0

### Minor Changes

- d9e1489: July 2026 provider refresh. DeepSeek: V4 generation (`deepseek-v4-flash`/`deepseek-v4-pro`, 1M
  context, 384K output) with image input enabled — the adapter now advertises `multiModal` and
  defaults to `deepseek-v4-flash`; `deepseek-chat`/`deepseek-reasoner` marked deprecated (provider
  retires them 2026-07-24). Registry adds `claude-sonnet-5` (1M context), `gemini-3.5-flash`,
  `gemini-3.1-pro-preview`, `grok-4.3`, `grok-4.20` variants, and `grok-build-0.1`; capability
  inference recognizes the claude-5 and deepseek-v4 families; xAI default model updated off the
  retired `grok-beta`.

### Patch Changes

- Updated dependencies [d9e1489]
  - aimatey-utils@0.4.0

## 0.3.0

### Minor Changes

- dae4d01: Embeddings support: `bridge.embed()` / `router.embed()` with batch chunking, dimension
  normalization, and an embed middleware chain; provider implementations for OpenAI, Mistral,
  Gemini, Cohere, Ollama, Together, Fireworks, DeepInfra, NVIDIA, and LM Studio; caching and
  cost-tracking embedding middleware.
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

- Updated dependencies [dae4d01]
- Updated dependencies [e7df1d0]
- Updated dependencies [2912b7d]
- Updated dependencies [78731bb]
- Updated dependencies [b7e2312]
- Updated dependencies [58ebc03]
  - aimatey-types@0.3.0
  - aimatey-utils@0.3.0

## 0.2.1

### Patch Changes

- Fix default models for Anthropic and Groq backends
  - Changed Anthropic default model from claude-3-5-sonnet-20241022 to claude-3-haiku-20240307 (more widely available)
  - Added Groq default model llama-3.3-70b-versatile (was inheriting invalid gpt-3.5-turbo)

  These changes fix backend failures when model is not explicitly specified.
