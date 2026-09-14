---
title: "Tutorial 03: Multi-Provider Routing"
description: "Beginner tutorial: route requests across multiple AI providers with the Router."
---

Learn how to use the Router to automatically distribute requests across multiple AI providers for load balancing, failover, and cost optimization.

## What You'll Build

A Router that:
- **Load balances** across multiple providers
- **Automatically fails over** when a provider is down
- **Optimizes costs** by routing to cheaper providers

## Time Required

⏱️ **20 minutes**

## Prerequisites

- Completed [Tutorial 02: Using Middleware](/tutorials/beginner/using-middleware)
- At least **2 AI provider API keys** (e.g., OpenAI + Anthropic)

## What is a Router?

A **Router** holds several backend adapters and decides which one executes each
request, according to a **routing strategy**.

The important thing to internalise up front: **a Router is itself a backend
adapter, not a bridge.** It has no frontend adapter, and it has no `chat()`
method. It speaks the Intermediate Representation directly (`execute()` /
`executeStream()`), which is exactly the interface a `Bridge` expects from a
backend. So you build a Router, register backends on it, and then hand it to a
`Bridge`:

```
Your Request (OpenAI format)
     ↓
   Bridge  ← frontend adapter, middleware, chat()/chatStream()
     ↓
   Router  ← a BackendAdapter: strategy, fallback, circuit breaker
  /  |  \
 /   |   \
Backend Backend Backend
OpenAI Anthropic Groq
```

### Why Use a Router?

1. **Load Balancing**: Distribute load evenly across providers
2. **High Availability**: Auto-failover if a provider fails
3. **Cost Optimization**: Route to cheaper providers
4. **Performance**: Use the fastest provider for each request
5. **Testing**: A/B test different providers

## Step 1: Install Packages

You already have `@johnhenry/aimatey-core`, now install more backend adapters:

```bash
npm install @johnhenry/aimatey-backend
```

## Step 2: Create a Basic Router

The `Router` constructor takes **only a config object**. Backends are added
afterwards with `register(name, adapter)`, and the name you give here is the name
you use everywhere else (fallback chains, per-request overrides, stats).

```typescript
import { Bridge, Router } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';

const router = new Router({
  routingStrategy: 'round-robin', // Alternate between providers
});

router
  .register('anthropic', new AnthropicBackendAdapter({
    apiKey: process.env.ANTHROPIC_API_KEY!,
  }))
  .register('openai', new OpenAIBackendAdapter({
    apiKey: process.env.OPENAI_API_KEY!,
  }));

// The router is the bridge's backend. You call the *bridge*.
const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

// First request → anthropic
const response1 = await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }],
});

// Second request → openai
const response2 = await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hi' }],
});

// Third request → anthropic (cycles back)
const response3 = await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hey' }],
});
```

## Routing Strategies

The strategy is set with `routingStrategy` in the config. The full set is
`'explicit'` (the default), `'model-based'`, `'cost-optimized'`,
`'latency-optimized'`, `'round-robin'`, `'random'` and `'custom'`.

### 1. Round-Robin (Load Balancing)

Distributes requests evenly across the healthy backends:

```typescript
const router = new Router({ routingStrategy: 'round-robin' });
router
  .register('backend1', backend1)
  .register('backend2', backend2)
  .register('backend3', backend3);

// Request 1 → backend1
// Request 2 → backend2
// Request 3 → backend3
// Request 4 → backend1 (cycles)
```

**Use case**: Even load distribution, all providers have similar pricing/performance.

### 2. Explicit + Fallback Chain (Failover)

There is no `'priority'` strategy. To get "always try this one, fall back in this
order", pin a `defaultBackend` and set an explicit fallback chain:

```typescript
const router = new Router({
  routingStrategy: 'explicit',
  defaultBackend: 'primary',
  fallbackStrategy: 'sequential', // this is the default
});

router
  .register('primary', primaryBackend)
  .register('secondary', secondaryBackend)
  .register('tertiary', tertiaryBackend);

// Order tried after 'primary' fails
router.setFallbackChain(['secondary', 'tertiary']);
```

Without a fallback chain, `'sequential'` simply tries every other available
backend in registration order.

**Use case**: High availability, redundancy, disaster recovery.

### 3. Random

Selects a random healthy backend for each request:

```typescript
const router = new Router({ routingStrategy: 'random' });
router
  .register('backend1', backend1)
  .register('backend2', backend2)
  .register('backend3', backend3);
```

**Use case**: Simple distribution, testing.

### 4. Model-Based

Route by the model name on the request. The mapping is model → backend name:

```typescript
const router = new Router({ routingStrategy: 'model-based' });

router
  .register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY! }))
  .register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }));

router.setModelMapping({
  'gpt-4': 'openai',
  'gpt-5.6-luna': 'openai',
  'claude-haiku-4-5-20251001': 'anthropic',
});
```

**Use case**: One endpoint that serves several providers' model catalogues.

### 5. Latency- and Cost-Optimized

Both pick a backend from statistics the router has already collected, so they
only start doing something useful once traffic has flowed:

```typescript
// Route to whichever backend has the lowest observed average latency.
// Requires trackLatency (on by default).
const fastest = new Router({ routingStrategy: 'latency-optimized' });

// Route to whichever backend has the lowest observed average cost.
// Requires trackCost, and backends that implement estimateCost().
const cheapest = new Router({ routingStrategy: 'cost-optimized', trackCost: true });
```

With `routingStrategy: 'cost-optimized'` and `trackCost` left off, cost routing
returns nothing and the router falls through to `defaultBackend`, then to the
first available backend.

### 6. Custom Strategy

Write your own routing logic. `customRouter` is **async**, receives the IR
request plus the list of currently-available backend *names*, and returns a
backend name (or `null` to fall through to the default):

```typescript
import type { CustomRoutingFunction } from '@johnhenry/aimatey-types';

const chooseBackend: CustomRoutingFunction = async (request, availableBackends) => {
  const messages = request.messages ?? [];
  const isComplex = messages.length > 10;
  const needsSpeed = (request.parameters?.maxTokens ?? 0) < 100;

  if (needsSpeed && availableBackends.includes('groq')) return 'groq';
  if (isComplex && availableBackends.includes('anthropic')) return 'anthropic';
  return availableBackends[0] ?? null;
};

const router = new Router({
  routingStrategy: 'custom',
  customRouter: chooseBackend,
});
```

**Use case**: Cost optimization, complexity-based routing, performance tuning.

## Step 3: Automatic Failover

Handle provider failures gracefully. Failover is controlled by
`fallbackStrategy`, and unhealthy backends are taken out of rotation by the
health checker and the circuit breaker:

```typescript
import { Bridge, Router } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';
import { GroqBackendAdapter } from '@johnhenry/aimatey-backend/groq';

const router = new Router({
  routingStrategy: 'explicit',
  defaultBackend: 'anthropic',
  fallbackStrategy: 'sequential',
  healthCheckInterval: 60_000,   // probe backends every minute (0 disables)
  enableCircuitBreaker: true,
  circuitBreakerThreshold: 5,    // open after 5 consecutive failures
  circuitBreakerTimeout: 60_000, // then half-open after a minute
});

router
  .register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }))
  .register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY! }))
  .register('groq', new GroqBackendAdapter({ apiKey: process.env.GROQ_API_KEY! }));

router.setFallbackChain(['openai', 'groq']);

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

// If Anthropic is down, this automatically uses OpenAI, then Groq
const response = await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }],
});
```

:::caution[Fallback is non-streaming only]
`Router.executeStream()` does **not** fall back. If the selected backend fails,
the stream yields a single `error` chunk and ends. Only `execute()` (that is,
`bridge.chat()`) walks the fallback chain.
:::

To see which backend served a request, read the router's stats or the per-backend
info rather than subscribing to events — the `Router` class does not expose an
event emitter:

```typescript
console.log(router.getStats().backendStats);
console.log(router.getBackendInfo('anthropic')?.circuitBreakerState);
```

## Step 4: Cost-Based Routing

The built-in `'cost-optimized'` strategy uses observed averages. If you want to
decide up front, from the request itself, use a custom router:

```typescript
import type { CustomRoutingFunction } from '@johnhenry/aimatey-types';

// Provider pricing (per 1K tokens)
const PRICING: Record<string, number> = {
  groq: 0.00027,
  deepseek: 0.0002,
  anthropic: 0.0008,
  openai: 0.0015,
};

const selectCheapestProvider: CustomRoutingFunction = async (request, availableBackends) => {
  // Estimate tokens
  const estimatedTokens = Math.ceil(
    (JSON.stringify(request.messages).length + 200) / 4
  );

  let cheapest: string | null = null;
  let lowestCost = Infinity;

  for (const name of availableBackends) {
    const cost = ((PRICING[name] ?? Infinity) * estimatedTokens) / 1000;
    if (cost < lowestCost) {
      lowestCost = cost;
      cheapest = name;
    }
  }

  return cheapest;
};

const router = new Router({
  routingStrategy: 'custom',
  customRouter: selectCheapestProvider,
});

router
  .register('groq', new GroqBackendAdapter({ apiKey: process.env.GROQ_API_KEY! }))
  .register('deepseek', new DeepSeekBackendAdapter({ apiKey: process.env.DEEPSEEK_API_KEY! }))
  .register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }))
  .register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY! }));

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

// Always routes to cheapest available provider
const response = await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Short query' }],
});
// → Uses deepseek or groq (cheapest)
```

## Step 5: Complexity-Based Routing

Route simple queries to cheap models, complex ones to powerful models. The custom
router sees the **IR** request, so message content is on `request.messages`:

```typescript
import type { CustomRoutingFunction, IRChatRequest } from '@johnhenry/aimatey-types';

function analyzeComplexity(request: IRChatRequest): number {
  const lastMessage = request.messages[request.messages.length - 1];
  const content = JSON.stringify(lastMessage?.content ?? '');

  let score = 0;

  // Length factor
  const wordCount = content.split(/\s+/).length;
  score += Math.min(wordCount / 2, 30);

  // Complexity keywords
  const complexKeywords = ['analyze', 'explain', 'compare', 'evaluate', 'why'];
  if (complexKeywords.some((kw) => content.toLowerCase().includes(kw))) {
    score += 20;
  }

  // Math or code
  if (/\d+\s*[+\-*/]\s*\d+/.test(content)) score += 15;
  if (/```/.test(content)) score += 15;

  return Math.min(score, 100);
}

const byComplexity: CustomRoutingFunction = async (request, availableBackends) => {
  const complexity = analyzeComplexity(request);

  const preferred =
    complexity < 25 ? 'groq'        // Simple queries: fast, cheap
    : complexity < 50 ? 'deepseek'  // Moderate: cost-effective
    : complexity < 80 ? 'openai'    // Complex: powerful
    : 'anthropic';                  // Very complex: most capable

  return availableBackends.includes(preferred) ? preferred : (availableBackends[0] ?? null);
};

const router = new Router({ routingStrategy: 'custom', customRouter: byComplexity });

router
  .register('groq', new GroqBackendAdapter({ apiKey: process.env.GROQ_API_KEY! }))
  .register('deepseek', new DeepSeekBackendAdapter({ apiKey: process.env.DEEPSEEK_API_KEY! }))
  .register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY! }))
  .register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }));

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

// Simple query → groq
await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'What is 2+2?' }],
});

// Complex query → anthropic
await bridge.chat({
  model: 'gpt-4',
  messages: [{
    role: 'user',
    content: 'Analyze the philosophical implications of AI consciousness and compare different theories',
  }],
});
```

## Middleware with Router

Middleware lives on the **bridge**, not on the router — `Router` has no `use()`
method. Because the router sits underneath the middleware stack, every
middleware runs once per request regardless of which backend is chosen:

```typescript
import { createLoggingMiddleware, createRetryMiddleware, createCachingMiddleware }
  from '@johnhenry/aimatey-middleware';

const router = new Router({ routingStrategy: 'round-robin' });
router.register('backend1', backend1).register('backend2', backend2);

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

bridge
  .use(createLoggingMiddleware({ level: 'info' }))
  .use(createRetryMiddleware({ maxAttempts: 3 }))
  .use(createCachingMiddleware({ ttl: 3600 }));
```

## Monitoring Router Health

`checkHealth()` probes backends on demand; `getBackendInfo()` reports the last
known state including the circuit breaker:

```typescript
// Probe every backend
const health = await router.checkHealth();
console.log(health);
// { anthropic: true, openai: true, groq: false }

// Probe one
const openaiHealthy = await router.checkHealth('openai');

// Last known state, with stats and circuit-breaker status
for (const info of router.getBackendInfo()) {
  console.log(
    info.name,
    info.isHealthy ? '✅ Healthy' : '❌ Unhealthy',
    info.circuitBreakerState,
    `${info.stats.averageLatencyMs}ms`
  );
}
```

## Advanced Patterns

### Environment-Based Routing

Use different providers for dev/staging/prod:

```typescript
const router = new Router({
  routingStrategy: 'explicit',
  fallbackStrategy: 'sequential',
});

if (process.env.NODE_ENV === 'production') {
  router
    .register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }))
    .register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY! }));
  router.setFallbackChain(['openai']);
} else {
  // apiKey is required by BackendAdapterConfig even where a local server ignores it
  router.register('ollama', new OllamaBackendAdapter({
    apiKey: '',
    baseURL: 'http://localhost:11434',
  }));
}

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);
```

### Per-Request Provider Selection

Override routing for specific requests with the `backend` request option. It is the
*second* argument to `chat()` / `chatStream()`, not a field on the request body, and it
names the backend as it was registered on the router:

```typescript
const router = new Router({ routingStrategy: 'explicit', defaultBackend: 'openai' });
router.register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY }));
router.register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }));

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

// Use the router's configured routing
const response1 = await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }]
});

// Force a specific backend for this request only
const response2 = await bridge.chat(
  { model: 'gpt-4', messages: [{ role: 'user', content: 'Hello' }] },
  { backend: 'anthropic' } // Force Anthropic
);
```

A name that is not registered throws an `AdapterError` with
`ErrorCode.ROUTING_FAILED` rather than quietly routing somewhere else, so a typo
surfaces immediately. A registered backend that is merely unhealthy or circuit-open
still falls back as usual.

## Troubleshooting

### "No available backend for routing"

Register at least one backend before sending a request — the constructor takes no
backends:

```typescript
// ❌ Bad - no backends registered
const router = new Router({ routingStrategy: 'round-robin' });

// ✅ Good
const router = new Router({ routingStrategy: 'round-robin' });
router.register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY! }));
```

### "Router not falling back"

`fallbackStrategy: 'none'` disables failover. The default is `'sequential'`:

```typescript
const router = new Router({
  fallbackStrategy: 'sequential', // 'none' would rethrow the first error
});
```

Also remember fallback applies to `bridge.chat()` only — a failing stream yields
an error chunk instead of retrying.

### "Routing is inconsistent"

For round-robin, make sure you're reusing the same Router instance — the cursor,
the stats and the circuit-breaker state all live on it:

```typescript
// ✅ Correct - reuse instance
const bridge = new Bridge(new OpenAIFrontendAdapter(), router);
await bridge.chat(request); // backend 1
await bridge.chat(request); // backend 2
await bridge.chat(request); // backend 3

// ❌ Wrong - creates a new router each time
async function chat(request) {
  const router = new Router({ routingStrategy: 'round-robin' }); // Fresh state!
  return await new Bridge(new OpenAIFrontendAdapter(), router).chat(request);
}
```

### "My `middleware` config option does nothing"

There is no `middleware` field on `RouterConfig` or `BridgeConfig`. Register
middleware with `bridge.use()` / `bridge.useStreaming()`.

## Next Steps

Excellent! You now know how to use multi-provider routing.

**Continue learning:**
- [Tutorial 04: Building a Chat API](/tutorials/beginner/building-chat-api) - Create an HTTP server
- [Routing Examples](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/04-routing)
- [Integration Patterns](/patterns) - Production-ready patterns

## Complete Example

```typescript
// multi-provider-router.ts
import 'dotenv/config';
import { Bridge, Router } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';
import { GroqBackendAdapter } from '@johnhenry/aimatey-backend/groq';
import { createLoggingMiddleware } from '@johnhenry/aimatey-middleware';

// Create the router and register backends by name
const router = new Router({
  routingStrategy: 'explicit',
  defaultBackend: 'anthropic',
  fallbackStrategy: 'sequential',
  healthCheckInterval: 60_000,
  enableCircuitBreaker: true,
});

router
  .register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }))
  .register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY! }))
  .register('groq', new GroqBackendAdapter({ apiKey: process.env.GROQ_API_KEY! }));

router.setFallbackChain(['openai', 'groq']);

// The router is the bridge's backend; middleware goes on the bridge
const bridge = new Bridge(new OpenAIFrontendAdapter(), router);
bridge.use(createLoggingMiddleware({ level: 'info' }));

// Use it
async function chat(message: string) {
  const response = await bridge.chat({
    model: 'gpt-4',
    messages: [{ role: 'user', content: message }],
  });
  return response.choices[0].message.content;
}

// Inspect what happened
async function report() {
  const stats = router.getStats();
  console.log(`${stats.totalRequests} requests, ${stats.totalFallbacks} fallbacks`);
  for (const info of router.getBackendInfo()) {
    console.log(`  ${info.name}: healthy=${info.isHealthy} circuit=${info.circuitBreakerState}`);
  }
}

// Test
console.log(await chat('What is aimatey?'));
await report();
```

---

**Ready to build an API?** Continue to [Tutorial 04: Building a Chat API](/tutorials/beginner/building-chat-api)
