# @johnhenry/aimatey-patterns

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-patterns.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-patterns)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-patterns.svg)](LICENSE)

> **Note:** Previously published as `aimatey-patterns@0.2.1`.

Production integration patterns for the [aimatey](https://github.com/johnhenry/aimatey)
Universal AI Adapter System — the validated patterns from the pattern library, packaged as
importable utilities.

```bash
npm install @johnhenry/aimatey-patterns
```

## Patterns

| Utility | Purpose |
|---|---|
| `createComplexityRouter()` | Route by query complexity: cheap models for simple queries, capable models for hard ones |
| `createParallelAggregator()` | Query several providers at once; fastest-wins, all-results, or a custom judge |
| `createFailoverMiddleware()` | Bridge-level failover to fallback adapters (Router users: prefer built-in fallback chains) |
| `createCostOptimizer()` | Cost-optimized routing plus a sliding-window budget ceiling |
| `createBatchProcessor()` | Bounded-concurrency queue with token-bucket rate limiting and retries |
| `createEmulatedDecisionBackend()` | Wrap a chat backend so `Bridge.decide()` works on it through structured output (opt-in; no probabilities) |

## Quick start

```typescript
import { createComplexityRouter, createBatchProcessor } from '@johnhenry/aimatey-patterns';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { OpenAIBackendAdapter, AnthropicBackendAdapter } from '@johnhenry/aimatey-backend';

const router = createComplexityRouter({
  tiers: [
    { backend: 'fast', maxComplexity: 40 },
    { backend: 'powerful', maxComplexity: 100 },
  ],
  backends: {
    fast: new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY }),
    powerful: new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }),
  },
});

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

const processor = createBatchProcessor({
  execute: (request) => bridge.chat(request),
  concurrency: 5,
  requestsPerSecond: 10,
});
```

## Emulated decisions

`createEmulatedDecisionBackend(chatBackend, opts?)` makes any chat backend answer typed-decision
questions (`choice` / `score` / `noul`) with one structured-output call. It is **opt-in**: `Bridge`
and `Router` never emulate decisions on their own, so a chat backend only answers `decide()` when
you wrap it. It is also **honest**: the answers carry no `probabilities` and no `confidence` (a chat
model has no calibrated distribution to report, and a made-up one would mislead), every response has
a `capability-emulated` warning, and the adapter declares `decisionsEmulated: true`. Small models drift
from the schema, so near-misses are coerced rather than rejected: `"true"` / `"false"` (any case) or
`1` / `0` for a `noul`, a numeric string or number for a `score` index, and a trimmed,
case-insensitive match for a `choice` key or score label (an exact match always wins). Each
coercion adds a `response-malformed` warning; anything else outside the enum still rejects. Prefer a real
decision model (Jev, Laya, Tev1, Ollama's `nimble`) where one is available, and use this as the
fallback or for local experiments.

```typescript
import { createEmulatedDecisionBackend } from '@johnhenry/aimatey-patterns';
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend';

const backend = createEmulatedDecisionBackend(new OllamaBackendAdapter(), {
  model: 'qwen2.5:3b',
  includeReasoning: true, // answers get a short `reasoning` string
});
const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);

const { answers } = await bridge.decide(ticketText, {
  team: {
    type: 'choice',
    instructions: 'Which team should handle this?',
    criteria: { billing: 'Charges and invoices', auth: 'Login problems', other: 'Anything else' },
  },
  urgent: { type: 'noul', instructions: 'Does the customer need this today?' },
});
// answers.team => { type: 'choice', value: 'billing', reasoning: '...' }   (no probabilities)
```

Options: `model`, `concurrency` (chat calls in flight, default 4), `includeReasoning`, `name`,
`systemPrompt`. Questions become a JSON schema (`choice` -> enum of keys, `score` -> enum of level
labels, `noul` -> boolean). If the chat backend lacks native structured output a JSON-only
instruction is added and the reply is parsed defensively; an answer outside its enum rejects with a
`ProviderError` naming the question. Images are passed to multi-modal chat backends and dropped
(with a warning) otherwise. `estimateDecisionCost()` delegates to the chat backend's `estimateCost()`.

## Decision patterns

Typed-decision models report confident answers that are not always trustworthy: they can follow an
option's *name* instead of its definition, be talked around by text inside the `state`, and ship
over-confident. These factories are **default-off**: nothing registers them for you. Middleware ones
plug into `bridge.useDecision()`; the ensemble is a backend.

**Escalation.** Rerun the whole request on a stronger backend when answers are shaky. The condition is
Vercel AI Gateway's `when` contract (`confidenceBelow`, `probabilityBetween`, `any`, `all`,
`atLeast`; max 5 levels, 1-20 conditions per list), validated against the request's question types
up front. The fallback's response is returned with `metadata.custom.escalation`
(`triggeredBy`, `primaryModel`, `primaryBackend`, `primaryUsage`), and `usage` is the **sum of both
stages**, as Vercel bills them. A rule that cannot apply to a request (`confidenceBelow` with no
`choice`/`score` question, `probabilityBetween` with no `noul` one) throws a `ValidationError` by
default; pass `onUnmatchable: 'skip'` to treat that leaf as not matched instead, so one policy can
serve mixed requests (a skipped leaf never matches: it adds nothing inside `any` and keeps an
`all` from matching). Unknown question names and malformed conditions still throw. A missing `confidence` matches `confidenceBelow` (reason
`confidence_unavailable`), so an emulated primary always escalates.

```typescript
import { createDecisionEscalation, createEmulatedDecisionBackend } from '@johnhenry/aimatey-patterns';

bridge.useDecision(
  createDecisionEscalation({
    fallback: createEmulatedDecisionBackend(chatBackend, { model: 'qwen2.5:3b' }),
    when: { any: [{ question: 'team', confidenceBelow: 0.7 }, { probabilityBetween: [0.4, 0.6] }] },
  })
);
```

`evaluateDecisionCondition(condition, answers)` is the pure predicate, and
`decisionBands(answer, { act, review })` sorts one answer into `'act' | 'review' | 'escalate'`
(confidence for `choice`/`score`, `noulConfidence(value)` for `noul`). **Choose the `act` and `review`
thresholds from your own `calibrationReport()`, not from defaults**: confidence is distribution
concentration (`decisionConfidence()` in `@johnhenry/aimatey-utils`: `1 - H(p) / ln(n)`), not accuracy, and there are deliberately no built-in numbers.

**Neutral option keys.** Rewrites each `choice` to `opt_1..n` with the original key folded into the
description (`"billing: Charges and invoices"`), and maps `value` and `probabilities` back. In
arXiv 2609.26758, reassigning option names flipped Laya's answer 76.9 % of the time (Jev 32.5 %)
against 6.5 % with neutral keys. `shuffle` + `seed` randomize order repeatably; `noulAsChoice` also
turns each `noul` into a two-option choice.

```typescript
bridge.useDecision(createNeutralOptionKeys({ shuffle: true, seed: 7 }));
```

**Ensemble.** A backend that asks every member and aggregates per question: mean (or `'median'`, or
your function) of probabilities, then argmax; `confidence = mean(member confidence) x (1 -
disagreement)`. A member without probabilities counts as a one-hot vote, with a warning.
`metadata.custom.ensemble` lists each member's answers and the per-question disagreement.

```typescript
const ensemble = createDecisionEnsemble([jev, nimble, emulated], { aggregate: 'median', timeout: 20_000 });
```

**State screening.** Fences untrusted parts of `state` in explicit markers with a "data, not
instructions" preamble and, if given a `screener`, first asks one `noul` question about it. Check
Point found that a planted fake audit flipped a verdict *with unchanged high confidence*, so an
injection cannot be spotted from the answer afterwards; screening has to come before the model.

```typescript
bridge.useDecision(
  createStateScreening({ untrusted: () => ['report.body'], screener: cheapBackend, onFlag: 'throw' })
);
```

**Calibration.** Rescales probabilities with a temperature per question type and option count
(`softmax(log p / T)`; `noul` via logit), then recomputes `confidence`. It never changes the winner.
Fit `T` from labeled runs with `fitTemperature()` and check the result with `calibrationReport()`
(Brier, ECE, ten reliability buckets), both in `@johnhenry/aimatey-testing`. `calibrationReport()` buckets on the winner's probability mass from `probabilities` (not on `confidence`, which is concentration, not P(correct)); `confidence` is only a fallback for answers without `probabilities`. `nameInvariance()`
there measures how much a model needs neutral keys, with no labels.

```typescript
const { temperature } = fitTemperature(labeledRuns); // > 1: the model is over-confident
bridge.useDecision(createTemperatureScaling({ byType: { noul: temperature } }));
```

See the [pattern guide](https://github.com/johnhenry/aimatey/blob/main/docs/PATTERNS.md) for
the full write-ups, benchmarks, and trade-offs behind each pattern.

## License

MIT
