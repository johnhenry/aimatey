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
a `capability-unsupported` warning, and the adapter declares `decisionsEmulated: true`. Prefer a real
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

See the [pattern guide](https://github.com/johnhenry/aimatey/blob/main/docs/PATTERNS.md) for
the full write-ups, benchmarks, and trade-offs behind each pattern.

## License

MIT
