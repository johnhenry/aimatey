# Decision models in aimatey — landscape and plan

*Drafted 2026-10-06. Status: proposal, not yet broken into issues.*

## 1. What happened in the last three weeks

TypeSafe shipped **Jev** on 2026-09-15 and, with it, the *System One* API: one
`POST /v1/systemone` call carrying a `state` plus a map of named, typed
questions (`choice` / `score` / `noul`), answered in a single forward pass with
calibrated probabilities instead of generated text. Within three weeks the API
became a de-facto standard:

| Provider / model | Access | Wire dialect | Types | Notes |
|---|---|---|---|---|
| **Jev 1.13** (TypeSafe) | `api.typesafe.ai/v1/systemone`; OpenRouter; Vercel AI Gateway | systemone | c/s/n | 255 options, 10 levels, 32k state / 64k total; $0.042/M in, output free; ~524 ms median |
| **Clef / Clef-flash** (Cloudflare) | Workers AI `/ai/run/@cf/cloudflare/clef[-flash]`; HF weights Apache-2.0 | systemone, response wrapped in `result`, `images[]` (≤4, base64) | c/s/n | 27B / 9B Qwen backbone, prefill-only schema head; 64 questions, 255 options, 10 levels, 64k ctx; $0.24 / $0.09 per M; 209 / 39 ms median; RL fine-tuning platform (AI Gateway captures dataset → rollouts → sandbox scoring → trainer → BYOM) |
| **pplx-decider-v1-27b** (Perplexity) | `api.perplexity.ai/v1/decisions`; HF weights | systemone-shaped, images | c/s/n | best published calibration (ECE 0.018) |
| **Ollama ≥ 0.35** | `localhost:11434/v1/systemone` | systemone + `images[]`, `keep_alive` | c/s/n | models: `nimble` (Bespoke, 9B), `tev1`, `tev1:0.8b`; 1–64 questions, 255 options, **2–26** levels, 64 KiB body; noul accepts optional `criteria` labels |
| **Laya** (Convai) | `@receptron/laya` ONNX (already wrapped); `laya[serve]` → `/v1/systemone` | systemone (+ `rl_agent`, `routing`) | c/s/n | 421M ModernBERT + head, 33 ms; weak on >20 options and on `score`; `act_probability` is useless (AUROC 0.30) |
| **Kev** (Jared Palmer), **Strands Decider 2B** (AWS), **Nimble** | self-hosted `/v1/systemone` servers; Kev also on OpenRouter | systemone | c/s/n | all Apache-2.0 |
| **OpenRouter** | `/api/alpha/decisions` and `/api/v1/systemone` | systemone + envelope (`id`, `provider`, `usage.cost`), `provider` routing prefs, `trace`, `session_id`; noul `criteria {true,false}`; `probabilities`/`confidence` **optional** on answers | c/s/n | serves Jev, Kev, Mercury Decide (Inception, free), … |
| **Vercel AI Gateway** | `/v1/evaluate` (own dialect) and `/typesafe/v1/systemone` | own: `boolean` instead of `noul`, answer `{type:'boolean', probability}`, camelCase usage, `providerMetadata.gateway` | c/s/b | **decision fallbacks**: `when: {question?, confidenceBelow | probabilityBetween, any/all/atLeast}` re-runs on another model, incl. an LLM via structured output (then `confidence:0, probabilities:{}` sentinel); `triggeredBy` reasons; two-stage billing |
| **Tev1-4B** (Together) | chat-completions | **not** systemone: system prompt + JSON user message → one letter A–X | choice only, 2–24 | probabilities need logprobs |
| **OpenAI Decisions API** | `/v1/decisions`, invite-only (DevDay 2026-09-29) | own: `predicate` / `choice` / `rubric`; choice 2–8 snake_case ids; 60k-char state; images | c/s/n | no public schema yet |
| GLiDE (Fastino), Solar Decide (Upstage), d1 (Liquid), Decider 1 (meraGPT), Span-01 (Respan, noul-only), GLiNER2.5-Decide, CLM | hosted / HF | systemone | mostly c/s/n | GLiDE tops Decision Index (64.81 vs Jev 57.91) with "adaptive thinking" |

Two architectures: *encoder + decision head* (Laya, GLiNER, Strands' 1M-param
pointer head, Clef's schema head) and *decoder letter-scoring fine-tunes*
(Tev1, Nimble, Kev, pplx-decider). Both speak the same API.

Peer client libraries have already converged on an abstraction: Vercel AI SDK
`experimental_decide()` (+ `gateway.decisionModel()`), pydantic-ai's
`DecisionModel` protocol with `TypeSafeModel` / `SystemOneModel` /
`OpenAIDecisionsModel`, neurolink's `decide` providers, TanStack AI, and
eve.dev using decisions to *auto-approve agent tool calls* and *pick agent
models*.

### Published failure modes (these shape the plan)

1. **Option-name bias** (arXiv 2609.26758). Decision heads follow the *name* of
   an option, not its definition. Reassigning `yes`/`no` to swapped
   definitions flipped Laya's answer 76.9 % of the time (Jev 32.5 %), vs 6.5 %
   with neutral `0`/`1` keys; rotating names on multi-option questions dropped
   accuracy 56.4 % → 15.5 %. Mitigation: neutral option keys with the meaning
   carried in the description, and a *name-invariance* check (two extra
   forward passes, no labels needed).
2. **Prompt injection in `state`** (Check Point). Fabricated audit opinions
   inside the document flipped a "do not invest" verdict with *unchanged high
   confidence*. Typed input, "untrusted" markers and anti-injection
   instructions did not help; input screening *before* the model did.
3. **Over-confidence / calibration drift.** Laya ships over-confident (ECE
   0.466 → 0.081 after one temperature per (question type, option count));
   Jev is ~7 points over-confident on the Decision Index (ECE 0.074).
   Confidence is "distribution concentration", not accuracy — the usual
   advice is three bands: act / review / escalate.
4. **Language and arithmetic blind spots.** English-only encoders fail
   catastrophically on non-Latin scripts *while reporting 0.95 confidence*;
   every vendor warns against counting, arithmetic and date comparison.

Benchmarks to know: **Decision Index 0.2** (40 benchmarks, chance-corrected,
Brier + ECE), **JevBench**, and the **Typed Decisions** dataset (invoice
reconciliation, agent triage, security alerts, customer escalation).

## 2. Where aimatey stands today

Shipped 2026-09-22 → 09-27 (`22dc8ca`, `7cc27f9`, `6f5e0a9`, `2a4d7e4`):

- **IR** `aimatey-types/src/decisions.ts`: `IRDecisionQuestion` (choice/score/noul),
  `IRDecisionRequest {state: unknown, questions, parameters?, metadata}`,
  `IRDecisionAnswer` (choice `value` + `probabilities` + `confidence`; score as
  fractional index; noul `value` + optional derived `confidence`),
  `IRDecisionResponse`, `DecisionOptions`, `DecisionMiddleware`.
- **Capabilities**: `IRCapabilities.decisions?` / `decisionModels?`;
  `BackendAdapter.decide?` / `estimateDecisionCost?`; `supportsDecisions()` guard.
- **Bridge.decide()** + `useDecision()` middleware chain. No frontend
  involvement, no cache / cost / retry / batch.
- **Router**: *no* `decide()`; `selectBackend` doesn't exclude decision-only
  backends from chat.
- **Backends**: `TypeSafeBackendAdapter` (hosted Jev), `LayaBackendAdapter`
  (`native-laya`, ONNX via `@receptron/laya`), `native-onnx` helper.
- **Frontends**: `TypeSafeFrontendAdapter`, `LayaFrontendAdapter` — neither
  implements `FrontendAdapter` (it is chat-typed), and `Bridge.decide` never
  calls them (the native-laya readme implies otherwise).
- **Demos**: `examples/laya/triage-demo.ts` and the GUI triage demo (batch,
  compare-with-Jev, dynamic questions).
- Middleware, HTTP server, CLI proxy, testing mocks, React hooks, wrappers:
  **all chat-only**; the CLI proxy rejects decision-only backends outright.

Known defects: TypeSafe adapter silently skips missing answers; `native-laya`
ignores `signal`, `parameters.model` and `parameters.custom` (so the
frontend's `task`/`lang` never arrive), declares no `decisionModels`, and
drops `rl_agent`; `LayaAnswer` still names the field `action`; stale comments
and readme lines say Laya is "frontend only".

## 3. Design principles for the next step

1. **The IR is the systemone shape, widened to the union of dialects** — not
   narrowed to Jev. Every delta a provider adds (images, noul criteria,
   optional probabilities, limits) becomes an optional IR field.
2. **One parser, many dialects.** All systemone-compatible providers share a
   `SystemOneClient`; dialect differences (`result` wrapper, `boolean` vs
   `noul`, camelCase usage, `predicate`/`rubric`) are small mapping tables.
3. **Decisions are universal, not a niche.** Any of aimatey's ~30 chat
   backends can answer decision questions through structured output
   (Vercel's LLM-fallback pattern). That makes `Bridge.decide()` work
   everywhere, with honest capability flags.
4. **Confidence is a control signal, so the library must expose the
   controls**: thresholds, escalation, ensembles, name-neutralisation, and
   calibration — the things the papers say you must do.
5. **Produce datasets, don't train.** Fine-tuning (Cloudflare RL, Laya RLCD)
   lives upstream; aimatey captures request / answer / outcome triples in the
   format those loops consume.

## 4. The plan

Four phases. Phases 0–1 unblock everything; 2 is the bulk of the value; 3–4
are the differentiators. Sizes are rough (S ≈ an hour of agent work, M ≈ a
session, L ≈ several).

### Phase 0 — Repair the current foundation (S–M)

- `native-laya`: honour `signal` (reject early if already aborted), pass
  `parameters.custom.task`/`lang` through to `@receptron/laya`, declare
  `decisionModels: ['english','multilingual','typed-decisions']`, iterate
  *questions* (not answers) so missing answers surface, keep `rl_agent` in
  `raw`, rename `LayaAnswer.action` → `rl_agent`, fix stale comments.
- `TypeSafeBackendAdapter`: throw (or warn via `metadata.warnings`) on
  missing answers instead of skipping.
- New `validateDecisionResponse(request, response)` in `aimatey-utils`:
  every question answered, answer type matches question, choice ∈ criteria,
  score within `[0, levels-1]`, probabilities finite and ≈ sum to 1 when
  present.
- `aimatey-testing`: `createMockDecisionBackend({answers | handler, latency})`
  and a `MockBackendAdapter.decide` in `backend-browser/mock.ts`.
- Readme / changelog corrections ("frontend only" lines).

### Phase 1 — IR v2 (`aimatey-types` 0.7, additive except where noted) (M)

| Change | Why |
|---|---|
| `IRDecisionRequest.images?: readonly ImageContent[]` (base64 only in practice) + `IRCapabilities.decisionImages?: boolean` | Ollama, Clef, Perplexity, OpenAI all take images with the state |
| noul question gains `criteria?: { true: string; false: string }` | OpenRouter, Vercel, Ollama labels; also the arXiv-recommended way to pin meaning to each side |
| choice/score answers: `probabilities?` and `confidence?` become **optional** (**breaking for consumers**) | OpenRouter's schema marks them optional; LLM-emulated answers have none; avoids Vercel's `confidence: 0` sentinel |
| `IRDecisionAnswer.reasoning?: string` | LLM emulation / "thinking" decision models can return it; never required |
| `IRDecisionUsage.outputTokens?`, `cost?` (promote from `details`) | every provider reports both |
| `IRCapabilities.decisionTypes?: readonly ('choice'\|'score'\|'noul')[]` and `decisionLimits?: { maxQuestions?, maxChoiceOptions?, maxScoreLevels?, maxStateTokens?, maxImages? }` | Tev1 is choice-only; Span-01 noul-only; limits differ (Jev 255/10, Ollama 64q/255/26, OpenAI 8 options, Laya ~20). Router and validation need these to pre-flight |
| `IRDecisionResponse.id?`, `provider?` | OpenRouter / Vercel envelope fields |
| `FrontendAdapter` gains optional `decisionToIR?` / `decisionFromIR?` | lets decision frontends be real frontends and lets `Bridge.decide` use them |
| `ModelRegistryEntry` seeds with `kind: 'decision'` for jev, clef, clef-flash, pplx-decider, nimble, tev1, kev, mercury-decide (pricing + limits) | cost tracking and `decisionModels` discovery |

Deliberately **not** added to the IR: a multi-label question type (no provider
has one — emulate as N nouls with a helper), a batch request type (no provider
has one — batch at the Bridge), streaming (nobody streams decisions).

### Phase 2 — Backends: "same questions, different URL" (L)

Build `packages/backend/src/decisions/systemone-client.ts`: request builder,
`fetch`, dialect-aware parser (`type` present or inferred from the question,
`legend`, `result` wrapper, snake/camel usage, `boolean`→noul,
`predicate`/`rubric`→noul/score), error mapping. Then add `decide()` to:

| Adapter | Endpoint | Dialect notes |
|---|---|---|
| `TypeSafeBackendAdapter` | (refactor onto the client) | canonical |
| `OllamaBackendAdapter` | `/v1/systemone` | `images`, `keep_alive`; detect decision models from `listModels`; limits 64q / 255 / 26 levels |
| `CloudflareBackendAdapter` | `/ai/run/@cf/cloudflare/{clef,clef-flash}` (note: not under the adapter's `/ai/v1` OpenAI-compat base) | `result` wrapper, `images` ≤ 4, `model` must be `clef`/`clef-flash`; register both models with $0.24/$0.09 pricing |
| `OpenRouterBackendAdapter` | `/api/alpha/decisions` (fallback `/api/v1/systemone`) | `provider` prefs, `trace`, `session_id` from `parameters.custom`; `id`/`provider`/`cost` into the response |
| `PerplexityBackendAdapter` | `/v1/decisions` | images; `pplx-decider-v1-27b` |
| `InceptionBackendAdapter` | Mercury Decide (verify native endpoint; works via OpenRouter today) | |
| `TogetherAIBackendAdapter` | chat-completions letter protocol | `decisionTypes: ['choice']`; probabilities from `logprobs`; noul/score emulated as 2-/N-option choice with neutral letter keys |
| **new `SystemOneBackendAdapter`** (`baseURL`, optional `apiKey`, `dialect: 'systemone' \| 'openrouter' \| 'vercel-evaluate' \| 'openai-decisions'`) | any self-hosted server: Kev, Strands Decider, `laya[serve]`, Nimble, Vercel `/typesafe`, OpenAI when public | the pydantic-ai `SystemOneModel` equivalent |
| **new `createEmulatedDecisionBackend(chatBackend, opts)`** in `aimatey-patterns` | any chat backend | one structured-output call → `{answers}`; `decisionsEmulated: true` capability + warning; `reasoning` populated; optional logprob-derived probabilities for OpenAI-compatible backends |

`native-onnx`: leave as-is; Strands and Nimble have no ONNX exports, so the
local story is Ollama + self-hosted systemone servers, not more ONNX ports.
Re-evaluate GLiNER2.5-Decide later (GLiNER usually ships ONNX).

### Phase 3 — Core, routing, and the "confidence controls" (L)

- **`Router.decide()`** mirroring `embed()`: candidates filtered by
  `supportsDecisions` + `decisionTypes` + `decisionLimits` + images; fallback
  chain, circuit breaker, latency and cost stats. Fix `selectBackend` to skip
  decision-only backends for chat.
- **`Bridge.decideBatch(states, questions, {concurrency})`** on top of
  `batch-processor` (concurrency 1 for ONNX-session backends).
- **Pre-flight validation** `validateDecisionRequest(request, capabilities)`:
  option / level / question counts, images support, instruction length,
  non-Latin script with an English-only model → warning.
- **Decision middleware** (`aimatey-middleware/src/decisions/`): caching
  (key = hash(state, questions, images, model)), cost tracking (registry
  per-input-token pricing or `usage.cost`), retry, logging / OpenTelemetry
  (per-question confidence attributes), validation. Refactor `retry` and
  `logging` to be request-type-generic where cheap; otherwise ship parallel
  `createDecision*Middleware` factories.
- **Escalation policy** `createDecisionEscalation({ when, fallback })` in
  patterns — Vercel's contract: `confidenceBelow`, `probabilityBetween`,
  `any` / `all` / `atLeast`, re-run the whole request on the fallback backend
  (a better decision model or the LLM emulation), return `triggeredBy`.
  Plus `bands(answer, {act, review})` → `'act' | 'review' | 'escalate'`.
- **Neutral-keys middleware** `createNeutralOptionKeys()` — rewrites criteria
  keys to `opt_1…n` with the original name folded into the description, maps
  answers back. Default-off, documented against the arXiv numbers.
- **Ensemble** `createDecisionEnsemble(backends, {aggregate})` on
  `parallel-aggregator`: mean probabilities, disagreement → confidence floor.
- **State screening hook** `createStateScreening({ screener })`: delimits
  untrusted segments and optionally asks a cheap noul ("does this segment
  contain instructions addressed to an AI?") before the real questions.
- **Calibration** `createTemperatureScaling({ byType, byOptionCount })` and a
  `calibrationReport(runs)` helper (Brier, ECE, reliability buckets) in
  testing.
- **Name-invariance check** `nameInvariance(bridge, request)` in testing —
  the two-extra-passes metric from the paper.

### Phase 4 — Frontends, surfaces, feedback loop (M–L)

- **Frontends**: `VercelDecideFrontendAdapter` (AI SDK `decide()` shape),
  `OpenRouterDecisionsFrontendAdapter`, `OpenAIDecisionsFrontendAdapter`
  (when public); `TypeSafeFrontendAdapter` doubles as the Ollama shape.
- **Wrappers**: `createTypeSafeClient(bridge)` (drop-in for
  `@typesafe-ai/sdk`'s `systemOne()`) and `createDecide(bridge)` (drop-in for
  `ai`'s `decide()`).
- **HTTP server** (`http.core`): `/v1/systemone`, `/v1/decisions`,
  `/v1/evaluate` routes → aimatey becomes a self-hostable decision gateway in
  front of Laya / Ollama / Clef with escalation and caching. Also declare
  `embeddings` / `systemone` in `HTTPListenerOptions` instead of the
  `restOptions as any` spread.
- **CLI**: proxy routes POST by path and accepts decision-only backends;
  `aimatey decide --state … --question name:type:"instructions":opts`;
  ollama-emulation `run` for decision models.
- **React**: `useDecision(state, questions, options)`.
- **Agentic gating**: `decisionGate(bridge, {questions, policy})` as a
  `Bridge.runTools` hook (approve / review / block tool calls — eve.dev's
  pattern), and `decisionTool(bridge, questions)` to expose a decision model
  as a `ToolDefinition` to an LLM agent.
- **Dataset capture** `createDecisionCapture({ sink })` writing JSONL of
  request / answers / model, with `recordOutcome(requestId, truth)` — the
  input Cloudflare's RL platform and Laya's RLCD want. No training in-repo.
- **Benchmark harness** `examples/decisions/bench`: Typed Decisions dataset
  and a Decision Index subset across configured backends → accuracy, Brier,
  ECE, p50 latency, cost; results feed `Router` `optimization: 'quality'`.
- **Docs**: "Decisions" guide, Quick Start subsection, architecture diagram
  update, provider table, three examples (cross-backend triage, LLM-vs-decision
  cost/latency, escalation + neutral keys).
- `anymethod` sugar (`ai.decide.isSpam(text)` → noul, `classifyX(opts)` →
  choice, `rateX(levels)` → score) — fun, cheap, last.

## 5. Suggested order and release train

1. Phase 0 + Phase 1 together → `types 0.7.0`, `utils 0.6.0`, `native-laya 0.2.0`,
   `backend 0.4.1`, `testing 0.2.0`. One PR each for repairs and for IR v2.
2. Phase 2 in three PRs: systemone client + TypeSafe refactor + Ollama + generic
   adapter (local-testable); Cloudflare + OpenRouter + Perplexity + Inception;
   Together + LLM emulation. → `backend 0.5.0`, `patterns 0.2.0`.
3. Phase 3 in three PRs: Router.decide + batch + validation; middleware set;
   escalation / neutral-keys / ensemble / screening / calibration.
   → `core 0.6.0`, `middleware 0.3.0`, `patterns 0.3.0`.
4. Phase 4 as independent PRs per surface.

Verification on this box: `native-laya` already runs here (the GUI demo), so
the Router / escalation / middleware stack can be tested end to end with no
API key. Ollama is **0.35.1** as of 2026-10-06, with `nimble` and `tev1:0.8b`
pulled; `/v1/systemone` is verified. On this CPU-only box `nimble` takes
about 2 minutes per call and `tev1:0.8b` about 7 s (plus a one-off model
load), so live tests default to `tev1:0.8b` and everything else replays
recorded fixtures.
Clef has a free Workers AI tier (10k neurons/day) for the Cloudflare adapter;
OpenRouter covers Jev / Kev / Mercury Decide.

## 6. Explicitly out of scope

- Training or RL fine-tuning in-repo (capture datasets instead).
- A multi-label question type or a streaming decision IR.
- Porting Strands / Nimble / Kev to `native-onnx` (no ONNX exports exist).
- OpenAI Decisions beyond a dialect slot until the schema is public.
- A decision *server* in `aimatey-mcp` (that package is an MCP client).

## 7. Decisions taken (2026-10-06)

1. `probabilities` / `confidence` become **optional** on choice/score answers;
   no sentinel values.
2. LLM emulation lives in **`aimatey-patterns`** and is opt-in (wrap a chat
   backend explicitly); `Bridge` never emulates silently.
3. The HTTP decision gateway is a **demo**: an `examples/decisions/gateway`
   server built on `http.core` + `Bridge`, not a productised `http.core`
   feature. No auth / rate-limit work beyond what `http.core` already has.

## Sources

- Ollama: [blog](https://ollama.com/blog/ollama-now-supports-jev-style-decision-models), [API reference](https://docs.ollama.com/api/systemone), [nimble](https://ollama.com/library/nimble), [tev1](https://ollama.com/library/tev1)
- Cloudflare: [Clef announcement](https://blog.cloudflare.com/clef-decision-models/), [interest page](https://www.cloudflare.com/resource/clef-rl-interest/), [deep dive with Workers AI IDs/curl](https://flaviocopes.com/clef.md)
- TypeSafe / Jev: [OpenRouter explainer](https://openrouter.ai/blog/insights/what-is-jev/), [OpenRouter guide](https://openrouter.ai/docs/guides/community/jev), [OpenRouter Decisions schema](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request), [HF guide](https://huggingface.co/blog/paidaxccc/what-is-jev-model-a-practical-guide-to-typed-ai-de)
- Vercel: [Decision modality](https://vercel.com/docs/ai-gateway/modalities/decision), [Decision fallbacks](https://vercel.com/docs/ai-gateway/models-and-providers/decision-fallbacks), [Jev on AI Gateway](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway)
- Laya: [receptron/laya](https://github.com/receptron/laya), [model card](https://huggingface.co/convaiinnovations/laya)
- Others: [Together Tev1](https://www.together.ai/models/tev1-4b-experimental), [Kev](https://github.com/jaredpalmer/kev), [Strands Decider](https://modelsystem.one/models/strands-decider/), [Perplexity Decisions API](https://docs.perplexity.ai/docs/decisions/quickstart), [GLiDE](https://fastino.ai/blog/introducing-glide-the-first-thinking-decision-model), [pydantic-ai #9633](https://github.com/pydantic/pydantic-ai/issues/9633)
- Catalogs / surveys: [systemonemodels.org](https://systemonemodels.org/models/), [Laurence Moroney, "What is a decision model?"](https://laurencemoroney.com/2026/10/02/decision-models-explained.html), [Decision Index](https://github.com/apolinario/decision-index), [JevBench](https://jevbench.dev/)
- Failure modes: [arXiv 2609.26758 — Type-Safe Is Not Error-Free](https://arxiv.org/html/2609.26758), [Check Point — prompt injection against Jev](https://blog.checkpoint.com/ai-security/jev-is-not-a-language-model-but-it-breaks-like-one-prompt-injection-against-a-typed-decision-model/)

## Status (2026-10-06)

Everything in the plan below had shipped on `main` by 2026-10-06 except the items under "Deferred". Tracking issues #140 to #148; all of Phases 0 to 4 were delivered as one PR per slice.

| Phase | Slice | PR |
|---|---|---|
| 0 + 1 | Repairs (`native-laya`, TypeSafe, `validateDecisionResponse`, mocks) and IR v2 (images, noul `criteria`, optional probabilities, `reasoning`, usage cost, capabilities, registry seeds) | #149 |
| 2a | SystemOne client, TypeSafe refactor, Ollama `/v1/systemone`, generic `SystemOneBackendAdapter` | #150 |
| 2b | `decide()` on Cloudflare (Clef), OpenRouter, Perplexity, Inception | #154 |
| 2c | Together Tev1 letter protocol; `createEmulatedDecisionBackend` | #152 |
| 3a | `Router.decide`, `Bridge.decideBatch`, `validateDecisionRequest` | #151 |
| 3b | Decision middleware: caching, cost tracking, retry, logging, OpenTelemetry, validation | #153 |
| 3c | Escalation and bands, neutral option keys, ensemble, state screening, temperature scaling; `calibrationReport`, `fitTemperature`, `nameInvariance` | #155 |
| 4a | Vercel and OpenRouter decision frontends; `createTypeSafeClient`, `createDecide` / `createDecisionModel` wrappers | #156 |
| 4b | Demo gateway (`examples/decisions/gateway`), `ai-matey decide`, decision routes on the CLI proxy | #158 |
| 4c | `useDecision` / `useDecisionBatch`, `runTools` `gate`, `createDecisionGate`, `createDecisionTool`, decision dataset capture | #157 |
| 4d | Benchmark harness (`examples/decisions/bench`), Decisions guide, IR / patterns / benchmarks docs, readme | #159 |

Decisions 1 to 3 in section 7 held: probabilities are optional, emulation is opt-in in `aimatey-patterns`, and the gateway is a demo.

### Deferred

- **OpenAI Decisions frontend and adapter.** Only a dialect slot (`'openai-decisions'`, unverified) exists; build the real thing when the schema is public.
- **Strands and Nimble ONNX ports.** No ONNX exports exist; the local story is Ollama plus self-hosted System One servers. Re-evaluate GLiNER2.5-Decide if it ships ONNX.
- **Live verification of the hosted providers.** Cloudflare, OpenRouter, Perplexity, Inception, Together and TypeSafe are covered by unit tests against stubbed HTTP, but have not been run against the real services (no API keys on the build machine). Only Ollama (0.35.1, `tev1:0.8b`) has been exercised live; the `OLLAMA_LIVE=1` bench run is the first end-to-end measurement. Perplexity's image encoding and Inception's endpoint remain unverified.
- **`anymethod` sugar** (`ai.decide.isSpam(text)`, `classifyX`, `rateX`): not built.
- **Typed Decisions and Decision Index runs.** The bench loader accepts both formats, but no public-dataset result is committed (nothing is downloaded at build time); see `examples/decisions/bench/fetch-datasets.md`.
- **Hook DOM tests in CI.** `jsdom` and `@testing-library/react` are not root devDependencies, so the `useDecision` tests that need a DOM skip in CI. Recommendation: add both to the root `devDependencies` so they run.
- **Importable decision test helpers.** `@johnhenry/aimatey-testing`'s root export imports Vitest and cannot be loaded by a CLI; the bench reaches `calibrationReport` / `nameInvariance` through the built module path. Recommendation: add a `./decisions` subpath export.
