---
title: "Decisions Guide"
description: "Typed-decision (System One) models in aimatey: Bridge.decide, Router.decide, every backend and dialect, local setup with Ollama, the confidence-control patterns, tool-call gating, dataset capture, the demo gateway and the benchmark."
---

Decision models answer **typed questions about a state** in one forward pass, with calibrated probabilities instead of generated text. Within three weeks of TypeSafe shipping Jev and its `POST /v1/systemone` API (2026-09-15), Cloudflare (Clef), Perplexity, Ollama, Convai (Laya) and others had adopted the same request shape. aimatey treats it as a third modality beside `chat()` and `embed()`: one IR, one `Bridge.decide()`, many backends.

This guide covers the whole surface. The design rationale and the research it rests on are in [`docs/plans/decision-models.md`](https://github.com/johnhenry/aimatey/blob/main/docs/plans/decision-models.md).

## When to use a decision model

Use one when the job is **classification, scoring or gating over a piece of text or data**: route this ticket, is this invoice a duplicate, how severe is this alert, may this tool call run.

| | Decision model | Structured-output LLM |
|---|---|---|
| Output | Typed answers plus (usually) a probability distribution | JSON you must validate; no calibrated confidence |
| Latency | Tens to hundreds of milliseconds hosted (Jev about 524 ms median, Clef 39 to 209 ms, Laya about 33 ms) | One generation: seconds |
| Cost | Input tokens only (Jev $0.042 per million in, output free) | Input and output tokens |
| Generality | Fixed question types: `choice`, `score`, `noul` | Anything |
| Failure mode | Confidently wrong; follows option *names*; blind to injected text in `state` | Hallucination, malformed JSON |

If you need free-form text, reasoning over many steps, or a question that is not one of the three types, use `chat()` with structured output. If you need both, wrap a chat backend as a fallback ([escalation](#escalation-and-bands)) so a decision model handles the easy cases and an LLM the hard ones.

Two limits to know before relying on one: vendors warn against counting, arithmetic and date comparison, and English-only encoders fail on non-Latin scripts *while reporting high confidence* (see [failure modes](#failure-modes-and-the-patterns-that-answer-them)).

## The three question types

A request is a `state` (text, JSON, anything serializable) and a map of named questions. Answers come back under the same names. Full field-by-field definitions are in the [IR format guide](/guides/architecture/ir-format/#decision-ir).

```typescript
import type { IRDecisionRequest } from '@johnhenry/aimatey-types';

const questions: IRDecisionRequest['questions'] = {
  // choice: pick one option. criteria: option name -> when it applies.
  department: {
    type: 'choice',
    instructions: 'Which team should handle this?',
    criteria: { billing: 'invoices, refunds, charges', technical: 'bugs, outages, errors' },
  },
  // score: place on an ordered scale. criteria: levels, low to high.
  urgency: {
    type: 'score',
    instructions: 'How urgent is this?',
    criteria: ['low', 'medium', 'high'],
  },
  // noul: a yes/no question answered as a probability. criteria is optional
  // and pins what each side means.
  refundRequested: {
    type: 'noul',
    instructions: 'Does the customer ask for a refund?',
    criteria: { true: 'asks for money back', false: 'does not ask for money back' },
  },
};
```

The answers:

```typescript
// department -> { type: 'choice', value: 'billing', probabilities: { billing: 0.93, technical: 0.07 }, confidence: 0.93 }
// urgency    -> { type: 'score',  value: 1.4, probabilities: [0.1, 0.5, 0.4], confidence: 0.5 }   // fractional index
// refundRequested -> { type: 'noul', value: 0.97 }                                              // P(yes)
```

`probabilities` and `confidence` are **optional** on `choice` and `score`: a provider may not report them, and an LLM-emulated answer has none. There is no sentinel value, so handle `undefined`. A `noul` answer's `value` is the probability itself.

## Bridge.decide, decideFrom and decideBatch

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { createGenericFrontend } from '@johnhenry/aimatey-frontend';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend';

const bridge = new Bridge(
  createGenericFrontend(),
  new OllamaBackendAdapter({ defaultModel: 'tev1:0.8b' })
);

const { answers, usage, model } = await bridge.decide(
  'I was charged twice this month. Please refund the duplicate.',
  questions
);
```

- **`decide(state, questions, options?)`** builds the IR request directly (no frontend translation, like `embed()`) and runs it through the [decision middleware](#decision-middleware). The backend needs `capabilities.decisions` and a `decide()` method; it does not need to support chat. Requests are pre-flight validated (`validateDecisionRequest`) against the backend's declared types, limits and image support before any network call; hard violations throw and soft ones (such as polar choice keys) become warnings. `options` takes `model`, `signal`, `metadata`, `principal` and `custom` (provider passthrough).
- **`decideFrom(request, options?)`** is for callers who speak a provider's wire format. The frontend's `decisionToIR()` translates the request, the backend answers, and `decisionFromIR()` translates the response back, so a TypeSafe-shaped call returns a TypeSafe-shaped result. Needs a [decision frontend](#frontends-and-wrappers).
- **`decideBatch(states, questions, options?)`** asks the same questions about many states, in input order, through exactly the path `decide()` takes. `concurrency` defaults to the backend's `decisionLimits.maxConcurrency` (1 for a single-session local model such as Laya), else 4. `onError: 'collect'` returns a `PromiseSettledResult` per state; the default `'throw'` rejects with the first error and aborts the rest. `onProgress(done, total)` reports progress.

```typescript
const results = await bridge.decideBatch(tickets, questions, {
  concurrency: 2,
  onError: 'collect',
  onProgress: (done, total) => console.log(`${done}/${total}`),
});
```

Check `response.metadata.warnings` too: validation, truncated images, emulation and similar advisories land there rather than failing the call.

## Router.decide

`Router` mirrors `embed()`: register decision backends, and `router.decide()` tries the candidates in fallback-chain order.

```typescript
import { createRouter } from '@johnhenry/aimatey-core';
import { OllamaBackendAdapter, TypeSafeBackendAdapter } from '@johnhenry/aimatey-backend';

const router = createRouter({ fallbackStrategy: 'sequential' })
  .register('local', new OllamaBackendAdapter({ defaultModel: 'tev1:0.8b' }))
  .register('jev', new TypeSafeBackendAdapter({ apiKey: process.env.TYPESAFE_API_KEY! }))
  .setFallbackChain(['local', 'jev']);

const response = await router.decide({
  state: ticket,
  questions,
  metadata: { requestId: 'r1', timestamp: Date.now() },
});
```

A candidate is a registered backend that implements `decide()`, whose circuit is not open, **and** that can serve this request. A backend whose `decisionTypes`, `decisionLimits` or `decisionImages` rule it out is skipped (reported through `onWarning`), not failed. A candidate that declares `decisionModels` without `parameters.model` is tried after the rest, not excluded. Success, failure, latency and cost are tracked per backend.

`Bridge` accepts a router as its backend, so `new Bridge(frontend, router).decide(...)` gets routing, fallback and the middleware chain together. Routers also keep decision-only backends out of chat selection.

Capabilities a decision backend declares, which routing and validation read:

| Capability | Meaning |
|---|---|
| `decisions` | The backend implements `decide()` |
| `decisionModels` | Model ids it serves |
| `decisionTypes` | Which of `choice` / `score` / `noul` it answers natively |
| `decisionsEmulated`, `decisionsEmulatedTypes` | Answered by a chat model (or a letter-protocol emulation), so no calibrated probabilities |
| `decisionImages` | Accepts `images` on the request |
| `decisionLimits` | `maxQuestions`, `maxChoiceOptions`, `maxScoreLevels`, `maxStateTokens`, `maxImages`, `maxConcurrency` |

## Backends and dialects

Almost every provider speaks the same System One request shape, so aimatey has one parser and a small table of dialect differences (`SYSTEMONE_DIALECTS`).

| Backend (`@johnhenry/aimatey-backend`) | Endpoint | Dialect notes | Types | Images | Limits |
|---|---|---|---|---|---|
| `TypeSafeBackendAdapter` | `api.typesafe.ai/v1/systemone` | canonical System One (Jev) | choice, score, noul | no | 255 options, 10 levels, 32k state tokens |
| `OllamaBackendAdapter` | `localhost:11434/v1/systemone` | System One, plus `keep_alive` (`parameters.custom.keepAlive`); noul accepts `criteria` labels | choice, score, noul | yes (base64) | 64 questions, 255 options, 2 to 26 levels |
| `CloudflareBackendAdapter` | `/ai/run/@cf/cloudflare/{clef,clef-flash}` | System One wrapped in `result`; only `clef` and `clef-flash` accepted | choice, score, noul | yes, up to 4 | 64 questions, 255 options, 10 levels, 64k state tokens |
| `OpenRouterBackendAdapter` | `/api/alpha/decisions` (`decisionsEndpoint: 'systemone'` for `/api/v1/systemone`) | envelope with `id`, `provider`, `usage.cost`; `provider` routing, `trace`, `session_id` via `parameters.custom`; `probabilities` / `confidence` optional | choice, score, noul | no | Jev's |
| `OpenAIBackendAdapter` | `/v1/decisions` | **Not System One**: `input` plus a `questions` array (`choice` / `predicate` / `score`), answers matched by `name`; `gpt-6-luna` (preview); images as `data:` URLs only; on api.openai.com, or `decisions: true` | choice, score, noul | yes | 200 questions, 255 options, 10 levels |
| `PerplexityBackendAdapter` | `/v1/decisions` | System One-shaped; `pplx-decider-v1-27b`; image encoding unverified | choice, score, noul | yes (unverified) | undeclared |
| `InceptionBackendAdapter` | assumes `<baseURL>/systemone` (unverified) | Mercury Decide; works through OpenRouter today | choice, score, noul | no | undeclared |
| `TogetherAIBackendAdapter` | chat-completions letter protocol | **Not System One**: one call per question, the model answers a letter A to X; probabilities from `top_logprobs`. `noul` and `score` are emulated, each with a warning | choice native | no | 2 to 24 options |
| `SystemOneBackendAdapter` | your `baseURL` | any server that speaks System One; pick `dialect`: `'systemone'`, `'openrouter'`, `'vercel-evaluate'`, or `'cloudflare'` | configurable | configurable | configurable |
| `LayaBackendAdapter` (`@johnhenry/aimatey-native-laya`) | on-device ONNX (`@receptron/laya`) | no network; one session, so concurrency 1 | choice, score, noul | no | about 20 options, 10 levels, 512 state tokens (English) |
| `createEmulatedDecisionBackend(chat)` (`@johnhenry/aimatey-patterns`) | any chat backend | one structured-output call; no probabilities; `reasoning` optional; `decisionsEmulated: true` | choice, score, noul | if the chat backend is multimodal | the chat model's |

The generic adapter covers self-hosted Kev, Strands Decider, `laya[serve]` and Nimble servers, Vercel AI Gateway (`baseURL: 'https://ai-gateway.vercel.sh/typesafe/v1'`), and OpenAI Decisions once its schema is public. OpenAI's Decisions API (invite-only as of 2026-09-29) has a dialect slot only; there is no OpenAI decision frontend or adapter yet.

```typescript
import { SystemOneBackendAdapter } from '@johnhenry/aimatey-backend';

const backend = new SystemOneBackendAdapter({
  baseURL: 'http://localhost:8080/v1', // any System One server
  defaultModel: 'my-decider',
  decisionImages: true,
});
```

Provider numbers above (limits, prices, latencies) come from the providers' announcements; the hosted adapters have not been verified live with real API keys.

## Local setup with Ollama

Ollama 0.35 or newer serves decision models on `POST /v1/systemone`.

```bash
ollama pull tev1:0.8b     # small and fast; the default for local tests
ollama pull nimble        # Bespoke Nimble, 9B: more accurate, far slower on CPU
```

```typescript
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend';

const backend = new OllamaBackendAdapter({ defaultModel: 'tev1:0.8b' });
```

Ollama accepts 1 to 64 questions, up to 255 options, 2 to 26 score levels, and a 64 KiB request body. `listModels()` marks decision models (`nimble`, `tev1`, `kev`, ...) with `metadata.kind: 'decision'`, including re-tagged models detected through their GGUF parent.

Expect CPU-only hardware to be slow: on a 4-core box, `tev1:0.8b` took about 10 seconds per call (p50 9.5 s, p95 13.5 s, each call asking three questions) and a 3B chat model through the emulation backend about 20 to 60 seconds, depending on load. `nimble` took around two minutes per call. The [benchmark results](#benchmarking) have the measured table. A GPU changes this by an order of magnitude or more.

## Frontends and wrappers

Decision frontends implement `decisionToIR()` / `decisionFromIR()` so `Bridge.decideFrom()` can accept a provider's wire shape. They are not chat frontends.

| Frontend (`@johnhenry/aimatey-frontend`) | Shape |
|---|---|
| `TypeSafeFrontendAdapter` | `@typesafe-ai/sdk` `systemOne()` calls (also the Ollama shape) |
| `LayaFrontendAdapter` | `Router.predict()`-style Laya calls |
| `VercelDecideFrontendAdapter` | AI SDK `decide()`: `boolean`, `choice`, `score`; `{ answers, usage, response, providerMetadata }` |
| `OpenRouterDecisionsFrontendAdapter` | `/api/alpha/decisions` bodies with `provider`, `trace`, `session_id` and the `id` / `provider` / `usage.cost` envelope |

The wrappers (`@johnhenry/aimatey-wrapper`) put those on a Bridge as drop-in clients:

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { TypeSafeFrontendAdapter, VercelDecideFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { createTypeSafeClient, createDecide } from '@johnhenry/aimatey-wrapper';

// Same call shape as @typesafe-ai/sdk's systemOne()
const client = createTypeSafeClient(new Bridge(new TypeSafeFrontendAdapter(), backend));
const { answers } = await client.systemOne({
  state: 'Please refund me.',
  questions: { refund: { type: 'noul', instructions: 'Wants a refund?' } },
});

// Same call shape as `decide()` from the `ai` package
const decide = createDecide(new Bridge(new VercelDecideFrontendAdapter(), backend));
const result = await decide({
  model: 'tev1:0.8b',
  state: 'Please refund me.',
  questions: { refund: { type: 'boolean', instructions: 'Wants a refund?' } },
});
```

`createDecisionModel` wraps a bridge as an AI SDK `DecisionModel`. Anything built on either SDK can now run on any decision backend: Ollama, Laya, an emulated chat model.

## Decision middleware

Decision requests have their own middleware chain, registered with `bridge.useDecision()` and run outermost first. The chat middleware stack does not apply (its context types are chat-specific). `@johnhenry/aimatey-middleware` ships:

| Factory | Does |
|---|---|
| `createDecisionCachingMiddleware` | Caches by hash of state, questions, images, model and caller scope. A request with no caller identity (`options.principal` or `scopeKey`) is **not** cached unless `unidentified: 'share'`, because a decision's state is usually the sensitive part. Emulated, malformed and capability-warned responses are never stored |
| `createDecisionCostTrackingMiddleware` | Books `usage.cost` when the provider reports it, else input tokens at registry pricing |
| `createDecisionRetryMiddleware` | Retries with backoff, like the chat retry |
| `createDecisionLoggingMiddleware` | Logs question names and answers |
| `createDecisionOpenTelemetryMiddleware` | Spans with per-question confidence attributes |
| `createDecisionValidationMiddleware` | Shape checks on the request (and an optional `maxStateBytes`), then `validateDecisionResponse` on what comes back: a missing, mistyped or out-of-range answer throws, and soft problems such as probabilities that do not sum to 1 become warnings (or errors with `strict`) |

```typescript
import {
  createDecisionCachingMiddleware,
  createDecisionCostTrackingMiddleware,
  createDecisionRetryMiddleware,
} from '@johnhenry/aimatey-middleware';

bridge
  .useDecision(createDecisionRetryMiddleware({ maxAttempts: 3 }))
  .useDecision(createDecisionCachingMiddleware({ unidentified: 'share' })) // single-tenant; otherwise pass options.principal
  .useDecision(createDecisionCostTrackingMiddleware());
```

## Failure modes and the patterns that answer them

A decision model's confidence is a control signal, and it is not trustworthy by default. These are the published failure modes aimatey's patterns are built around. All the patterns below live in `@johnhenry/aimatey-patterns`, are **default-off**, and plug into `bridge.useDecision()` (the ensemble is a backend).

1. **Option-name bias** ([arXiv 2609.26758, "Type-Safe Is Not Error-Free"](https://arxiv.org/html/2609.26758)). Decision heads follow the *name* of an option, not its definition. Reassigning `yes` / `no` to swapped definitions flipped Laya's answer 76.9 % of the time (Jev 32.5 %), against 6.5 % with neutral `0` / `1` keys; rotating names on multi-option questions dropped accuracy from 56.4 % to 15.5 %.
2. **Prompt injection in `state`** ([Check Point](https://blog.checkpoint.com/ai-security/jev-is-not-a-language-model-but-it-breaks-like-one-prompt-injection-against-a-typed-decision-model/)). Fabricated audit opinions inside the document flipped a "do not invest" verdict with *unchanged high confidence*. Typed input, "untrusted" markers and anti-injection instructions did not help; screening input *before* the model did.
3. **Over-confidence and calibration drift.** Laya ships over-confident (ECE 0.466, down to 0.081 after one temperature per question type and option count); Jev is about 7 points over-confident on the Decision Index (ECE 0.074). Confidence measures how concentrated the distribution is, not how often the answer is right.
4. **Language and arithmetic blind spots.** English-only encoders fail on non-Latin scripts while reporting 0.95 confidence; every vendor warns against counting, arithmetic and date comparison. `validateDecisionRequest` warns on mostly non-Latin state sent to an English-only model.

### Neutral option keys

`createNeutralOptionKeys()` rewrites each `choice` to `opt_1 .. opt_n` with the original key folded into the description (`"billing: invoices, refunds"`), and maps `value` and `probabilities` back. `shuffle` with a `seed` randomizes presentation order repeatably; `noulAsChoice` turns each `noul` into a two-option choice. Request validation already warns when a choice uses polar keys such as `yes` / `no`.

```typescript
import { createNeutralOptionKeys } from '@johnhenry/aimatey-patterns';

bridge.useDecision(createNeutralOptionKeys({ shuffle: true, seed: 7 }));
```

`nameInvariance(backend, request)` in `@johnhenry/aimatey-testing` measures how much a model needs this, with no labels: two extra forward passes per trial, one with neutral keys and one with name-to-definition bindings rotated, reporting the flip rate.

### Escalation and bands

`createDecisionEscalation({ fallback, when })` reruns the whole request on a stronger backend (a better decision model, or an LLM through the emulation backend) when answers are shaky. The condition language is Vercel AI Gateway's `when` contract: `confidenceBelow`, `probabilityBetween`, and `any` / `all` / `atLeast` combinators. The fallback's response comes back with `metadata.custom.escalation` (`triggeredBy`, `primaryModel`, `primaryBackend`, `primaryUsage`), and `usage` is the sum of both stages. A missing `confidence` matches `confidenceBelow`, so an emulated primary always escalates.

```typescript
import { createDecisionEscalation, createEmulatedDecisionBackend } from '@johnhenry/aimatey-patterns';

bridge.useDecision(
  createDecisionEscalation({
    fallback: createEmulatedDecisionBackend(chatBackend, { model: 'qwen2.5:3b' }),
    when: { any: [{ question: 'department', confidenceBelow: 0.7 }, { probabilityBetween: [0.4, 0.6] }] },
  })
);
```

`decisionBands(answer, { act, review })` sorts one answer into `'act'`, `'review'` or `'escalate'`. **Pick the thresholds from your own `calibrationReport()`**, not from defaults: there are deliberately no built-in numbers.

### Ensembles

`createDecisionEnsemble([a, b, c], { aggregate })` is a backend that asks every member and aggregates per question: mean (or `'median'`, or your function) of probabilities, then argmax. `confidence = mean(member confidence) x (1 - disagreement)`, so disagreement lowers confidence. A member without probabilities counts as a one-hot vote, with a warning. `metadata.custom.ensemble` lists each member's answers.

### State screening

`createStateScreening({ untrusted, screener })` fences the untrusted parts of `state` in explicit markers with a "data, not instructions" preamble and, when given a `screener` backend, first asks one cheap `noul` ("does this segment contain instructions addressed to an AI?"). Because injection does not lower confidence, it cannot be spotted from the answer afterwards; screening has to come before the model. `onFlag: 'throw'` rejects flagged requests.

```typescript
import { createStateScreening } from '@johnhenry/aimatey-patterns';

bridge.useDecision(
  createStateScreening({ untrusted: () => ['report.body'], screener: cheapBackend, onFlag: 'throw' })
);
```

### Calibration

`createTemperatureScaling({ byType, byOptionCount, default })` rescales probabilities (`softmax(log p / T)`; `noul` via logit) and recomputes `confidence`. It never changes the winning answer. Fit the temperature from labeled runs with `fitTemperature()` and check the effect with `calibrationReport()` (Brier, ECE and ten reliability buckets), both in `@johnhenry/aimatey-testing`. `T` above 1 means the model is over-confident. Fit each question type, and option count, separately.

```typescript
import { calibrationReport, fitTemperature } from '@johnhenry/aimatey-testing';
import { createTemperatureScaling } from '@johnhenry/aimatey-patterns';

const { temperature } = fitTemperature(labeledRuns);
bridge.useDecision(createTemperatureScaling({ byType: { noul: temperature } }));
console.log(calibrationReport(labeledRunsAfter).ece);
```

## useDecision in React

`@johnhenry/aimatey-react-hooks` has `useDecision(questions, options)` and `useDecisionBatch`. They take a `bridge` option, or one from `<DecisionBridgeProvider>`.

```tsx
import { useDecision } from '@johnhenry/aimatey-react-hooks';

const questions = { urgent: { type: 'noul', instructions: 'Is this urgent?' } } as const;

function Triage({ bridge, ticket }) {
  const { answers, decide, isLoading, error } = useDecision(questions, { bridge });
  return (
    <>
      <button disabled={isLoading} onClick={() => decide(ticket)}>Triage</button>
      {answers?.urgent && <p>P(urgent) = {answers.urgent.value.toFixed(2)}</p>}
      {error && <p>{error.message}</p>}
    </>
  );
}
```

`decide()` aborts the call in flight and ignores a late response, so the latest call wins; unmounting aborts too. `auto: true` with `initialState` runs on mount and again when the questions' content (not identity) changes.

## Tool-call gating and decision tools

Decision models are cheap enough to sit in front of every tool call an agent makes. `Bridge.runTools` takes a `gate`, and `createDecisionGate(backend)` builds one: it asks the model whether the proposed call is safe and consistent with the user's request (state: tool name, input, last user message), and maps P(true) to a verdict. At or above `allowAbove` (default 0.8) the call is allowed, at or below `denyBelow` (default 0.3) it is denied, anything between goes to `onReview` for a human. If the backend throws, `runTools` fails closed and denies the call. Verdicts carry the decision response, so `RunToolsResult.denials` is an audit trail. One forward pass replaces an LLM round trip per call.

```typescript
import { createDecisionGate, createDecisionTool } from '@johnhenry/aimatey-core';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend';

const decider = new OllamaBackendAdapter({ defaultModel: 'tev1:0.8b' });

const result = await bridge.runTools({
  prompt: 'Clean up my temp folder',
  tools,
  gate: createDecisionGate(decider, { policy: { allowAbove: 0.85, denyBelow: 0.25 } }),
  onReview: (event) => askHuman(event),
});
```

Gate thresholds are as uncalibrated as any other; calibrate them on your own tool calls. The gate calls the backend directly, so decision middleware does not run on it.

`createDecisionTool(backend, questions)` goes the other way: it exposes a decision model to a chat agent as a `ToolDefinition`. The agent calls it with `{ state }` and gets `{ answers, model }` with each answer's value and, when reported, probabilities and confidence, so it can weigh a 0.55 differently from a 0.99.

```typescript
const triage = createDecisionTool(decider, {
  urgent: { type: 'noul', instructions: 'Is this urgent?' },
});
await bridge.runTools({ prompt, tools: { [triage.name]: triage } });
```

## Dataset capture and fine-tuning loops

`createDecisionCapture({ sink })` in `@johnhenry/aimatey-testing` records what a bridge decides (state, questions, answers with probabilities, model, usage, warnings) as append-only JSONL, and lets you attach the ground truth later with `recordOutcome(requestId, truth)`. That is the dataset shape fine-tuning loops start from: Cloudflare's RL platform (AI Gateway captures a dataset, then rollouts, sandbox scoring and a trainer) and Laya's RLCD.

**aimatey does no training.** Fine-tuning lives upstream; aimatey does the capture half.

```typescript
import { createDecisionCapture, loadDecisionDataset, toCalibrationRuns } from '@johnhenry/aimatey-testing';

const capture = createDecisionCapture({
  sink: 'data/triage.jsonl',
  redact: (state) => scrubEmails(state), // or includeState: false
});
bridge.useDecision(capture.middleware);

const response = await bridge.decide(ticket, questions);
await capture.recordOutcome(response.metadata.requestId, { department: 'billing', refundRequested: true });
await capture.flush();

const runs = toCalibrationRuns(await loadDecisionDataset('data/triage.jsonl'));
```

Captured states are real user data: redact them, or drop them, before writing anywhere. The same file feeds `calibrationReport()` and `fitTemperature()`, so the loop that produces training data also tells you whether your confidence thresholds can be trusted.

## The demo gateway and the CLI

**Gateway** (`examples/decisions/gateway`, a demo, not a product). One server speaks the `/v1/systemone`, `/v1/decisions` and `/v1/evaluate` dialects, parses each to the same IR, and answers through one `Bridge` over a `Router` of decision backends with caching, cost tracking, logging, validation and escalation to an LLM-emulated fallback. It is built on `@johnhenry/aimatey-http`'s core handler; decisions are not a productised `http.core` feature. No rate limiting; one optional bearer key.

```bash
ollama pull tev1:0.8b && ollama pull qwen2.5:3b
npx tsx examples/decisions/gateway/server.ts   # http://localhost:8787
```

**CLI.** `ai-matey decide` asks typed questions through any decision backend, and `ai-matey proxy` serves the same three dialects in front of a decision-only backend.

```bash
ai-matey decide --backend ollama --model tev1:0.8b \
  --state "I was charged twice, please refund me." \
  --question 'team:choice:"Who owns this?":billing=payments and refunds,technical=bugs and outages' \
  --question 'refund:noul:"Is a refund requested?"'
```

See the [CLI readme](https://github.com/johnhenry/aimatey/tree/main/packages/cli) for the full `--question` grammar, `--batch` and `--json`.

## Benchmarking

`examples/decisions/bench` runs a labeled set across backends and reports accuracy per question type, Brier, ECE (via `calibrationReport`), p50 and p95 latency, cost, and optionally the name-invariance flip rate.

```bash
npx tsx examples/decisions/bench/bench.ts \
  --backend ollama:tev1:0.8b --backend emulated:qwen2.5:3b \
  --dataset builtin --limit 10 --hardware "4-core CPU, no GPU" --out results.json
```

- The built-in set is 40 hand-written items in the four workflow styles of the public Typed Decisions dataset: invoice reconciliation, agent triage, security alerts and customer escalation. Use it to catch regressions, not to rank models.
- `--dataset <path>` loads the public [Typed Decisions](https://huggingface.co/datasets/LocalLLaMA/typed-decisions) dataset or a [Decision Index](https://github.com/apolinario/decision-index) subset after you convert it (instructions in `fetch-datasets.md`); nothing is downloaded for you.
- **Vendor numbers are not comparable across hardware.** A 33 ms or 524 ms median was measured elsewhere. Compare backends within one run on one machine.
- `--neutral-keys`, `--temperature T` and `--name-invariance` apply the patterns above, so you can measure what they buy on your own questions.

Past runs are in [`examples/decisions/bench/results/`](https://github.com/johnhenry/aimatey/tree/main/examples/decisions/bench/results); see also [Benchmarks](https://github.com/johnhenry/aimatey/blob/main/docs/BENCHMARKS.md).

## Testing decision code

`createMockDecisionBackend({ answers | handler, latencyMs, error })` in `@johnhenry/aimatey-testing` is a decision backend for unit tests; it records every request in `.calls`.

```typescript
import { createMockDecisionBackend } from '@johnhenry/aimatey-testing';

const backend = createMockDecisionBackend({
  answers: { refundRequested: { type: 'noul', value: 0.97 } },
});
```
