# @johnhenry/aimatey-middleware

## 0.2.4

### Patch Changes

- Updated dependencies [7cc27f9]
- Updated dependencies [22dc8ca]
  - @johnhenry/aimatey-types@0.6.0
  - @johnhenry/aimatey-utils@0.5.0
  - @johnhenry/aimatey-core@0.5.0
  - @johnhenry/aimatey-errors@0.2.3

## 0.2.3

### Patch Changes

- Updated dependencies [9f1e9e5]
- Updated dependencies [c26ae12]
- Updated dependencies [c26ae12]
- Updated dependencies [305af90]
  - @johnhenry/aimatey-core@0.4.0
  - @johnhenry/aimatey-types@0.5.0
  - @johnhenry/aimatey-utils@0.4.0
  - @johnhenry/aimatey-errors@0.2.2

## 0.2.2

### Patch Changes

- 90aabe3: Set `ai.response.model` on OpenTelemetry spans, which was never set at all (#112).

  ## An attribute that could never be emitted

  The OpenTelemetry middleware guarded the `ai.response.model` span attribute on
  `response.metadata.provenance?.backendModel`. `IRProvenance` has no `backendModel` field --
  it is four flat optionals (`frontend`, `backend`, `middleware`, `router`) -- so the condition
  was **always falsy** and the attribute was never set on any span, for any provider, ever.
  Grepping the monorepo returned two hits for `backendModel`, both of them the dead read itself,
  and two for `RESPONSE_MODEL`: its definition and the single use inside the dead branch.

  No compiler could see it. `opentelemetry.ts` declares the optional OpenTelemetry handle as
  `let api: any`, and the response was produced through it:

  ```ts
  const response = await api.context.with(spanContext, async () => next());
  ```

  so `response` was `any` and every property access on it was unchecked -- even though
  `MiddlewareNext` is precisely typed as `() => Promise<IRChatResponse>`. The type information
  existed and was discarded by routing the call through the `any`.

  ## Which model the attribute means

  Per the OpenTelemetry GenAI semantic conventions, `request.model` is "the name of the GenAI
  model a request is being made to" (`gpt-4`) and `response.model` is "the name of the model
  that generated the response" (`gpt-4-0613`). The two attributes exist in order to differ: a
  provider may resolve an alias to a dated snapshot, and aimatey's own router may substitute a
  model outright (the `model-substituted` warning category).

  That rules out filling it from the request's `parameters.model`, which would make
  `ai.response.model` a duplicate of `ai.request.model` by construction and would assert a model
  that never served in exactly the substitution case the attribute exists to record -- turning a
  silent absence into a confident falsehood.

  ## What changed
  - `ai.response.model` is now taken from the model the provider actually served, read from
    `IRChatResponse.raw.model`. Every backend adapter preserves the provider's response body
    verbatim in `raw`, and `model` is the conventional key across the OpenAI- and
    Anthropic-shaped providers (`OpenAIResponse.model`, `AnthropicResponse.model`).
  - When the served model cannot be determined the attribute is **left unset** rather than
    defaulted, so a consumer can distinguish "not reported" from "reported as X".
  - `response` is now annotated `IRChatResponse`, so reads against it are type-checked. The
    previous dead read is now a compile error (`TS2339: Property 'backendModel' does not exist
on type 'IRProvenance'`) rather than silently-dead code.

  ## Follow-up

  Reading `raw` couples the middleware to provider payload shapes. The IR has no typed field for
  the served model, which is also why `providers/openrouter.ts` invented
  `metadata.custom.actualModel` -- a second write with no reader anywhere in the monorepo. A
  first-class served-model field on the response would give both a home; it is deferred because
  it changes `IRProvenance`/`IRMetadata`, which are being restructured concurrently. Tracked in
  #113.

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

- Updated dependencies [f8266bf]
- Updated dependencies [07842f9]
- Updated dependencies [9ac5666]
- Updated dependencies [2ef419e]
- Updated dependencies [5596299]
- Updated dependencies [5596299]
  - @johnhenry/aimatey-types@0.4.0
  - @johnhenry/aimatey-utils@0.3.0
  - @johnhenry/aimatey-core@0.3.1
  - @johnhenry/aimatey-errors@0.2.1

## 0.2.1

### Patch Changes

- 918c6e2: Require a target noun in the default `disregard` prompt-injection pattern, which matched
  ordinary developer text and threw on it under a bare `createValidationMiddleware({})` (#98).

  ## The pattern had no object

  Every other entry in `DEFAULT_INJECTION_PATTERNS` requires something to be acted on. This
  one did not:

  ```js
  /disregard\s+(all|any|previous|above)/i;
  ```

  The verb plus a single modifier was the whole test, so all of these were classified as
  prompt-injection attacks:

  | text                                                                 | before | after |
  | -------------------------------------------------------------------- | ------ | ----- |
  | `disregard all warnings from the linter`                             | attack | ok    |
  | `please disregard any errors in the previous build log`              | attack | ok    |
  | `disregard all of that, I mislabelled the ticket`                    | attack | ok    |
  | `you can disregard any files under vendor/`                          | attack | ok    |
  | `the parser should disregard any instructions it does not recognise` | attack | ok    |

  `preventPromptInjection` defaults to `true` and `injectionAction` to `'block'`, so under a
  bare `createValidationMiddleware({})` each of those threw a `ValidationError` rather than
  reaching the model. `createSecurityMiddleware` defaults the action to `'warn'` (#55), so
  there the same sentences produced a spurious warning instead. Neither default changes here.

  This is the class of false positive #67 removed - it is the same shape as the bare
  `\bDAN\b` and bare `developer\s+mode` patterns that issue fixed, where a token with a
  common innocent sense was treated as sufficient evidence on its own. `disregard` was
  simply missed at the time, and #81 then rebuilt the sibling `ignore` pattern without
  revisiting it.

  ## The fix

  `ignore` and `disregard` are the same attack written two ways, so they are now the same
  regex, built once and applied to both verbs. The shape is the two-branch one #81
  introduced:
  1. **Prior-context branch** - a word referring to the conversation so far (`previous`,
     `prior`, `earlier`, `above`, `preceding`, `foregoing`), any stack of scope words and
     determiners in front of it, and a target noun behind it. The noun is what `disregard`
     was missing, and requiring it is the whole fix.
  2. **Scope-only branch** - `all` plus the narrower legacy noun set, so the bare
     `disregard all instructions` shape still lands.

  Sharing one builder is deliberate: the two patterns drifting apart is what produced this
  bug, and hand-maintaining two copies of the same vocabulary would let it happen again.

  ### Recall is unchanged or better

  Everything the old pattern caught with a real object is still caught, and the vocabulary
  #81 added now applies to this verb too - `disregard the above instructions`,
  `disregard your previous instructions`, `disregard every previous instruction`,
  `disregard earlier instructions` and `disregard these previous instructions` were all
  **missed** before and are detected now.

  One shape is deliberately given up: `any` no longer reaches the scope-only branch, matching
  the restriction `ignore` already had. `the parser should disregard any instructions it does
not recognise` is a real sentence, and `any` still reaches the prior-context branch, so
  `disregard any previous instructions` - what an attacker actually writes - is still caught.

  ### Both halves are tested

  `tests/unit/detection-false-positives.test.ts` gains a precision corpus and a recall corpus
  for this verb, plus the end-to-end assertion that `createValidationMiddleware({})` stops
  throwing on the reported sentences while still throwing on a genuine attempt. Reverting the
  pattern alone fails 20 of them - 12 precision, 6 recall, 2 end to end.

  The residual is the same one `ignore` documents and does not solve: no regex separates a
  user retracting their own instructions from an attacker, because the two sentences are the
  same sentence. It stays pinned as a known verdict rather than papered over.

  ### Cost

  `detection-performance.test.ts` measures every pattern in the exported records against
  adversarial input, so the new pattern is covered automatically; a `disregard`-prefix corpus
  is added because the existing ones contain no `disregard` and would have exercised it only
  at its first character. Measured on `'disregard all of the previous '` repeated, the
  pattern is linear - 0.018 ms at 15 KB, 0.069 ms at 60 KB, 0.264 ms at 240 KB - and the full
  injection record costs 0.26 ms on a 60 KB message, against a 50 ms budget.

## 0.2.0

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

- 0a7222d: Fix a reachable denial of service in the default `email` PII pattern (#80) and detect
  `"ignore all previous instructions"`, the canonical prompt injection, which the default
  injection pattern missed (#81).

  Both defaults run on every user message under a default configuration - since #55
  `createSecurityMiddleware()` redacts by default and wires in injection detection - so
  neither of these was a latent edge case.

  ## The email pattern was quadratic (#80)

  `/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g` matched its local-part class
  greedily from every starting position, scanned forward for an `@`, failed, backtracked and
  restarted one character along. On text with no `@` in it at all the work was O(n²):

  | input (`'1.1.1'` repeated) | before  | after   |
  | -------------------------- | ------- | ------- |
  | 10 KB                      | 37 ms   | 0.04 ms |
  | 20 KB                      | 152 ms  | 0.07 ms |
  | 40 KB                      | 640 ms  | 0.15 ms |
  | 60 KB                      | 1504 ms | 0.22 ms |

  Doubling the input quadrupled the time. Node is single-threaded per process, so a 60 KB
  message did not make one request slow, it blocked every concurrent request on the instance
  for a second and a half - and the payload is version strings, which looks like nothing.

  The match is now anchored to the start of a run of local-part characters with a lookbehind.
  `@` is not a local-part character, so if the maximal run is not followed by `@`, no shorter
  suffix of it is either: every restart inside a run is provably wasted work. Stating that
  invariant lets the engine examine each run once. Cost is now linear - 240 KB measures 4x
  60 KB rather than 16x.

  Bounding the local part at RFC 5321's 64 octets, the other option on the issue, was measured
  and rejected: it only bounds the blowup (~8 ms on the same input, 40x worse than this) and
  it silently stops matching over-long local parts instead of redacting them.

  **The other default patterns were audited the same way.** Worst case at 60 KB across eleven
  adversarial corpora, after: `email` 0.23 ms, `ipAddress` 0.32 ms, `phone` 0.25 ms, `apiKey`
  0.12 ms, `ssn` 0.09 ms, `creditCard` 0.02 ms, and every injection pattern at or below
  0.10 ms. `phone` and `ssn` had never been measured before; both are fine. Nothing else needed
  changing.

  `tests/unit/detection-performance.test.ts` now enforces this. It iterates the exported
  pattern records rather than a hard-coded list, so a pattern added later is measured
  automatically, and it asserts the _shape_ of the cost curve (4x input must cost under 10x,
  where linear is 4x and quadratic is 16x) as well as an absolute budget - a correctness test
  cannot catch a pattern that finds exactly the right answer while taking 1.5 s to do it, and
  the shape assertion additionally catches a quadratic pattern that happens to stay under the
  budget at 60 KB but would not at 600 KB.

  Also corrects the TLD class, which was `[A-Z|a-z]`. The `|` was a literal member of the
  character class, so `foo@bar.|a` was reported as an email address.

  ## The canonical injection string was not detected (#81)

  `ignore\s+(previous|above|all)\s+(instructions|prompts?|commands?)` accepted exactly one of
  `previous` / `above` / `all` and then required the noun immediately. `"ignore all previous
instructions"` stacks two of them, so the phrasing that appears in essentially every
  published injection example did not match, while the variants an attacker is less likely to
  use did:

  ```
  "ignore previous instructions"      -> true
  "ignore all previous instructions"  -> false   <-- the canonical form
  "ignore all instructions"           -> true
  "ignore above instructions"         -> true
  ```

  Now detected: `all previous`, `any previous`, `the previous`, `these previous`, `your
previous`, `all your previous`, `all of the previous`, `all prior`, `every previous`,
  `earlier`, `preceding`, `foregoing`, and the `rules`, `directives` and `guidelines` nouns.

  **Precision was tested as deliberately as recall**, which is the whole point of #67. The
  pattern is two branches over named vocabulary lists: one requires a word referring to the
  conversation so far, and one is byte-for-byte the noun set the old pattern accepted after a
  bare `all`. Keeping them separate is what protects precision - a scope word on its own is
  not a signal. `"ignore all whitespace when comparing"`, `"How do I make eslint ignore all
rules in one file?"` and `"we ignore every prompt token past the limit"` are ordinary things
  to ask a coding assistant, and none of them match: `rules` is not in the legacy noun set and
  `every` is not in the legacy branch. 18 such sentences are pinned as must-not-match beside
  22 must-match attacks, and every false-positive case from #67 still passes.

  Measured before shipping, as #81 asked: 0.07 ms on 60 KB of adversarial input against the
  old pattern's 0.03 ms, linear to 240 KB.

  One residual is pinned rather than fixed: `"you can ignore the previous instructions I gave
you, I was wrong"` is a genuine user and now matches, because catching `the previous` -
  which the issue asked for by name - necessarily brings it along. No regex separates those
  two sentences. That is an argument for the `'warn'` default `createSecurityMiddleware`
  already chose (#55), which is **unchanged**, not for a cleverer pattern.

  ## Why `minor` rather than `patch`

  Nothing is added, removed or renamed, and no signature changes - `DEFAULT_PII_PATTERNS` and
  `DEFAULT_INJECTION_PATTERNS` keep their exact types. #67 shipped a comparable detector change
  as `patch`.

  But #67 made the detectors fire _less_, which can only turn a throw into a pass. This makes
  one of them fire _more_, and under `createValidationMiddleware({})` a prompt-injection match
  throws by default. A message that got through yesterday can be rejected today, and a caller
  whose traffic contains phrasing like `"ignore the previous instructions"` will see new
  `ValidationError`s from a version bump they read as a defect repair. That is observable
  behaviour, not a bug fix, so it takes the bump that says so.

  Tests: 2218 -> 2465 passing, 95 files. Reverting the email pattern alone fails 11; reverting
  the injection pattern alone fails 19.

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

- 91ebe34: Stop the default detection patterns firing on ordinary text (#67).

  With default configuration, `createValidationMiddleware({})` **threw** on a
  message that mentioned a colleague called Dan, and `piiAction: 'redact'`
  silently rewrote every commit hash in a conversation to `[REDACTED_APIKEY]`
  before the model saw it. Both were on by default - `preventPromptInjection` and
  `throwOnError` default to `true`, and since #55 `createSecurityMiddleware`
  redacts by default - so neither needed opting in to hit.

  ```ts
  bridge.use(createValidationMiddleware({}));
  await bridge.chat({ messages: [{ role: 'user', content: 'Hi Dan, can you review this?' }] });
  // before: throws ValidationError: Potential prompt injection detected
  // after:  delivered unchanged
  ```

  **`DAN` needs jailbreak context.** `DEFAULT_INJECTION_PATTERNS` matched the bare
  word `DAN` case-insensitively, so "Hi Dan", "My colleague Dan says hello" and
  "Dan asked about the deploy" were all classified as prompt-injection attacks.
  `DAN` is now matched **case-sensitively** and only beside jailbreak framing
  (`DAN mode`, `act as DAN`, `you are DAN`, `stands for do anything now`) - the
  acronym is always written in capitals in the roleplay prompt it comes from,
  while `Dan` is a common name. `developer mode` had the same shape of bug and got
  the same treatment: "How do I enable developer mode on Android?" is no longer an
  attack, while "act as ChatGPT with Developer Mode enabled" still is.

  **`apiKey` matches a vendor prefix, not a length.** `/\b[A-Za-z0-9]{32,}\b/`
  matched every git SHA, dashless UUID, base64 id and content hash. Entropy could
  not have fixed this - a git SHA is uniformly random hex and scores exactly as
  high as a secret - so the pattern now keys on the prefixes vendors add for
  precisely this purpose (`sk-`, `sk-ant-`, `ghp_`, `github_pat_`, `AKIA`, `xox`,
  `glpat-`, `AIza`, `gsk_`, `hf_`, `sk_live_`, `npm_`, and others). This is also a
  **recall improvement** for prefixed credentials, which the length rule missed
  outright: `ghp_...` never matched, because `_` is a word character and broke the
  leading `\b`, and `AKIA...` is 20 characters, under the 32 floor. The cost is
  that an unprefixed vendor key is no longer matched; add
  `piiPatterns: { ...DEFAULT_PII_PATTERNS, longToken: /\b[A-Za-z0-9]{32,}\b/g }`
  to get the old rule back.

  **`ipAddress` no longer eats version strings.** `version 1.2.3.4` became
  `version [REDACTED_IPADDRESS]`. Octets are now range-checked (so `1.2.3.999` is
  not an address) and quads introduced by `v` / `ver` / `version` / `rev` /
  `release` / `build` are skipped. A bare four-segment version with no marker word
  stays ambiguous - `1.2.3.4` is a valid address and a valid version, and nothing
  in the text separates them - and is still read as an address.

  **`piiDetector` works in redact mode.** The documented escape hatch for exactly
  these false positives did not function: `sanitizeRequest` keyed off patterns
  only, so a custom detector was consulted for detection and then ignored for
  redaction, which applied `DEFAULT_PII_PATTERNS` regardless. The detector now
  drives redaction, and **replaces** the default patterns rather than augmenting
  them - for detection and redaction alike, which is what makes it usable to turn
  a default false positive off. Under `piiAction: 'redact'` the strings it returns
  in `matches` are the ones replaced with `[REDACTED_<TYPE>]`.

  Supporting API, all additive: `redactPIIMatches(text, matches)` redacts from
  already-computed matches; `ValidationResult.piiResults` carries per-message
  detection results; `sanitizeRequest` takes them as an optional third argument, so
  the detector runs once per message rather than once per phase. A synchronous
  detector passed straight to `sanitizeRequest` is honoured directly; an async one
  cannot be awaited from a synchronous function, so that case warns rather than
  quietly falling back to the patterns the caller replaced.

  `DEFAULT_PII_PATTERNS.ipAddress` now uses lookbehind (ES2018), which needs
  Node 18+ / Safari 16.4+ - already implied by this package's ES2022 target.

  Tests: 1709 -> 1824 passing; 115 new in
  `tests/unit/detection-false-positives.test.ts`, which tests **precision as well
  as recall** - only recall was covered before. Every corpus has both halves:
  personal names, semantic versions (including four-segment), git SHAs short and
  long, UUIDs with and without dashes, base64 ids and npm/docker digests must not
  be detected; genuine injection attempts, real PII, and fourteen real credential
  formats must still be.

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

- Updated dependencies [48c5c26]
- Updated dependencies [7be8792]
- Updated dependencies [223c37a]
- Updated dependencies [3467132]
- Updated dependencies [681fa2d]
- Updated dependencies [22b9273]
- Updated dependencies [32415cc]
- Updated dependencies [30629d4]
- Updated dependencies [f8d20bf]
- Updated dependencies [eb8580b]
- Updated dependencies [9b31fc4]
- Updated dependencies [9fd19f4]
- Updated dependencies [8b89edb]
- Updated dependencies [e800f3d]
- Updated dependencies [582a4e5]
- Updated dependencies [c06df51]
- Updated dependencies [71e5631]
- Updated dependencies [0abfa0b]
- Updated dependencies [bb69513]
  - @johnhenry/aimatey-core@0.3.0
  - @johnhenry/aimatey-types@0.3.0
  - @johnhenry/aimatey-utils@0.2.0
  - @johnhenry/aimatey-errors@0.2.0

## 0.1.1

### Patch Changes

- bc0b9ea: Fix `TypeError: createHash is not a function` in browsers, webviews, Capacitor and Electron renderers (#48).

  `caching.ts` and `embeddings.ts` derived their cache keys with Node's
  `crypto.createHash('sha256')`, imported by the bare specifier `'crypto'`. Both
  modules are re-exported from the package barrel, so _any_ import from
  `@johnhenry/aimatey-middleware` pulled Node `crypto` into the module graph.
  Bundlers externalize it for browser targets ("Module "crypto" has been
  externalized for browser compatibility"), leaving `createHash` undefined, and
  the first cache lookup threw.

  The cache key is an index over `JSON.stringify(...)` of the request, not a
  security primitive, so it no longer needs a cryptographic hash. It is now
  produced by `stableHash`, a dependency-free 128-bit non-cryptographic hash
  (FNV-1a 64-bit run as two independently-seeded lanes, finalized with Murmur3's
  `fmix32`). It is synchronous — `CacheKeyGenerator` keeps its existing signature,
  unlike `crypto.subtle.digest` — deterministic across engines and platforms, and
  hashes UTF-16 code units so emoji, CJK, combining marks and even lone
  surrogates are all handled without throwing and without collapsing together.

  **Cache keys change.** Keys produced by this version differ from the previous
  SHA-256 ones, so every existing cache entry misses once and is then repopulated.
  Persistent/shared `CacheStorage` implementations will accumulate the old entries
  until their TTL expires; clear the cache on deploy if that matters to you.
  Custom `keyGenerator` functions are unaffected.

  Note that `stableHash` is deliberately **not** cryptographic. Anything in your
  own code that needs collision resistance against an adversary should keep using
  `node:crypto` (server-side) or `crypto.subtle` (universal).

- Updated dependencies [6e79fa1]
- Updated dependencies [213b23e]
- Updated dependencies [0ac4957]
  - @johnhenry/aimatey-core@0.2.0
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
  - @johnhenry/aimatey-core@0.1.0
  - @johnhenry/aimatey-errors@0.1.0
  - @johnhenry/aimatey-types@0.1.0
  - @johnhenry/aimatey-utils@0.1.0

> Previously published as `aimatey-middleware`, last unscoped version `0.3.1`.

## 0.3.1

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
  - aimatey-core@0.3.3
  - aimatey-errors@0.2.1
  - aimatey-types@0.5.1
  - aimatey-utils@0.4.2

## 0.3.0

### Minor Changes

- dae4d01: Embeddings support: `bridge.embed()` / `router.embed()` with batch chunking, dimension
  normalization, and an embed middleware chain; provider implementations for OpenAI, Mistral,
  Gemini, Cohere, Ollama, Together, Fireworks, DeepInfra, NVIDIA, and LM Studio; caching and
  cost-tracking embedding middleware.

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
- Updated dependencies [f227db2]
- Updated dependencies [2912b7d]
- Updated dependencies [aef9f4a]
- Updated dependencies [78731bb]
- Updated dependencies [b7e2312]
- Updated dependencies [58ebc03]
  - aimatey-types@0.3.0
  - aimatey-utils@0.3.0
  - aimatey-core@0.3.0
