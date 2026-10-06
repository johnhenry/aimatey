---
title: "Integration Patterns"
description: "Production integration patterns for aimatey: complexity routing, parallel aggregation, failover, cost optimization, and batching."
---

Production-validated integration patterns for aimatey, discovered and tested through comprehensive integration testing. Ready-made implementations of several of these patterns ship in the [`@johnhenry/aimatey-patterns`](https://www.npmjs.com/package/@johnhenry/aimatey-patterns) package (`createComplexityRouter`, `createParallelAggregator`, `createFailoverMiddleware`, `createCostOptimizer`, `createBatchProcessor`, plus the typed-decision patterns below).

:::note Validation
- **Source**: 8 advanced test applications (50+ scenarios)
- **Test Results**: 100% pass rate across all patterns
- **Status**: Production-ready
:::

## Overview

These patterns emerged from real-world testing scenarios and represent battle-tested approaches to common challenges:

| Pattern | Use Case | Complexity | Status |
|---------|----------|------------|--------|
| [Complexity-Based Routing](#complexity-based-routing) | Cost/quality optimization | Moderate | ✅ Production-ready |
| [Parallel Provider Aggregation](#parallel-provider-aggregation) | A/B testing, redundancy | Advanced | ✅ Production-ready |
| [Automatic Failover](#automatic-failover) | Resilience | Advanced | ✅ Production-ready |
| [Cost-Optimized Selection](#cost-optimized-selection) | Cost reduction | Moderate | ✅ Production-ready |
| [WebSocket Real-Time Streaming](#websocket-real-time-streaming) | Real-time chat | Advanced | ✅ Production-ready |
| [Batch Processing](#batch-processing-with-rate-limiting) | High throughput | Advanced | ✅ Production-ready |
| [Middleware Composition](#advanced-middleware-composition) | Request pipeline | Moderate | ✅ Production-ready |
| [Health Monitoring](#continuous-health-monitoring) | Observability | Moderate | ✅ Production-ready |

---

## Complexity-Based Routing

**Use Case**: Route queries to appropriate providers based on complexity to optimize cost and quality.

### Problem
Different queries require different model capabilities. Routing all queries to the most powerful (and expensive) model wastes money. Routing to cheaper models sacrifices quality on complex tasks.

### Solution
Analyze query complexity and route to appropriate providers based on a complexity score.

### Implementation

```typescript
import { Router } from '@johnhenry/aimatey-core';

// Complexity analyzer
function analyzeComplexity(query: string): number {
  let score = 0;

  // Word count (longer = more complex)
  const wordCount = query.split(/\s+/).length;
  score += Math.min(wordCount / 2, 30);

  // Keywords indicating complexity
  const complexKeywords = ['analyze', 'explain', 'compare', 'evaluate'];
  if (complexKeywords.some(kw => query.toLowerCase().includes(kw))) {
    score += 20;
  }

  // Technical indicators
  if (/\d+\s*[+\-*/]\s*\d+/.test(query)) score += 15; // Math
  if (/[A-Z]{2,}/.test(query)) score += 10; // Acronyms

  return Math.min(score, 100);
}

// Router with custom complexity-based routing.
// customRouter is async and returns a backend NAME (or null to fall through).
const router = new Router({
  routingStrategy: 'custom',
  customRouter: async (request, availableBackends) => {
    const query = request.messages[request.messages.length - 1]?.content;
    const complexity = analyzeComplexity(String(query));

    const preferred =
      complexity < 25 ? 'groq'       // Fast & cheap
      : complexity < 50 ? 'deepseek' // Cost-effective
      : complexity < 80 ? 'openai'   // Powerful
      : 'anthropic';                 // Most capable

    return availableBackends.includes(preferred) ? preferred : (availableBackends[0] ?? null);
  },
});

router
  .register('groq', groq)
  .register('deepseek', deepseek)
  .register('openai', openai)
  .register('anthropic', anthropic);

// The router is a BackendAdapter - requests go through a Bridge
const bridge = new Bridge(new OpenAIFrontendAdapter(), router);
```

### Results
- ✅ Automatic provider selection
- ✅ Cost optimization while maintaining quality
- ✅ 18 diverse test queries validated

### When to Use
- Multiple providers with different capabilities/costs
- Query complexity varies significantly
- Need to optimize for both cost and quality

---

## Parallel Provider Aggregation

**Use Case**: Compare responses from multiple providers side-by-side or ensure redundancy.

### Problem
You want to compare responses from multiple providers simultaneously, or ensure redundancy by calling multiple providers in parallel.

### Solution
Execute the same request to multiple providers in parallel and aggregate streaming responses in real-time.

### Implementation

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { EventEmitter } from 'events';

class ParallelAggregator extends EventEmitter {
  async executeParallel(request: any, backends: any[]) {
    const startTime = Date.now();

    const promises = backends.map(async (backend) => {
      const bridge = new Bridge(
        new OpenAIFrontendAdapter(),
        backend
      );

      try {
        const response = await bridge.chat(request);
        const duration = Date.now() - startTime;

        this.emit('response', {
          provider: backend.name,
          response,
          duration,
          success: true
        });

        return { provider: backend.name, response, success: true };
      } catch (error) {
        this.emit('error', {
          provider: backend.name,
          error: error.message
        });

        return { provider: backend.name, error, success: false };
      }
    });

    // Wait for all (graceful failure handling)
    const results = await Promise.allSettled(promises);
    return results.map(r => r.status === 'fulfilled' ? r.value : null);
  }
}

// Usage
const aggregator = new ParallelAggregator();

aggregator.on('response', ({ provider, response, duration }) => {
  console.log(`${provider}: ${response.content} (${duration}ms)`);
});

const results = await aggregator.executeParallel(request, backends);
```

### Results
- ✅ Parallel streaming from 3 providers
- ✅ Real-time chunk processing
- ✅ Graceful failure handling

### When to Use
- A/B testing different providers
- Ensuring redundancy (if one fails, others succeed)
- Comparing response quality
- Performance benchmarking

---

## Automatic Failover

**Use Case**: Automatically retry failed requests with fallback providers for high availability.

### Problem
Providers fail due to rate limits, network issues, or service outages. Manual intervention is too slow.

### Solution
Custom middleware that automatically retries failed requests with the next provider in a fallback chain.

### Implementation

```typescript
import { Bridge, Router } from '@johnhenry/aimatey-core';

const router = new Router({
  routingStrategy: 'explicit',
  defaultBackend: 'openai',      // Primary
  fallbackStrategy: 'sequential',
  healthCheckInterval: 60000,    // Probe every minute (0 disables)
  enableCircuitBreaker: true,    // Stop hammering a backend that keeps failing
});

router
  .register('openai', openaiBackend)
  .register('anthropic', anthropicBackend)
  .register('groq', groqBackend)
  .register('deepseek', deepseekBackend);

// Order tried after the primary fails
router.setFallbackChain(['anthropic', 'groq', 'deepseek']);

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

// Router has no event emitter - poll its stats instead
const { totalFallbacks } = router.getStats();
for (const info of router.getBackendInfo()) {
  console.log(`${info.name}: healthy=${info.isHealthy} circuit=${info.circuitBreakerState}`);
}
```

:::caution
Fallback applies to `bridge.chat()` only. On the streaming path a failing
backend yields a single `error` chunk - `Router.executeStream()` does not retry.
:::

### Results
- ✅ Automatic failover between 4 providers
- ✅ Health tracking prevents repeated failures
- ✅ Comprehensive audit trail
- ✅ 10 failure scenarios tested

### When to Use
- Production systems requiring high availability
- When provider reliability varies
- Need automatic recovery from failures
- Want comprehensive failure logging

---

## Cost-Optimized Selection

**Use Case**: Minimize API costs while maintaining quality guarantees.

### Problem
AI API costs can be high. Different providers have vastly different pricing, but you still need quality guarantees.

### Solution
Estimate request costs across providers, filter by quality tier, and select the cheapest option.

### Implementation

```typescript
// Provider pricing (per 1K tokens)
const PRICING = {
  deepseek: 0.0002,
  groq: 0.00027,
  anthropic: 0.0008,  // Haiku
  openai: 0.0015      // GPT-3.5
};

// Quality tiers
const QUALITY_TIERS = {
  low: ['deepseek'],
  medium: ['deepseek', 'groq'],
  high: ['groq', 'anthropic', 'openai'],
  ultra: ['anthropic', 'openai']
};

function selectCheapestProvider(
  prompt: string,
  qualityTier: keyof typeof QUALITY_TIERS
) {
  const estimatedTokens = Math.ceil((prompt.length + 200) / 4);
  const eligibleProviders = QUALITY_TIERS[qualityTier];

  let cheapest = eligibleProviders[0];
  let lowestCost = PRICING[cheapest] * estimatedTokens / 1000;

  for (const provider of eligibleProviders) {
    const cost = PRICING[provider] * estimatedTokens / 1000;
    if (cost < lowestCost) {
      cheapest = provider;
      lowestCost = cost;
    }
  }

  return { provider: cheapest, estimatedCost: lowestCost };
}
```

### Results
- ✅ **84% cost savings** vs always using OpenAI
- ✅ Quality tiers ensure acceptable response quality
- ✅ Provider distribution: 50% DeepSeek, 30% Groq, 20% Haiku

### When to Use
- Cost optimization is a priority
- Flexible quality requirements
- Processing high volumes of requests
- Providers offer similar capabilities at different prices

---

## WebSocket Real-Time Streaming

**Use Case**: Bi-directional real-time communication for chat applications.

### Problem
Need real-time communication for chat applications with streaming AI responses.

### Solution
WebSocket server with per-client conversation history and real-time streaming delivery.

### Implementation

```typescript
import WebSocket from 'ws';
import { Bridge } from '@johnhenry/aimatey-core';

const wss = new WebSocket.Server({ port: 8080 });

// Per-client state
const clients = new Map();

wss.on('connection', (ws) => {
  const clientId = `client-${Date.now()}`;
  clients.set(ws, { id: clientId, history: [] });

  ws.on('message', async (data) => {
    const message = JSON.parse(data.toString());
    const client = clients.get(ws);

    if (message.type === 'chat') {
      const bridge = new Bridge(
        new OpenAIFrontendAdapter(),
        backend
      );

      const stream = await bridge.chatStream({
        messages: [{ role: 'user', content: message.content }],
        stream: true
      });

      for await (const chunk of stream) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'chunk',
            data: chunk
          }));
        }
      }

      ws.send(JSON.stringify({ type: 'done' }));
    }
  });
});
```

### Results
- ✅ 15/15 tests passing (100%)
- ✅ **101ms latency** (ping/pong)
- ✅ **19 chunks/sec** streaming rate
- ✅ Multi-client concurrent handling

### When to Use
- Real-time chat applications
- Interactive AI assistants
- Bi-directional communication requirements
- Per-client state management needed

---

## Batch Processing with Rate Limiting

**Use Case**: Process many requests quickly without hitting API rate limits.

### Problem
Need to process many requests quickly while respecting provider rate limits.

### Solution
Queue management with sliding window rate limiting and configurable concurrency.

### Implementation

```typescript
class BatchProcessor {
  private queue: any[] = [];
  private processing = 0;
  private requestTimes: number[] = [];

  constructor(
    private config: {
      concurrency: number;
      rateLimit: { maxRequests: number; perMinutes: number };
    }
  ) {}

  private canMakeRequest(): boolean {
    const now = Date.now();
    const windowStart = now - (this.config.rateLimit.perMinutes * 60 * 1000);

    // Remove old timestamps
    this.requestTimes = this.requestTimes.filter(t => t > windowStart);

    return this.requestTimes.length < this.config.rateLimit.maxRequests;
  }

  async add(request: any): Promise<any> {
    return new Promise((resolve, reject) => {
      this.queue.push({ request, resolve, reject });
      this.processQueue();
    });
  }

  private async processQueue() {
    while (
      this.queue.length > 0 &&
      this.processing < this.config.concurrency &&
      this.canMakeRequest()
    ) {
      const { request, resolve, reject } = this.queue.shift();
      this.processing++;
      this.requestTimes.push(Date.now());

      try {
        const result = await this.execute(request);
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        this.processing--;
        this.processQueue();
      }
    }
  }
}
```

### Results
- ✅ **100% success** on standard config
- ✅ Sliding window rate limiting
- ✅ Configurable concurrency

### When to Use
- High-volume batch processing
- Need to respect rate limits
- Want configurable concurrency
- Processing queued requests

---

## Advanced Middleware Composition

**Use Case**: Build complex request pipelines with multiple middleware layers.

### Implementation

```typescript
import {
  createLoggingMiddleware,
  createRetryMiddleware,
  createCachingMiddleware,
  createCostTrackingMiddleware,
} from '@johnhenry/aimatey-middleware';

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  backend
);

// Build middleware stack (order matters!)
bridge.use(createLoggingMiddleware({ level: 'info' }));
bridge.use(createRetryMiddleware({ maxAttempts: 3 }));
bridge.use(createCachingMiddleware({ ttl: 3600 }));
bridge.use(createCostTrackingMiddleware({ budgetLimit: 100 }));
```

### When to Use
- Production applications
- Need logging, retry, caching, etc.
- Want separation of concerns
- Building reusable pipelines

---

## Continuous Health Monitoring

**Use Case**: Monitor provider health and performance in real-time.

### Implementation

```typescript
class HealthMonitor {
  private metrics = new Map();

  trackRequest(provider: string, duration: number, success: boolean) {
    if (!this.metrics.has(provider)) {
      this.metrics.set(provider, {
        requests: 0,
        failures: 0,
        totalDuration: 0,
      });
    }

    const m = this.metrics.get(provider);
    m.requests++;
    if (!success) m.failures++;
    m.totalDuration += duration;
  }

  getHealth(provider: string) {
    const m = this.metrics.get(provider);
    if (!m) return null;

    return {
      errorRate: m.failures / m.requests,
      avgLatency: m.totalDuration / m.requests,
      healthy: m.failures / m.requests < 0.05, // <5% errors
    };
  }
}
```

### When to Use
- Production monitoring
- Need provider health insights
- Want to track performance
- Building observability

---

## Typed-Decision Confidence Controls

**Use Case**: Run a typed-decision model (Jev, Clef, Ollama's `tev1` / `nimble`, Laya) for classification or gating, and treat its confidence as the control signal it is.

Decision models are fast and cheap, but their confidence measures how concentrated the distribution is, not how often the answer is right. Four published failure modes shape the patterns, all in `@johnhenry/aimatey-patterns` and all default-off (they plug into `bridge.useDecision()`; the ensemble is a backend):

| Failure mode | Evidence | Pattern |
|---|---|---|
| Option-name bias: the head follows an option's *name*, not its definition | Swapping `yes` / `no` definitions flipped Laya's answer 76.9 % of the time (Jev 32.5 %) vs 6.5 % with neutral `0` / `1` keys; rotating names dropped multi-option accuracy 56.4 % to 15.5 % ([arXiv 2609.26758](https://arxiv.org/html/2609.26758)) | `createNeutralOptionKeys()`, measured by `nameInvariance()` |
| Prompt injection in `state` | A planted fake audit opinion flipped a verdict with unchanged high confidence; typed input and "untrusted" markers did not help, screening before the model did ([Check Point](https://blog.checkpoint.com/ai-security/jev-is-not-a-language-model-but-it-breaks-like-one-prompt-injection-against-a-typed-decision-model/)) | `createStateScreening({ screener })` |
| Over-confidence | Laya ECE 0.466, down to 0.081 after one temperature per (question type, option count); Jev about 7 points over-confident on the Decision Index (ECE 0.074) | `createTemperatureScaling()`, fitted with `fitTemperature()`, checked with `calibrationReport()` |
| One model is not enough for the hard cases | Confidence below a bar, or a probability near 0.5, is a signal to ask someone else | `createDecisionEscalation({ fallback, when })`, `decisionBands()`, `createDecisionEnsemble()` |

### Implementation

```typescript
import {
  createDecisionEscalation,
  createEmulatedDecisionBackend,
  createNeutralOptionKeys,
  createTemperatureScaling,
} from '@johnhenry/aimatey-patterns';

bridge
  .useDecision(createTemperatureScaling({ byType: { noul: 1.8 } }))
  .useDecision(createNeutralOptionKeys({ shuffle: true, seed: 7 }))
  .useDecision(
    createDecisionEscalation({
      fallback: createEmulatedDecisionBackend(chatBackend, { model: 'qwen2.5:3b' }),
      when: { any: [{ confidenceBelow: 0.7 }, { probabilityBetween: [0.4, 0.6] }] },
    })
  );
```

Choose `decisionBands` thresholds, and temperatures, from your own labeled runs; there are no built-in numbers. The full walk-through, including tool-call gating, dataset capture and the benchmark harness, is in the [Decisions guide](/guides/decisions/).

### When to Use
- Routing, triage, scoring or gating where a wrong confident answer is costly
- You can label a few hundred past cases to calibrate against
- Input may contain text you do not control

---

## See Also

- [Examples](/examples) - Working code examples
- [Middleware](/packages/middleware) - Available middleware
- [Routing Examples](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/04-routing) - Routing strategies
- [Production Patterns](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/07-advanced-patterns) - Deployment patterns
