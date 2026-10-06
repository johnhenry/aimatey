# Integration Patterns

Production-validated integration patterns for aimatey, discovered and tested through comprehensive integration testing.

> **Validation Source**: 8 advanced test applications (14 total test apps, 50+ scenarios)
> **Test Results**: 100% pass rate across all patterns
> **Status**: Production-ready

## Overview

These patterns emerged from real-world testing scenarios and represent battle-tested approaches to common challenges:

| Pattern | Use Case | Complexity | Status |
|---------|----------|------------|--------|
| [Complexity-Based Routing](#1-complexity-based-routing) | Cost/quality optimization | Moderate | ✅ Production-ready |
| [Parallel Provider Aggregation](#2-parallel-provider-aggregation) | A/B testing, redundancy | Advanced | ✅ Production-ready |
| [Automatic Failover](#3-automatic-failover) | Resilience | Advanced | ✅ Production-ready |
| [Cost-Optimized Selection](#4-cost-optimized-selection) | Cost reduction | Moderate | ✅ Production-ready |
| [WebSocket Real-Time Streaming](#5-websocket-real-time-streaming) | Real-time chat | Advanced | ✅ Production-ready |
| [Batch Processing with Rate Limiting](#6-batch-processing-with-rate-limiting) | High throughput | Advanced | ✅ Production-ready |
| [Advanced Middleware Composition](#7-advanced-middleware-composition) | Request pipeline | Moderate | ✅ Production-ready |
| [Continuous Health Monitoring](#8-continuous-health-monitoring) | Observability | Moderate | ✅ Production-ready |
| [Typed-Decision Confidence Controls](#9-typed-decision-confidence-controls) | Classification and gating with decision models | Moderate | Unit-tested; see the Decisions guide |

---

## 1. Complexity-Based Routing

**Source**: `test-multi-provider-router` (600+ lines, 18 test queries)

### Problem
Different queries require different model capabilities. Routing all queries to the most powerful (and expensive) model wastes money. Routing to cheaper models sacrifices quality on complex tasks.

### Solution
Analyze query complexity and route to appropriate providers based on a complexity score.

### Implementation

```typescript
import { Router } from '@johnhenry/aimatey-core';
import { OpenAIBackendAdapter, AnthropicBackendAdapter, GroqBackendAdapter, DeepSeekBackendAdapter } from '@johnhenry/aimatey-backend';

// Complexity analyzer
function analyzeComplexity(query: string): number {
  let score = 0;

  // Word count (longer = more complex)
  const wordCount = query.split(/\s+/).length;
  score += Math.min(wordCount / 2, 30);

  // Keywords indicating complexity
  const complexKeywords = ['analyze', 'explain', 'compare', 'evaluate', 'synthesize'];
  const hasComplexKeyword = complexKeywords.some(kw => query.toLowerCase().includes(kw));
  if (hasComplexKeyword) score += 20;

  // Technical indicators
  if (/\d+\s*[+\-*/]\s*\d+/.test(query)) score += 15; // Math formulas
  if (/[A-Z]{2,}/.test(query)) score += 10; // Acronyms

  return Math.min(score, 100);
}

// Create backends
const groq = new GroqBackendAdapter({ apiKey: process.env.GROQ_API_KEY });
const deepseek = new DeepSeekBackendAdapter({ apiKey: process.env.DEEPSEEK_API_KEY });
const openai = new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY });

// Router with custom complexity-based routing
const router = new Router({
  routingStrategy: 'custom',
  customRouter: async (request) => {
    const query = request.messages[request.messages.length - 1]?.content || '';
    const complexity = analyzeComplexity(query.toString());

    if (complexity < 25) return 'groq';        // Simple: Fast & cheap
    if (complexity < 50) return 'deepseek';    // Moderate: Cost-effective
    if (complexity < 80) return 'openai';      // Complex: Powerful
    return 'anthropic';                        // Very complex: Most capable
  }
});

router.register('groq', groq);
router.register('deepseek', deepseek);
router.register('openai', openai);
router.register('anthropic', anthropic);
```

### Results
- ✅ Automatic provider selection based on query characteristics
- ✅ Cost optimization while maintaining quality
- ✅ 18 diverse test queries validated

### When to Use
- When you have access to multiple providers with different capabilities/costs
- When query complexity varies significantly
- When you want to optimize for both cost and quality

---

## 2. Parallel Provider Aggregation

**Source**: `test-streaming-aggregator` (700+ lines)

### Problem
You want to compare responses from multiple providers side-by-side, or ensure redundancy by calling multiple providers simultaneously.

### Solution
Execute the same request to multiple providers in parallel and aggregate streaming responses in real-time.

### Implementation

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { GenericFrontendAdapter } from '@johnhenry/aimatey-frontend/generic';
import { OpenAIBackendAdapter, AnthropicBackendAdapter, GroqBackendAdapter } from '@johnhenry/aimatey-backend';
import { EventEmitter } from 'events';

class ParallelAggregator extends EventEmitter {
  async executeParallel(request: any, backends: any[]) {
    const startTime = Date.now();

    // Execute all backends in parallel
    const promises = backends.map(async (backend, index) => {
      const bridge = new Bridge(new GenericFrontendAdapter(), backend);
      const providerName = backend.metadata.name;

      try {
        const response = await bridge.chat(request);
        const duration = Date.now() - startTime;

        this.emit('response', {
          provider: providerName,
          response,
          duration,
          success: true
        });

        return { provider: providerName, response, success: true };
      } catch (error) {
        this.emit('error', {
          provider: providerName,
          error: error.message
        });

        return { provider: providerName, error, success: false };
      }
    });

    // Wait for all to complete (graceful failure handling)
    const results = await Promise.allSettled(promises);

    return results.map(r => r.status === 'fulfilled' ? r.value : { success: false });
  }
}

// Usage
const aggregator = new ParallelAggregator();

aggregator.on('response', ({ provider, response, duration }) => {
  console.log(`${provider}: ${response.content} (${duration}ms)`);
});

const backends = [
  new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY }),
  new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }),
  new GroqBackendAdapter({ apiKey: process.env.GROQ_API_KEY })
];

const results = await aggregator.executeParallel({
  messages: [{ role: 'user', content: 'What is AI?' }]
}, backends);
```

### Results
- ✅ Parallel streaming from 3 providers
- ✅ Real-time chunk processing via EventEmitter
- ✅ Graceful failure handling with Promise.allSettled()

### When to Use
- A/B testing different providers
- Ensuring redundancy (if one fails, others succeed)
- Comparing response quality across providers
- Performance benchmarking

---

## 3. Automatic Failover

**Source**: `test-fallback-resilience` (800+ lines, 10 scenarios)

### Problem
Providers fail due to rate limits, network issues, or service outages. Manual intervention is too slow.

### Solution
Custom middleware that automatically retries failed requests with the next provider in a fallback chain.

### Implementation

> This pattern now ships as `createFailoverMiddleware` in
> `@johnhenry/aimatey-patterns`, with a different config shape
> (`{ fallbacks: BackendAdapter[] }` rather than a chain of registered names).
> Prefer the packaged version; the implementation below is kept to show how the
> pattern works.

```typescript
import type { Middleware } from '@johnhenry/aimatey-types';

function createProviderFailoverMiddleware(config: { chain: string[] }): Middleware {
  const fallbackChain = config.chain;

  // Initialize health tracking
  const healthStatus = new Map<string, { healthy: boolean; failureCount: number }>(
    fallbackChain.map(provider => [provider, { healthy: true, failureCount: 0 }])
  );

  return async (context, next) => {
    let lastError: Error | null = null;

    for (const provider of fallbackChain) {
      const health = healthStatus.get(provider);

      // Skip unhealthy providers
      if (!health?.healthy) {
        console.log(`Skipping ${provider} (marked unhealthy)`);
        continue;
      }

      try {
        console.log(`Attempting with ${provider}...`);

        // Set provider for this attempt. The router's customRouter reads it
        // back out of `metadata.custom` when it picks a backend.
        context.request = {
          ...context.request,
          metadata: {
            ...context.request.metadata,
            custom: { ...context.request.metadata.custom, provider },
          },
        };

        const response = await next();

        // Success! Reset failure count
        health.failureCount = 0;
        console.log(`Success with ${provider}`);

        return response;
      } catch (error) {
        lastError = error as Error;
        health.failureCount++;

        // Mark as unhealthy after 3 failures
        if (health.failureCount >= 3) {
          health.healthy = false;
          console.log(`${provider} marked as unhealthy (${health.failureCount} failures)`);
        }

        console.log(`Failed with ${provider}: ${lastError.message}`);
      }
    }

    throw new Error(`All providers failed. Last error: ${lastError?.message}`);
  };
}

// Usage with Router
import { Bridge, Router } from '@johnhenry/aimatey-core';
import { GenericFrontendAdapter } from '@johnhenry/aimatey-frontend/generic';

const router = new Router({
  routingStrategy: 'custom',
  defaultBackend: 'openai',
  // Honour the provider the middleware picked for this attempt.
  customRouter: async (_request, _available, routingContext) =>
    (routingContext.metadata.provider as string | undefined) ?? null,
});

router.register('openai', openaiBackend);
router.register('anthropic', anthropicBackend);
router.register('groq', groqBackend);
router.register('deepseek', deepseekBackend);

const bridge = new Bridge(new GenericFrontendAdapter(), router);

bridge.use(createProviderFailoverMiddleware({
  chain: ['openai', 'anthropic', 'groq', 'deepseek']
}));
```

### Results
- ✅ Automatic failover between 4 providers
- ✅ Health tracking prevents repeated requests to failing providers
- ✅ Comprehensive audit trail
- ✅ 10 failure scenarios tested

### When to Use
- Production systems requiring high availability
- When provider reliability varies
- When you need automatic recovery from failures
- When you want comprehensive failure logging

---

## 4. Cost-Optimized Selection

**Source**: `test-cost-optimizer` (955+ lines, **84% savings demonstrated**)

### Problem
AI API costs can be high. Different providers have vastly different pricing, but you still need quality guarantees.

### Solution
Estimate request costs across providers, filter by quality tier, and select the cheapest option that meets requirements.

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

function estimateTokens(prompt: string): number {
  // Simple estimation: ~4 chars per token
  return Math.ceil((prompt.length + 200) / 4); // +200 for response
}

function selectCheapestProvider(prompt: string, qualityTier: keyof typeof QUALITY_TIERS) {
  const estimatedTokens = estimateTokens(prompt);
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

// Usage
const { provider, estimatedCost } = selectCheapestProvider(
  'What is the capital of France?',
  'medium'
);

console.log(`Using ${provider} (estimated cost: $${estimatedCost.toFixed(6)})`);
```

### Results
- ✅ **84% cost savings** vs always using OpenAI
- ✅ Provider distribution: 50% DeepSeek, 30% Groq, 20% Haiku
- ✅ Quality tiers ensure acceptable response quality

### When to Use
- When cost optimization is a priority
- When you have flexible quality requirements
- When processing high volumes of requests
- When providers offer similar capabilities at different prices

---

## 5. WebSocket Real-Time Streaming

**Source**: `test-websocket-streaming` (733 lines, **15/15 tests passing**)

### Problem
Need bi-directional real-time communication for chat applications with streaming AI responses.

### Solution
WebSocket server with per-client conversation history and real-time streaming delivery.

### Implementation

```typescript
import WebSocket from 'ws';
import { Bridge } from '@johnhenry/aimatey-core';
import { GenericFrontendAdapter } from '@johnhenry/aimatey-frontend/generic';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend';

const wss = new WebSocket.Server({ port: 8080 });

// Per-client state
const clients = new Map<WebSocket, {
  id: string;
  history: any[];
  currentProvider: string;
}>();

wss.on('connection', (ws) => {
  const clientId = `client-${Date.now()}`;

  clients.set(ws, {
    id: clientId,
    history: [],
    currentProvider: 'openai'
  });

  ws.send(JSON.stringify({ type: 'welcome', clientId }));

  ws.on('message', async (data) => {
    const message = JSON.parse(data.toString());
    const client = clients.get(ws)!;

    if (message.type === 'chat') {
      // Create backend
      const backend = new OpenAIBackendAdapter({
        apiKey: process.env.OPENAI_API_KEY
      });

      const bridge = new Bridge(new GenericFrontendAdapter(), backend);

      try {
        // Stream response
        for await (const chunk of bridge.chatStream({
          messages: [{ role: 'user', content: message.content }]
        })) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
              type: 'chunk',
              data: chunk
            }));
          }
        }

        // Done
        ws.send(JSON.stringify({ type: 'done' }));

        // Save to history
        client.history.push({
          role: 'user',
          content: message.content,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        ws.send(JSON.stringify({
          type: 'error',
          error: error.message
        }));
      }
    }

    if (message.type === 'switch_provider') {
      client.currentProvider = message.provider;
      ws.send(JSON.stringify({
        type: 'provider_switched',
        provider: message.provider
      }));
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });
});
```

### Results
- ✅ 15/15 tests passing (100%)
- ✅ **101ms latency** (ping/pong)
- ✅ **19 chunks/sec** streaming rate
- ✅ Multi-client concurrent handling
- ✅ Provider switching mid-conversation

### When to Use
- Real-time chat applications
- Interactive AI assistants
- Applications requiring bi-directional communication
- When you need per-client state management

---

## 6. Batch Processing with Rate Limiting

**Source**: `test-batch-processor` (**100% success** on standard config)

### Problem
Need to process many requests quickly without hitting API rate limits.

### Solution
Queue management with sliding window rate limiting and configurable concurrency.

### Implementation

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { GenericFrontendAdapter } from '@johnhenry/aimatey-frontend/generic';

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

  async process(requests: any[], executor: (req: any) => Promise<any>) {
    this.queue = [...requests];
    const results: any[] = [];

    while (this.queue.length > 0 || this.processing > 0) {
      // Check rate limit
      if (this.canMakeRequest() && this.processing < this.config.concurrency) {
        const request = this.queue.shift();
        if (!request) break;

        this.processing++;

        // Execute (don't await - parallel processing)
        executor(request)
          .then(result => {
            results.push({ success: true, result });
            this.processing--;
            this.recordRequest();
          })
          .catch(error => {
            results.push({ success: false, error });
            this.processing--;
            this.recordRequest();
          });
      } else {
        // Wait before checking again
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return results;
  }

  private canMakeRequest(): boolean {
    const now = Date.now();
    const windowMs = this.config.rateLimit.perMinutes * 60 * 1000;

    // Remove old requests outside window
    this.requestTimes = this.requestTimes.filter(t => now - t < windowMs);

    return this.requestTimes.length < this.config.rateLimit.maxRequests;
  }

  private recordRequest() {
    this.requestTimes.push(Date.now());
  }
}

// Usage
const processor = new BatchProcessor({
  concurrency: 3,
  rateLimit: { maxRequests: 10, perMinutes: 1 }
});

const requests = Array(15).fill(null).map((_, i) => ({
  messages: [{ role: 'user', content: `Request ${i + 1}` }]
}));

const results = await processor.process(requests, async (req) => {
  const bridge = new Bridge(new GenericFrontendAdapter(), openaiBackend);
  return await bridge.chat(req);
});

console.log(`Completed: ${results.filter(r => r.success).length}/${results.length}`);
```

### Results
- ✅ **Standard config**: 14.87 req/s, **100% success**
- ✅ High throughput: 21.37 req/s, 86.67% success
- ✅ Prevents API throttling
- ✅ Configurable concurrency and rate limits

### When to Use
- Bulk processing of AI requests
- When you need to respect API rate limits
- When you want to maximize throughput
- When processing large batches of data

---

## 7. Advanced Middleware Composition

**Source**: `test-middleware-chain` (11/11 tests, **<10ms overhead**)

### Problem
Need complex request/response processing with validation, rate limiting, formatting, and error handling.

### Solution
Compose multiple middleware in a chain with short-circuiting capabilities.

### Implementation

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { GenericFrontendAdapter } from '@johnhenry/aimatey-frontend/generic';
import type { Middleware } from '@johnhenry/aimatey-types';

// 1. Validation Middleware
function createValidationMiddleware(): Middleware {
  return async (context, next) => {
    if (!context.request.parameters?.model) {
      throw new Error('Missing required field: model');
    }
    if (!context.request.messages || context.request.messages.length === 0) {
      throw new Error('Missing required field: messages');
    }

    return next();
  };
}

// 2. Rate Limiting Middleware
function createRateLimitMiddleware(maxPerMinute: number): Middleware {
  const requests = new Map<string, number[]>();

  return async (context, next) => {
    const userId = (context.request.metadata.custom?.userId as string) ?? 'default';
    const now = Date.now();

    const userRequests = requests.get(userId) || [];
    const recentRequests = userRequests.filter(t => now - t < 60000);

    if (recentRequests.length >= maxPerMinute) {
      throw new Error('Rate limit exceeded');
    }

    recentRequests.push(now);
    requests.set(userId, recentRequests);

    return next();
  };
}

// 3. Response Formatting Middleware
function createFormattingMiddleware(): Middleware {
  return async (context, next) => {
    const response = await next();

    // Standardize response format
    return {
      ...response,
      metadata: {
        ...response.metadata,
        custom: {
          ...response.metadata.custom,
          formatted: true,
          formattedAt: new Date().toISOString()
        }
      }
    };
  };
}

// Compose middleware
const bridge = new Bridge(new GenericFrontendAdapter(), openaiBackend);

bridge
  .use(createValidationMiddleware())
  .use(createRateLimitMiddleware(10))
  .use(createFormattingMiddleware());
```

### Results
- ✅ **11/11 tests passing**
- ✅ **<10ms total overhead** for 6-layer chain
- ✅ **0ms for short-circuits** (validation failures)
- ✅ Modular and reusable

### When to Use
- Production systems with complex requirements
- When you need request validation
- When you need rate limiting per user
- When you want consistent response formatting
- When you need comprehensive error handling

---

## 8. Continuous Health Monitoring

**Source**: `test-provider-health-monitor` (703 lines)

### Problem
Need to know which providers are healthy, their performance characteristics, and when issues occur.

### Solution
Periodic health checks with metrics collection, alerting, and real-time dashboard.

### Implementation

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { GenericFrontendAdapter } from '@johnhenry/aimatey-frontend/generic';

class ProviderHealthMonitor {
  private metrics = new Map<string, {
    responseTime: number[];
    successCount: number;
    failureCount: number;
    lastCheck: Date;
  }>();

  private alerts: any[] = [];

  async runHealthCheck(provider: string, backend: any) {
    const startTime = Date.now();

    try {
      const bridge = new Bridge(new GenericFrontendAdapter(), backend);
      await bridge.chat({
        messages: [{ role: 'user', content: 'Health check' }]
      });

      const duration = Date.now() - startTime;

      // Update metrics
      const metrics = this.metrics.get(provider) || {
        responseTime: [],
        successCount: 0,
        failureCount: 0,
        lastCheck: new Date()
      };

      metrics.responseTime.push(duration);
      metrics.successCount++;
      metrics.lastCheck = new Date();

      // Keep only last 60 samples
      if (metrics.responseTime.length > 60) {
        metrics.responseTime.shift();
      }

      this.metrics.set(provider, metrics);

      // Check for alerts
      const avgResponseTime = metrics.responseTime.reduce((a, b) => a + b, 0) / metrics.responseTime.length;

      if (avgResponseTime > 2000) {
        this.alerts.push({
          type: 'high_latency',
          provider,
          avgResponseTime,
          timestamp: new Date()
        });
      }
    } catch (error) {
      const metrics = this.metrics.get(provider) || {
        responseTime: [],
        successCount: 0,
        failureCount: 0,
        lastCheck: new Date()
      };

      metrics.failureCount++;
      metrics.lastCheck = new Date();
      this.metrics.set(provider, metrics);

      this.alerts.push({
        type: 'failure',
        provider,
        error: error.message,
        timestamp: new Date()
      });
    }
  }

  getHealthReport() {
    const report: any = { providers: {} };

    for (const [provider, metrics] of this.metrics) {
      const successRate = (metrics.successCount / (metrics.successCount + metrics.failureCount)) * 100;
      const avgResponseTime = metrics.responseTime.reduce((a, b) => a + b, 0) / metrics.responseTime.length;

      report.providers[provider] = {
        status: successRate > 90 ? 'healthy' : 'degraded',
        successRate: successRate.toFixed(2),
        avgResponseTime: avgResponseTime.toFixed(0),
        totalRequests: metrics.successCount + metrics.failureCount
      };
    }

    return report;
  }
}

// Usage
const monitor = new ProviderHealthMonitor();

setInterval(async () => {
  await monitor.runHealthCheck('openai', openaiBackend);
  await monitor.runHealthCheck('anthropic', anthropicBackend);

  const report = monitor.getHealthReport();
  console.table(report.providers);
}, 3000);
```

### Results
- ✅ Real-time health monitoring
- ✅ Metrics collection (response time, success rate)
- ✅ Alert generation (high latency, failures)
- ✅ Historical trend analysis

### When to Use
- Production systems requiring high availability
- When you need provider performance insights
- When you want proactive issue detection
- When making informed provider selection decisions

---

## 9. Typed-Decision Confidence Controls

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

Choose `decisionBands` thresholds, and temperatures, from your own labeled runs; there are no built-in numbers. The full walk-through, including tool-call gating, dataset capture and the benchmark harness, is in the [Decisions guide](../packages/aimatey-docs/src/content/docs/guides/decisions.md).

### When to Use
- Routing, triage, scoring or gating where a wrong confident answer is costly
- You can label a few hundred past cases to calibrate against
- Input may contain text you do not control

---

## Pattern Combinations

These patterns can be combined for even more powerful solutions:

**High-Availability Production Setup:**
```typescript
import { createFailoverMiddleware, createCostOptimizer } from '@johnhenry/aimatey-patterns';
import { Bridge } from '@johnhenry/aimatey-core';

// Combine: Failover + Health Monitoring + Cost Optimization
const healthMonitor = new ProviderHealthMonitor();

const { router, middleware: budgetMiddleware } = createCostOptimizer({
  backends: { openai: openaiBackend, anthropic: anthropicBackend, groq: groqBackend },
  budget: { limitUSD: 10, windowMs: 3_600_000 },
});

const bridge = new Bridge(frontend, router)
  .use(createFailoverMiddleware({ fallbacks: [anthropicBackend, groqBackend] }))
  .use(budgetMiddleware);

// Run health checks in background
setInterval(() => healthMonitor.runHealthChecks(), 5000);
```

**Cost-Optimized Batch Processing:**
```typescript
// Combine: Cost Optimization + Batch Processing + Rate Limiting
const processor = new BatchProcessor({ concurrency: 5, rateLimit: { maxRequests: 20, perMinutes: 1 } });

const optimizedRequests = requests.map(req => ({
  ...req,
  provider: selectCheapestProvider(req.prompt, 'medium').provider
}));

await processor.process(optimizedRequests, executeRequest);
```

---

## Next Steps

### Extract as Reusable Components

Five of these patterns already ship as importable utilities in
`@johnhenry/aimatey-patterns`:

- `createComplexityRouter()` - Pattern 1
- `createParallelAggregator()` - Pattern 2
- `createFailoverMiddleware()` - Pattern 3
- `createCostOptimizer()` - Pattern 4
- `createBatchProcessor()` - Pattern 6

Their signatures are the packaged ones, which differ in places from the
illustrative implementations above - check the package's types before porting a
snippet across.

**Still unextracted:**
- `@johnhenry/aimatey-http/websocket` - Pattern 5 (the subpath exists; there is
  no packaged pattern helper around it)
- Enhanced health monitoring integration - Pattern 8

### Contributing Patterns

Have a pattern to share? See [contributing guide](../packages/aimatey-docs/src/content/docs/contributing/index.md) for guidelines on submitting patterns.

---

**Related Documentation:**
- [Performance Benchmarks](./BENCHMARKS.md) - Performance data for these patterns
- [Testing Guide](./TESTING.md) - How these patterns were validated
- [API Reference](./api.md) - API documentation
- [Examples Repository](https://github.com/johnhenry/aimatey-examples) - Full test applications
