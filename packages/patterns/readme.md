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

See the [pattern guide](https://github.com/johnhenry/aimatey/blob/main/docs/PATTERNS.md) for
the full write-ups, benchmarks, and trade-offs behind each pattern.

## License

MIT
