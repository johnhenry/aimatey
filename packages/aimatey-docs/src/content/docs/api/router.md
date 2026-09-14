---
title: "Router API"
description: "API reference for the Router class: routing strategies, backend management, health checks, and failover."
---

Complete API reference for the `Router` class - intelligent routing across multiple backend providers.

:::note[Router is a backend, not a bridge]
`Router` implements `BackendAdapter`. It has no frontend adapter and no
`chat()` / `chatStream()` methods - it speaks IR through `execute()` and
`executeStream()`. Give it to a `Bridge` as the backend and call the bridge:

```typescript
const router = new Router({ routingStrategy: 'round-robin' });
router.register('openai', openaiBackend).register('anthropic', anthropicBackend);

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);
const response = await bridge.chat({ model: 'gpt-4', messages: [...] });
```

Middleware belongs to the bridge as well (`bridge.use()`); `Router` has no
`use()` method, and neither `RouterConfig` nor `BridgeConfig` has a `middleware`
field.
:::

## Constructor

### `new Router(config?)`

Creates a new Router. Backends are **not** passed to the constructor - register
them afterwards with [`register()`](#registername-adapter).

**Parameters:**

- `config?: Partial<RouterConfig>` - Router configuration (see [`RouterConfig`](#routerconfig))

**Returns:** `Router` instance

**Example:**

```typescript
import { Bridge, Router } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';

const router = new Router({
  routingStrategy: 'round-robin',
  fallbackStrategy: 'sequential',
});

router
  .register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }))
  .register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY! }));

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);
```

There is also a factory function, `createRouter(config?)`, with the same
signature.

---

## Methods

### `execute(request, signal?)`

Execute an IR request with automatic backend selection and fallback. This is the
`BackendAdapter` entry point - normally you call `bridge.chat()` and the bridge
calls this for you.

**Parameters:**

- `request: IRChatRequest` - Request in Intermediate Representation form
- `signal?: AbortSignal` - Cancellation signal

**Returns:** `Promise<IRChatResponse>`

---

### `executeStream(request, signal?)`

Execute a streaming IR request. It is an async generator method, so the stream is
returned synchronously - there is nothing to `await` before iterating.

**Parameters:**

- `request: IRChatRequest`
- `signal?: AbortSignal`

**Returns:** `IRChatStream` (`AsyncGenerator<IRStreamChunk>`)

:::caution[Streaming does not fall back]
If the selected backend fails mid-stream, `executeStream()` yields a single
`error` chunk and ends. The fallback chain applies to `execute()` only.
:::

---

### `register(name, adapter)`

Register a backend under a name. The name is what you use in fallback chains,
model mappings, per-request overrides and statistics.

**Parameters:**

- `name: string` - Backend identifier
- `adapter: BackendAdapter` - Backend adapter instance

**Returns:** `Router` (for chaining)

**Example:**

```typescript
import { GroqBackendAdapter } from '@johnhenry/aimatey-backend/groq';

router.register('groq', new GroqBackendAdapter({ apiKey: process.env.GROQ_API_KEY! }));
```

---

### `replace(name, adapter)` / `unregister(name)`

Swap a registered backend for another instance, or remove one. Both return the
router for chaining. Unregistering the backend named by `defaultBackend` clears
`defaultBackend` and emits a `routing-config-changed` warning through
`config.onWarning`.

```typescript
router.replace('openai', new OpenAIBackendAdapter({ apiKey: rotatedKey }));
router.unregister('groq');
```

---

### `get(name)` / `has(name)` / `listBackends()`

Inspect the registry.

```typescript
router.get('openai');      // BackendAdapter | undefined
router.has('openai');      // boolean
router.listBackends();     // readonly string[]
```

---

### `setFallbackChain(chain)` / `getFallbackChain()`

Set the order backends are tried in after the primary fails. Every name must
already be registered, otherwise an `AdapterError` with
`ErrorCode.ROUTING_FAILED` is thrown. Without a chain, `'sequential'` fallback
tries every other available backend in registration order.

```typescript
router.setFallbackChain(['openai', 'groq']);
router.getFallbackChain(); // readonly string[]
```

---

### `setModelMapping(mapping)` / `getModelMapping()`

Map model names to backend names, for `routingStrategy: 'model-based'`.

```typescript
router.setModelMapping({
  'gpt-4': 'openai',
  'claude-haiku-4-5-20251001': 'anthropic',
});
```

---

### `selectBackend(request, preferredBackend?)`

Run the routing strategy and return the chosen backend name without executing
anything. Useful in tests.

**Returns:** `Promise<string>` - throws `ErrorCode.NO_BACKEND_AVAILABLE` if nothing is available.

---

### `dispatchParallel(request, options?)`

Send one request to several backends at once.

**Parameters:**

- `request: IRChatRequest`
- `options?: ParallelDispatchOptions`

**Returns:** `Promise<ParallelDispatchResult>`

```typescript
const result = await router.dispatchParallel(irRequest, {
  backends: ['openai', 'anthropic'],
  strategy: 'first',
});

console.log(result.response, result.successfulBackends, result.totalTimeMs);
```

---

### `checkHealth(name?)`

Actively probe backends by calling each adapter's `healthCheck()`. An adapter
that does not implement `healthCheck()` is reported healthy.

**Returns:** `Promise<Record<string, boolean>>`, or `Promise<boolean>` when a name is given.

```typescript
const health = await router.checkHealth();
// { anthropic: true, openai: true, groq: false }

const openaiHealthy = await router.checkHealth('openai');
```

Set `healthCheckInterval` in the config to run this automatically in the
background.

---

### `getBackendInfo(name?)`

Report the last known state of each backend - health, circuit breaker, and stats -
without probing.

**Returns:** `BackendInfo[]`, or `BackendInfo | undefined` when a name is given.

```typescript
for (const info of router.getBackendInfo()) {
  console.log(
    info.name,
    info.isHealthy ? '✅' : '❌',
    info.circuitBreakerState,
    `${info.stats.averageLatencyMs}ms`,
    `${info.stats.successRate}%`
  );
}
```

---

### Circuit breaker controls

```typescript
router.openCircuitBreaker('openai', 30_000); // force open, optionally with a timeout
router.closeCircuitBreaker('openai');
router.resetCircuitBreaker();                // all backends when name is omitted
router.isCircuitBreakerOpen('openai');       // boolean
```

---

### `getStats()` / `resetStats()` / `getBackendStats(name)`

```typescript
const stats = router.getStats();
console.log(stats.totalRequests, stats.totalFallbacks, stats.backendStats);

const openaiStats = router.getBackendStats('openai'); // BackendStats | undefined
router.resetStats();
```

---

### `clone(config)` / `dispose()`

`clone()` returns a new router with merged config and the same backends
registered. `dispose()` stops the background health-check timer and clears the
registry - call it when tearing down.

---

## Types

### `RouterConfig`

Configuration options for Router. Every field is optional and `readonly`.

```typescript
interface RouterConfig {
  routingStrategy?: RoutingStrategy;          // default 'explicit'
  fallbackStrategy?: FallbackStrategy;        // default 'sequential'
  defaultBackend?: string;
  healthCheckInterval?: number;               // ms; 0 disables. default 0
  enableCircuitBreaker?: boolean;             // default false
  circuitBreakerThreshold?: number;           // default 5
  circuitBreakerTimeout?: number;             // ms, default 60000
  trackLatency?: boolean;                     // default true
  trackCost?: boolean;                        // default false
  capabilityBasedRouting?: boolean;           // default false
  optimization?: 'cost' | 'speed' | 'quality' | 'balanced';  // default 'balanced'
  optimizationWeights?: { cost: number; speed: number; quality: number };
  capabilityCacheDuration?: number;           // ms, default 3600000
  customRouter?: CustomRoutingFunction;
  customFallback?: CustomFallbackFunction;
  modelTranslation?: ModelTranslationConfig;
  onWarning?: (warning: IRWarning) => void;
}
```

---

### `RoutingStrategy`

```typescript
type RoutingStrategy =
  | 'explicit'           // Use the backend named on the request (default)
  | 'model-based'        // Route by model name via setModelMapping()
  | 'cost-optimized'     // Lowest observed average cost (needs trackCost)
  | 'latency-optimized'  // Lowest observed average latency (needs trackLatency)
  | 'round-robin'        // Distribute evenly
  | 'random'             // Random selection
  | 'custom';            // Use config.customRouter
```

There is no `'priority'`, `'weighted'`, `'least-latency'` or `'least-cost'`
strategy. Priority-style failover is `'explicit'` + `defaultBackend` +
`setFallbackChain()`.

---

### `FallbackStrategy`

```typescript
type FallbackStrategy =
  | 'none'        // Fail immediately
  | 'sequential'  // Try backends in order until one succeeds (default)
  | 'parallel'    // Try all remaining backends at once, take the first success
  | 'custom';     // Use config.customFallback
```

---

### `CustomRoutingFunction`

```typescript
type CustomRoutingFunction = (
  request: IRChatRequest,
  availableBackends: readonly string[],
  context: RoutingContext
) => Promise<string | null>;
```

**Returns:** the **name** of the backend to use, or `null` to fall through to
`defaultBackend` and then the first available backend. It is async, and it
receives backend names - not adapters, and not indices.

**Example:**

```typescript
import type { CustomRoutingFunction } from '@johnhenry/aimatey-types';

const selectBackend: CustomRoutingFunction = async (request, availableBackends) => {
  const wordCount = request.messages
    .map((m) => JSON.stringify(m.content).split(' ').length)
    .reduce((a, b) => a + b, 0);

  const preferred =
    wordCount < 10 ? 'groq' : wordCount < 100 ? 'openai' : 'anthropic';

  return availableBackends.includes(preferred) ? preferred : (availableBackends[0] ?? null);
};

const router = new Router({ routingStrategy: 'custom', customRouter: selectBackend });
```

---

### `CustomFallbackFunction`

```typescript
type CustomFallbackFunction = (
  request: IRChatRequest,
  failedBackend: string,
  error: AdapterError,
  attemptedBackends: readonly string[],
  availableBackends: readonly string[]
) => Promise<string | null>;
```

---

### `RoutingContext`

```typescript
interface RoutingContext {
  readonly stats: RouterStats;
  readonly metadata: Record<string, unknown>;
  readonly preferredBackend?: string;
}
```

---

### `BackendInfo`

```typescript
interface BackendInfo {
  readonly name: string;
  readonly adapter: BackendAdapter;
  readonly metadata: AdapterMetadata;
  readonly isHealthy: boolean;
  readonly lastHealthCheck?: number;
  readonly circuitBreakerState: 'closed' | 'open' | 'half-open';
  readonly consecutiveFailures: number;
  readonly stats: BackendStats;
}
```

---

### `RouterStats` / `BackendStats`

```typescript
interface RouterStats {
  readonly totalRequests: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  readonly totalFallbacks: number;
  readonly parallelRequests: number;
  readonly backendStats: Record<string, BackendStats>;
  readonly sinceTimestamp: number;
}

interface BackendStats {
  readonly totalRequests: number;
  readonly successfulRequests: number;
  readonly failedRequests: number;
  readonly successRate: number;       // 0-100
  readonly averageLatencyMs: number;
  readonly p50LatencyMs: number;
  readonly p95LatencyMs: number;
  readonly p99LatencyMs: number;
  readonly totalCost?: number;
  readonly averageCost?: number;
}
```

---

### `ParallelDispatchOptions` / `ParallelDispatchResult`

```typescript
interface ParallelDispatchOptions {
  readonly backends?: readonly string[];
  readonly strategy?: ParallelStrategy;     // default 'first'
  readonly timeout?: number;
  readonly cancelOnFirstSuccess?: boolean;  // default true
  readonly customAggregator?: (
    responses: Array<{ backend: string; response: IRChatResponse; latencyMs: number }>
  ) => IRChatResponse;
}

interface ParallelDispatchResult {
  readonly response: IRChatResponse;
  readonly allResponses?: Array<{
    readonly backend: string;
    readonly response: IRChatResponse;
    readonly latencyMs: number;
  }>;
  readonly successfulBackends: readonly string[];
  readonly failedBackends: Array<{ readonly backend: string; readonly error: AdapterError }>;
  readonly totalTimeMs: number;
}
```

---

## Routing Strategies

### Round-Robin

Distributes requests evenly across the available backends.

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

**Use case:** Even load distribution, all providers have similar pricing/performance.

---

### Random

Randomly selects an available backend for each request.

```typescript
const router = new Router({ routingStrategy: 'random' });
router.register('backend1', backend1).register('backend2', backend2);
```

**Use case:** Simple distribution, A/B testing.

---

### Explicit + Fallback Chain (Failover)

The equivalent of a "priority" strategy: always start at one backend, then walk a
chain.

```typescript
const router = new Router({
  routingStrategy: 'explicit',
  defaultBackend: 'primary',
  fallbackStrategy: 'sequential',
});

router
  .register('primary', primaryBackend)
  .register('secondary', secondaryBackend)
  .register('tertiary', tertiaryBackend);

router.setFallbackChain(['secondary', 'tertiary']);
```

**Use case:** High availability, disaster recovery, primary + fallback providers.

---

### Model-Based

```typescript
const router = new Router({ routingStrategy: 'model-based' });
router.register('openai', openaiBackend).register('anthropic', anthropicBackend);

router.setModelMapping({
  'gpt-4': 'openai',
  'gpt-5.6-luna': 'openai',
  'claude-haiku-4-5-20251001': 'anthropic',
});
```

**Use case:** One endpoint serving several providers' model catalogues.

---

### Latency-Optimized

Selects the backend with the lowest observed average latency. Needs
`trackLatency` (on by default) and some traffic history to work from.

```typescript
const router = new Router({
  routingStrategy: 'latency-optimized',
  trackLatency: true,
  healthCheckInterval: 60_000,
});
```

**Use case:** Optimize for response time, latency-sensitive applications.

---

### Cost-Optimized

Selects the backend with the lowest observed average cost. Requires
`trackCost: true` and backends that implement `estimateCost()`; without it the
strategy selects nothing and the router falls through to `defaultBackend`.

```typescript
const router = new Router({ routingStrategy: 'cost-optimized', trackCost: true });
```

**Use case:** Cost optimization, budget-conscious applications.

---

### Custom

```typescript
import type { CustomRoutingFunction } from '@johnhenry/aimatey-types';

const selectBackend: CustomRoutingFunction = async (request, availableBackends) => {
  const wordCount = request.messages
    .map((m) => JSON.stringify(m.content).split(' ').length)
    .reduce((a, b) => a + b, 0);

  if (wordCount < 10) return 'groq';       // Simple → fast/cheap
  if (wordCount < 100) return 'openai';    // Medium → balanced
  return 'anthropic';                      // Complex → powerful
};

const router = new Router({ routingStrategy: 'custom', customRouter: selectBackend });
router
  .register('groq', groqBackend)
  .register('openai', openaiBackend)
  .register('anthropic', anthropicBackend);
```

**Use case:** Application-specific logic, multi-factor routing.

---

## Health Monitoring

### Automatic Health Checks

Set `healthCheckInterval` (milliseconds; `0` disables) and the router probes every
backend in the background, marking failures unhealthy so routing skips them.

```typescript
const router = new Router({
  routingStrategy: 'round-robin',
  healthCheckInterval: 60_000,
  enableCircuitBreaker: true,
  circuitBreakerThreshold: 5,
  circuitBreakerTimeout: 60_000,
});
```

There is no event emitter on `Router`; poll `getBackendInfo()` to observe state.

---

### Manual Health Check

```typescript
const health = await router.checkHealth();

for (const [name, healthy] of Object.entries(health)) {
  if (!healthy) {
    const info = router.getBackendInfo(name);
    console.log(`⚠️  ${name} is unhealthy`);
    console.log(`  Success rate: ${info?.stats.successRate.toFixed(1)}%`);
    console.log(`  Consecutive failures: ${info?.consecutiveFailures}`);
    console.log(`  Circuit breaker: ${info?.circuitBreakerState}`);
  }
}
```

---

## Advanced Examples

### Cost-Optimized Routing (per request)

```typescript
import type { CustomRoutingFunction } from '@johnhenry/aimatey-types';

const PRICING: Record<string, number> = {
  groq: 0.00027,
  deepseek: 0.0002,
  anthropic: 0.0008,
  openai: 0.0015,
};

const cheapest: CustomRoutingFunction = async (request, availableBackends) => {
  const tokens = Math.ceil(JSON.stringify(request.messages).length / 4);

  let best: string | null = null;
  let lowestCost = Infinity;

  for (const name of availableBackends) {
    const cost = ((PRICING[name] ?? Infinity) * tokens) / 1000;
    if (cost < lowestCost) {
      lowestCost = cost;
      best = name;
    }
  }

  return best;
};

const router = new Router({ routingStrategy: 'custom', customRouter: cheapest });
```

---

### Multi-Factor Routing

`availableBackends` already excludes unhealthy and circuit-open backends, so a
custom router only has to weigh the factors it cares about.

```typescript
import type { CustomRoutingFunction } from '@johnhenry/aimatey-types';

const intelligentRouting: CustomRoutingFunction = async (request, availableBackends, context) => {
  if (availableBackends.length === 0) return null;

  const complexity = analyzeComplexity(request);
  const hour = new Date().getHours();
  const isOffPeak = hour < 6 || hour > 22;

  const pick = (name: string) => (availableBackends.includes(name) ? name : null);

  if (complexity > 80) return pick('anthropic') ?? availableBackends[0]!;
  if (isOffPeak && complexity < 30) return pick('groq') ?? availableBackends[0]!;

  // context.stats carries live per-backend statistics if you want to weigh them
  return pick('openai') ?? availableBackends[0]!;
};

const router = new Router({
  routingStrategy: 'custom',
  customRouter: intelligentRouting,
  healthCheckInterval: 60_000,
});
```

---

## Error Handling

### Automatic Fallback

```typescript
const router = new Router({
  routingStrategy: 'explicit',
  defaultBackend: 'primary',
  fallbackStrategy: 'sequential',
});

router.register('primary', primaryBackend).register('fallback', fallbackBackend);
router.setFallbackChain(['fallback']);

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

// If primary fails, this automatically uses fallback
const response = await bridge.chat(request);

// Afterwards, the counters tell you whether a fallback happened
console.log(router.getStats().totalFallbacks);
```

---

### Manual Error Handling

Routing failures surface as `AdapterError` with a routing error code. There is no
`AllBackendsFailedError` class - check `error.code` instead.

```typescript
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';

try {
  const response = await bridge.chat(request);
} catch (error) {
  if (error instanceof AdapterError) {
    switch (error.code) {
      case ErrorCode.ALL_BACKENDS_FAILED:
        console.error('Every backend in the chain failed');
        break;
      case ErrorCode.NO_BACKEND_AVAILABLE:
        console.error('No healthy backend to route to');
        break;
      case ErrorCode.ROUTING_FAILED:
        console.error('Routing rejected the request (e.g. unknown backend name)');
        break;
    }
  }
}
```

`RouterError` (a subclass of `AdapterError`) carries an `attemptedBackends`
array when it is thrown.

---

## See Also

- [Bridge API](/api/bridge) - Single backend bridge
- [Middleware API](/api/middleware) - Middleware reference
- [Tutorial: Multi-Provider](/tutorials/beginner/multi-provider) - Getting started with routing
- [Routing Examples](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/04-routing) - Code examples
