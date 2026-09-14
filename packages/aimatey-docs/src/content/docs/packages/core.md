---
title: "@johnhenry/aimatey-core"
description: "Guide to @johnhenry/aimatey-core: Bridge, Router, and the middleware stack."
---

The foundational package providing the Bridge and Router classes - the heart of aimatey's universal adapter system.

## Installation

```bash
npm install @johnhenry/aimatey-core @johnhenry/aimatey-frontend @johnhenry/aimatey-backend
```

## Overview

`@johnhenry/aimatey-core` provides two main classes:

- **Bridge**: Connects a single frontend adapter to a single backend adapter
- **Router**: Connects a frontend adapter to multiple backend adapters with intelligent routing

## Bridge

### Basic Usage

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new AnthropicBackendAdapter({ apiKey: 'your-key' })
);

const response = await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### Constructor

```typescript
constructor(
  frontend: FrontendAdapter,
  backend: BackendAdapter | Router,
  config?: Partial<BridgeConfig>
)
```

**Parameters:**
- `frontend`: Adapter that defines the input format (OpenAI, Anthropic, etc.)
- `backend`: Adapter that defines the AI provider (OpenAI, Anthropic, Gemini, etc.), or a `Router`
- `config`: Optional `BridgeConfig` - `debug`, `timeout`, `retries`, `defaultModel`, `routerConfig`, `autoRequestId`, `custom`

### Methods

#### chat()

Execute a non-streaming chat completion:

```typescript
async chat(request, options?): Promise<Response>
```

The request and response types come from the frontend adapter - with
`OpenAIFrontendAdapter` they are OpenAI-shaped. To work in IR directly, use
`executeIR()` / `executeIRStream()`.

**Parameters:**
- `request`: Chat completion request in the frontend adapter's format
- `options`: Optional `RequestOptions` (`timeout`, `signal`, `backend`, `metadata`, ...)

**Returns:**
- Promise resolving to the response in the frontend adapter's format

**Example:**
```typescript
const response = await bridge.chat({
  model: 'gpt-4',
  messages: [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'What is 2+2?' }
  ],
  temperature: 0.7,
  max_tokens: 100
});

console.log(response.choices[0].message.content); // "4"
```

#### chatStream()

Execute a streaming chat completion:

```typescript
async *chatStream(request, options?): AsyncGenerator<StreamChunk, void, undefined>
```

**Parameters:**
- `request`: Chat completion request with `stream: true`

**Returns:**
- An async generator of response chunks in the frontend adapter's format.
  `chatStream()` is an async generator, so the call itself is not awaited.

**Example:**
```typescript
const stream = bridge.chatStream({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Count to 5' }],
  stream: true
});

for await (const chunk of stream) {
  const content = chunk.choices?.[0]?.delta?.content;
  if (content) {
    process.stdout.write(content);
  }
}
```

#### use()

Add middleware to the request/response pipeline:

```typescript
use(middleware: Middleware): Bridge
```

**Parameters:**
- `middleware`: Middleware function

**Returns:**
- The bridge, so calls can be chained

**Example:**
```typescript
import { createLoggingMiddleware, createCachingMiddleware } from '@johnhenry/aimatey-middleware';

bridge
  .use(createLoggingMiddleware({ level: 'info' }))
  .use(createCachingMiddleware({ ttl: 3_600_000 })); // ttl is milliseconds
```

### Properties

#### frontend

The frontend adapter instance (read-only):

```typescript
readonly frontend: FrontendAdapter
```

#### backend

The backend adapter or router instance (read-only):

```typescript
readonly backend: BackendAdapter | Router
```

Both are readonly - to change adapters, construct a new `Bridge`. `clone(config)`
returns a new bridge with the same adapters and a merged configuration.

## Router

`Router` is itself a `BackendAdapter`: it spreads requests over several registered
backends and is handed to a `Bridge` in place of a single backend adapter. It has
no frontend adapter of its own, and no `chat()`, `chatStream()`, `use()` or `on()`.

### Basic Usage

```typescript
import { Bridge, Router } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';

const router = new Router({ routingStrategy: 'round-robin' });

router.register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }));
router.register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY }));

// Requests are made through a Bridge, with the router as its backend
const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

const response = await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

### Constructor

```typescript
constructor(config?: Partial<RouterConfig>)
```

**Parameters:**
- `config`: Router configuration. Backends are not passed here - register them
  afterwards with `router.register(name, adapter)`.

### RouterConfig

```typescript
interface RouterConfig {
  routingStrategy?: RoutingStrategy;
  fallbackStrategy?: 'none' | 'sequential' | 'parallel' | 'custom';
  defaultBackend?: string;
  healthCheckInterval?: number;
  enableCircuitBreaker?: boolean;
  circuitBreakerThreshold?: number;
  circuitBreakerTimeout?: number;
  trackLatency?: boolean;
  trackCost?: boolean;
  capabilityBasedRouting?: boolean;
  optimization?: 'cost' | 'speed' | 'quality' | 'balanced';
  customRouter?: CustomRoutingFunction;
  customFallback?: CustomFallbackFunction;
}
```

**Fields:**
- `routingStrategy`: How a backend is chosen (default: `'explicit'`)
- `fallbackStrategy`: What happens when the chosen backend fails (default: `'none'`)
- `defaultBackend`: Backend used when the strategy makes no other choice
- `healthCheckInterval`: Background health check period in ms (`0` disables)
- `enableCircuitBreaker` / `circuitBreakerThreshold` / `circuitBreakerTimeout`: circuit breaker
- `customRouter`: Async function returning a backend *name* (used with `'custom'`)

### Routing Strategies

`RoutingStrategy` is one of `'explicit'`, `'model-based'`, `'cost-optimized'`,
`'latency-optimized'`, `'round-robin'`, `'random'` or `'custom'`. There is no
`'priority'` or `'weighted'` strategy.

#### Explicit

Uses `defaultBackend`, or the backend named per request via
`bridge.chat(request, { backend: 'anthropic' })`:

```typescript
const router = new Router({ routingStrategy: 'explicit', defaultBackend: 'openai' });
```

#### Model-based

Routes on the requested model name, using the router's model mapping:

```typescript
const router = new Router({ routingStrategy: 'model-based' });
router.setModelMapping({
  'gpt-4': 'openai',
  'claude-haiku-4-5-20251001': 'anthropic'
});
```

#### Round-Robin

Distributes requests evenly across registered backends:

```typescript
const router = new Router({ routingStrategy: 'round-robin' });
router.register('openai', backend1);
router.register('anthropic', backend2);

// Request 1 → openai
// Request 2 → anthropic
// Request 3 → openai (cycles)
```

#### Random

Randomly selects a backend for each request:

```typescript
const router = new Router({ routingStrategy: 'random' });
```

#### Cost- and latency-optimized

Picks the cheapest or fastest healthy backend, using the statistics the router
collects:

```typescript
const router = new Router({ routingStrategy: 'cost-optimized', trackCost: true });
const fast = new Router({ routingStrategy: 'latency-optimized', trackLatency: true });
```

#### Fallback ordering

Ordered failover replaces the old "priority" strategy: set a fallback chain and a
sequential fallback strategy.

```typescript
const router = new Router({
  routingStrategy: 'explicit',
  defaultBackend: 'primary',
  fallbackStrategy: 'sequential'
});

router.register('primary', primaryBackend);
router.register('secondary', secondaryBackend);
router.register('tertiary', tertiaryBackend);

router.setFallbackChain(['primary', 'secondary', 'tertiary']);
```

#### Custom

Implement your own routing logic. The function is async and returns the *name* of
a backend (or `null` to fall through to the default strategy):

```typescript
const router = new Router({
  routingStrategy: 'custom',
  customRouter: async (request, availableBackends) => {
    const messageLength = JSON.stringify(request.messages).length;

    if (messageLength < 100) return 'cheap';
    if (messageLength < 500) return 'fast';
    return availableBackends.includes('powerful') ? 'powerful' : null;
  }
});

router.register('cheap', cheapBackend);
router.register('fast', fastBackend);
router.register('powerful', powerfulBackend);
```

### Methods

Because `Router` is a `BackendAdapter`, it exposes `execute()` and
`executeStream()` rather than `chat()` / `chatStream()`, and it has no middleware
stack or event emitter of its own - register middleware on the `Bridge` that owns
it. Beyond the adapter interface it adds:

- `register(name, adapter)` / `replace(name, adapter)` / `unregister(name)`
- `get(name)`, `has(name)`, `listBackends()`
- `getBackendInfo()` / `getBackendInfo(name)`
- `setFallbackChain(chain)` / `getFallbackChain()`
- `setModelMapping(mapping)` / `setModelPatterns(patterns)`
- `selectBackend(request, preferredBackend?)`
- `dispatchParallel(request, options?)`
- `checkHealth()` / `checkHealth(name)`
- `openCircuitBreaker(name, timeoutMs?)` / `closeCircuitBreaker(name)` / `resetCircuitBreaker(name?)`
- `getStats()` / `getBackendStats(name)` / `resetStats()`

#### checkHealth()

Check the health of every backend, or one by name:

```typescript
async checkHealth(): Promise<Record<string, boolean>>
async checkHealth(name: string): Promise<boolean>
```

**Example:**
```typescript
const health = await router.checkHealth();
console.log(health);
/*
{
  anthropic: true,
  openai: true,
  groq: false
}
*/

// Richer per-backend state, including latency and circuit breaker
for (const info of router.getBackendInfo()) {
  console.log(info.name, info.isHealthy, info.circuitBreakerState, info.stats.averageLatencyMs);
}
```

#### dispatchParallel()

Send one request to several backends at once:

```typescript
const result = await router.dispatchParallel(request, {
  backends: ['openai', 'anthropic'],
  strategy: 'first'
});

console.log(result.response.message.content);
console.log('Answered by:', result.successfulBackends);
```

### Monitoring

`Router` has no event emitter - there is no `router.on(...)`. Observe it by
polling instead:

```typescript
// Health, on demand or after a failure
const health = await router.checkHealth();

// Per-backend request counts, latencies, failures and circuit breaker state
for (const info of router.getBackendInfo()) {
  if (!info.isHealthy) {
    console.log(`${info.name} unhealthy: ${info.consecutiveFailures} consecutive failures`);
  }
}

// Aggregate counters, including fallbacks
const stats = router.getStats();
console.log(`${stats.totalFallbacks} fallbacks out of ${stats.totalRequests} requests`);
```

## Middleware System

Both Bridge and Router support middleware for intercepting and transforming requests/responses.

### Middleware Interface

```typescript
type Middleware = (
  context: MiddlewareContext,
  next: () => Promise<IRChatResponse>
) => Promise<IRChatResponse>;

interface MiddlewareContext {
  request: IRChatRequest;                    // inspect and replace to modify
  readonly isStreaming: boolean;
  readonly backend?: BackendAdapter;
  readonly backendName?: string;
  readonly state: Record<string, unknown>;   // scratch space shared between middleware
  readonly config: Record<string, unknown>;
  readonly signal?: AbortSignal;
}
```

### Creating Custom Middleware

```typescript
import type { Middleware } from '@johnhenry/aimatey-types';

function createTimingMiddleware(): Middleware {
  return async (context, next) => {
    const start = Date.now();
    const response = await next();
    const duration = Date.now() - start;

    console.log(`Request took ${duration}ms`);

    return response;
  };
}

bridge.use(createTimingMiddleware());
```

### Middleware Order

Middleware executes in registration order (first added runs first, as the
outermost layer):

```typescript
bridge.use(middleware1); // Runs 1st
bridge.use(middleware2); // Runs 2nd
bridge.use(middleware3); // Runs 3rd

// Request → middleware1 → middleware2 → middleware3 → Backend
// Response ← middleware1 ← middleware2 ← middleware3 ← Backend
```

**Best practice order:**
1. Logging (first - sees everything)
2. Retry (second - handles failures)
3. Caching (third - caches successful responses)
4. Transform (fourth - modifies data)

## Error Handling

### Error Types

There is no `BridgeError`. Every error thrown by a bridge or router derives from
`AdapterError` in `@johnhenry/aimatey-errors`, which carries a `code`, a
`category` and an `isRetryable` flag. The specialized subclasses are
`AuthenticationError`, `AuthorizationError`, `RateLimitError`, `ValidationError`,
`ProviderError`, `AdapterConversionError`, `NetworkError`, `StreamError`,
`RouterError` and `MiddlewareError`.

**Common error codes:**
- `INVALID_API_KEY`: Authentication failed
- `RATE_LIMIT_EXCEEDED`: Rate limit exceeded
- `PROVIDER_ERROR`: The provider API returned an error
- `CONNECTION_TIMEOUT` / `PROVIDER_TIMEOUT`: Request timed out
- `ROUTING_FAILED`: No backend could serve the request

### Handling Errors

```typescript
import { AdapterError, ErrorCode, RateLimitError } from '@johnhenry/aimatey-errors';

try {
  const response = await bridge.chat(request);
} catch (error) {
  if (error instanceof RateLimitError) {
    console.log('Rate limited, retrying...');
  } else if (error instanceof AdapterError) {
    switch (error.code) {
      case ErrorCode.INVALID_API_KEY:
        console.log('Invalid API key');
        break;
      case ErrorCode.CONNECTION_TIMEOUT:
      case ErrorCode.PROVIDER_TIMEOUT:
        console.log('Request timed out');
        break;
      default:
        console.log('Adapter error:', error.code, error.message);
    }
  }
}
```

## TypeScript Types

### Key Interfaces

```typescript
// Request - model and sampling options live under `parameters`, metadata is required
interface IRChatRequest {
  messages: readonly IRMessage[];
  parameters?: IRParameters;   // { model, temperature, maxTokens, topP, ... }
  metadata: IRMetadata;        // { requestId, timestamp, ... }
  tools?: readonly IRTool[];
  stream?: boolean;
  // ... toolChoice, responseFormat, streamMode
}

// Response - one message, no `choices` array
interface IRChatResponse {
  message: IRMessage;
  finishReason: FinishReason;
  usage?: IRUsage;             // { promptTokens, completionTokens, totalTokens }
  metadata: IRMetadata;
  raw?: Record<string, unknown>;
}

// Message
interface IRMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | readonly MessageContent[];
  name?: string;
  metadata?: Record<string, unknown>;
}

// Streaming chunk - a discriminated union on `type`
type IRStreamChunk =
  | StreamStartChunk
  | StreamContentChunk
  | StreamToolUseChunk
  | StreamMetadataChunk
  | StreamDoneChunk
  | StreamErrorChunk;
```

See [IR Format Documentation](/guides/architecture/ir-format) for complete type definitions.

## Best Practices

### 1. Reuse Instances

Create Bridge/Router instances once and reuse:

```typescript
// ✅ Good - reuse instance
const bridge = new Bridge(frontend, backend);

async function chat(message) {
  return await bridge.chat({ model: 'gpt-4', messages: [{ role: 'user', content: message }] });
}

// ❌ Bad - creates new instance each call
async function chat(message) {
  const bridge = new Bridge(frontend, backend);
  return await bridge.chat({ model: 'gpt-4', messages: [{ role: 'user', content: message }] });
}
```

### 2. Use TypeScript

Take advantage of full type safety:

```typescript
import type { IRChatRequest, IRChatResponse } from '@johnhenry/aimatey-types';

async function chat(request: IRChatRequest): Promise<IRChatResponse> {
  return await bridge.chat(request);
}
```

### 3. Handle Errors

Always wrap calls in try-catch:

```typescript
try {
  const response = await bridge.chat(request);
  return response.choices[0].message.content; // OpenAI-shaped, from the OpenAI frontend
} catch (error) {
  console.error('Chat failed:', error);
  throw error;
}
```

### 4. Use Middleware

Add production features with middleware:

```typescript
import { createLoggingMiddleware, createRetryMiddleware, createCachingMiddleware } from '@johnhenry/aimatey-middleware';

bridge.use(createLoggingMiddleware({ level: 'info' }));
bridge.use(createRetryMiddleware({ maxAttempts: 3 }));
bridge.use(createCachingMiddleware({ ttl: 3_600_000 })); // ttl is milliseconds
```

## See Also

- [Frontend Adapters](/packages/frontend) - Available frontend adapters
- [Backend Adapters](/packages/backend) - Available backend adapters
- [Middleware](/packages/middleware) - Available middleware
- [IR Format](/guides/architecture/ir-format) - Intermediate representation details
- [Tutorial: Simple Bridge](/tutorials/beginner/simple-bridge) - Step-by-step guide
