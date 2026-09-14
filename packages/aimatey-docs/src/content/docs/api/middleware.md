---
title: "Middleware API"
description: "API reference for all built-in middleware factories and the Middleware interface."
---

Complete API reference for all built-in middleware and the Middleware interface.

## Middleware Interface

All middleware is a plain async function with this signature:

```typescript
type MiddlewareNext = () => Promise<IRChatResponse>;

type Middleware = (
  context: MiddlewareContext,
  next: MiddlewareNext
) => Promise<IRChatResponse>;

interface MiddlewareContext {
  /** The IR request being processed - middleware can inspect and modify it */
  request: IRChatRequest;

  /** Whether this is a streaming request */
  readonly isStreaming: boolean;

  /** Backend that will process the request (available after routing) */
  readonly backend?: BackendAdapter;

  /** Backend name/identifier */
  readonly backendName?: string;

  /** Shared state object for passing data between middleware */
  readonly state: Record<string, unknown>;

  /** Configuration from the bridge */
  readonly config: Record<string, unknown>;

  /** Abort signal for request cancellation */
  readonly signal?: AbortSignal;
}
```

Work before `await next()` runs on the way in, work after it runs on the way
out. `next()` takes no arguments - the request is read and modified through
`context.request`.

Stream-native middleware is a separate type, `StreamingMiddleware`, registered
with `bridge.useStreaming()`:

```typescript
type StreamingMiddlewareNext = () => Promise<IRChatStream>;

type StreamingMiddleware = (
  context: StreamingMiddlewareContext,
  next: StreamingMiddlewareNext
) => Promise<IRChatStream>;
```

---

## Built-in Middleware

### Logging Middleware

#### `createLoggingMiddleware(config)`

Logs requests and responses for debugging and monitoring.

**Parameters:** `config: LoggingConfig`

```typescript
interface LoggingConfig {
  /** Minimum log level: 'debug' | 'info' | 'warn' | 'error' (default: 'info') */
  level?: LogLevel;

  /** Log request bodies (default: true) */
  logRequests?: boolean;

  /** Log response bodies (default: true) */
  logResponses?: boolean;

  /** Log errors (default: true) */
  logErrors?: boolean;

  /** Redact sensitive data such as API keys and tokens (default: true) */
  sanitize?: boolean;

  /** Custom logger (default: console) */
  logger?: Logger;

  /** Custom log prefix */
  prefix?: string;
}

interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}
```

**Returns:** `Middleware`

**Example:**

```typescript
import { createLoggingMiddleware } from '@johnhenry/aimatey-middleware';

const logger = createLoggingMiddleware({
  level: 'info',
  logRequests: true,
  logResponses: true,
  sanitize: true,
  prefix: '[aimatey]'
});

bridge.use(logger);
```

**Output:**

```
[INFO] Request: POST /chat/completions
[INFO] Model: gpt-4
[INFO] Messages: 1
[INFO] Response: 200 OK (1.2s)
[INFO] Tokens: 50 (cost: $0.0015)
```

---

### Caching Middleware

#### `createCachingMiddleware(config)`

Caches responses to reduce API calls and costs.

**Parameters:** `config: CachingConfig`

```typescript
interface CachingConfig {
  /** Time-to-live in milliseconds (default: 3600000 - one hour) */
  ttl?: number;

  /** Maximum cache size (default: 1000) */
  maxSize?: number;

  /** Storage implementation (default: an in-memory LRU store) */
  storage?: CacheStorage;

  /** Custom cache key function; takes over caller scoping entirely */
  keyGenerator?: (request: IRChatRequest) => string;

  /** Caller identity mixed into the default cache key, overriding metadata.principal */
  scopeKey?: string | ((request: IRChatRequest) => string | undefined);

  /** What to do with a request that has no caller identity (default: 'bypass') */
  unidentified?: 'bypass' | 'share';

  /** Cache streaming responses too (default: false) */
  cacheStreaming?: boolean;
}

interface CacheStorage {
  get(key: string): Promise<IRChatResponse | undefined>;
  set(key: string, value: IRChatResponse, ttl?: number): Promise<void>;
  has(key: string): Promise<boolean>;
  delete(key: string): Promise<boolean>;
  clear(): Promise<void>;
}
```

`storage` is an object implementing `CacheStorage`, never a string - there is no
built-in Redis or file backend. To cache in Redis, implement the five methods
above against your own client.

**Returns:** `Middleware`

**Example:**

```typescript
import { createCachingMiddleware } from '@johnhenry/aimatey-middleware';

const cache = createCachingMiddleware({
  ttl: 3_600_000,      // one hour, in milliseconds
  maxSize: 1000        // Max 1000 items
});

bridge.use(cache);

// First request - cache miss
await bridge.chat({ model: 'gpt-4', messages }, { principal: userId }); // ~1200ms

// Same prompt, same caller - cache hit
await bridge.chat({ model: 'gpt-4', messages }, { principal: userId }); // ~0.5ms ⚡

// Same prompt, different caller - cache miss, and rightly so
await bridge.chat({ model: 'gpt-4', messages }, { principal: otherUserId });
```

**Cache entries belong to a caller.** The key mixes in a scope taken from
`scopeKey`, or failing that from the request's `metadata.principal` (set per
request with `bridge.chat(request, { principal })`). A request with neither is
**not cached at all**: it is passed through with a `cache-bypassed` warning on
`metadata.warnings`, so a shared cache can never hand one user's completion to
another.

A single-tenant deployment - one process, one audience, where sharing every
entry is the reason caching was switched on - opts back into unscoped sharing:

```typescript
bridge.use(createCachingMiddleware({ ttl: 3_600_000, unidentified: 'share' }));
```

**Cache statistics:** the factory returns a bare `Middleware` function, so there
is no `cache.getStats()`. Track hits yourself by wrapping a `CacheStorage`:

```typescript
let hits = 0;
let misses = 0;

const counting: CacheStorage = {
  async get(key) {
    const value = await inner.get(key);
    value === undefined ? misses++ : hits++;
    return value;
  },
  set: (key, value, ttl) => inner.set(key, value, ttl),
  has: (key) => inner.has(key),
  delete: (key) => inner.delete(key),
  clear: () => inner.clear()
};

bridge.use(createCachingMiddleware({ storage: counting }));
```

---

### Retry Middleware

#### `createRetryMiddleware(config)`

Automatically retries failed requests with exponential backoff.

**Parameters:** `config: RetryConfig`

```typescript
interface RetryConfig {
  /** Maximum attempts, including the first (default: 3) */
  maxAttempts?: number;

  /** Initial delay in ms (default: 1000) */
  initialDelay?: number;

  /** Maximum delay in ms (default: 30000) */
  maxDelay?: number;

  /** Backoff multiplier (default: 2) */
  backoffMultiplier?: number;

  /** Add random jitter to the delay (default: true) */
  useJitter?: boolean;

  /** Which errors to retry (default: retryable adapter errors) */
  shouldRetry?: (error: unknown, attempt: number) => boolean;

  /** Called before each retry */
  onRetry?: (error: unknown, attempt: number, delay: number) => void;
}
```

Retryability is decided by `shouldRetry`, not by lists of error names or status
codes. `createRetryPredicate(['rate_limit', 'network', 'server'])` builds one
from the shipped `isRateLimitError` / `isNetworkError` / `isServerError` helpers.

**Returns:** `Middleware`

**Example:**

```typescript
import { createRetryMiddleware, createRetryPredicate } from '@johnhenry/aimatey-middleware';

const retry = createRetryMiddleware({
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  backoffMultiplier: 2,
  useJitter: true,
  shouldRetry: createRetryPredicate(['rate_limit', 'network', 'server']),
  onRetry: (error, attempt, delay) => {
    console.log(`Retry ${attempt}/3 after ${delay}ms: ${(error as Error).message}`);
  }
});

bridge.use(retry);
```

**Console output (on failure):**

```
[WARN] Request failed: RATE_LIMIT_EXCEEDED
[INFO] Retry 1/3 after 1000ms
[INFO] Retry 2/3 after 2000ms
[INFO] Request succeeded on attempt 3
```

---

### Transform Middleware

#### `createTransformMiddleware(config)`

Transforms requests and responses on-the-fly.

**Parameters:** `config: TransformConfig`

```typescript
interface TransformConfig {
  /** Transform the request before sending */
  transformRequest?: (request: IRChatRequest) => IRChatRequest | Promise<IRChatRequest>;

  /** Transform the response after receiving */
  transformResponse?: (response: IRChatResponse) => IRChatResponse | Promise<IRChatResponse>;

  /** Transform the message array before sending */
  transformMessages?: (
    messages: readonly IRMessage[]
  ) => readonly IRMessage[] | Promise<readonly IRMessage[]>;
}
```

There is no `transformChunk` - this middleware runs on the non-streaming path.
Use `bridge.useStreaming()` with a `StreamingMiddleware` to rewrite chunks.

**Returns:** `Middleware`

**Example:**

```typescript
import { createTransformMiddleware } from '@johnhenry/aimatey-middleware';

const transform = createTransformMiddleware({
  transformRequest: (request) => {
    // Add system message to all requests
    return {
      ...request,
      messages: [
        { role: 'system', content: 'Be concise and helpful.' },
        ...request.messages
      ]
    };
  },
  transformResponse: (response) => {
    // Uppercase the assistant's reply
    const { content } = response.message;
    return {
      ...response,
      message: {
        ...response.message,
        content: typeof content === 'string' ? content.toUpperCase() : content
      }
    };
  }
});

bridge.use(transform);
```

---

### Cost Tracking Middleware

#### `createCostTrackingMiddleware(config)`

Tracks API costs and fires callbacks when spending thresholds are crossed.

**Parameters:** `config: CostTrackingConfig`

```typescript
interface CostTrackingConfig {
  /** Where cost records are written (default: a new InMemoryCostStorage) */
  storage?: CostStorage;

  /** Per-provider pricing overrides */
  providers?: Record<string, ProviderPricing>;

  /** Per-model pricing overrides (model id or RegExp) */
  models?: ModelPricing[];

  /** Called for every calculated cost */
  onCost?: (cost: CostCalculation) => void | Promise<void>;

  /** Called when a threshold below is crossed */
  onThresholdExceeded?: (cost: CostCalculation, threshold: number) => void | Promise<void>;

  /** Thresholds in USD */
  requestThreshold?: number;
  hourlyThreshold?: number;
  dailyThreshold?: number;

  /** Log each cost to the console (default: false) */
  logCosts?: boolean;

  /** Attach the cost to response metadata (default: true) */
  includeInMetadata?: boolean;
}

interface ProviderPricing {
  inputCostPer1M: number;   // USD per 1M input tokens
  outputCostPer1M: number;  // USD per 1M output tokens
  cachedInputCostPer1M?: number;
  imageInputCostPer1M?: number;
}
```

**Returns:** `Middleware`

**Example:**

```typescript
import {
  createCostTrackingMiddleware,
  getCostStats,
  InMemoryCostStorage
} from '@johnhenry/aimatey-middleware';

const storage = new InMemoryCostStorage();

const costTracker = createCostTrackingMiddleware({
  storage,
  dailyThreshold: 100,   // warn once $100/day is passed
  hourlyThreshold: 10,
  onThresholdExceeded: (cost, threshold) => {
    console.error(`Spending passed $${threshold} (last request $${cost.totalCost.toFixed(4)})`);
  }
});

bridge.use(costTracker);

// Statistics come from the storage, not from the middleware
const stats = await getCostStats(storage, 24);
console.log(`Total (24h): $${stats.total.toFixed(2)}`);
console.log('By provider:', stats.byProvider);
console.log('By model:', stats.byModel);
```

---

### OpenTelemetry Middleware

#### `createOpenTelemetryMiddleware(config)`

Adds distributed tracing with OpenTelemetry. This factory is **async** - it
resolves the optional `@opentelemetry/*` packages at call time and throws if they
are not installed, so it must be awaited.

**Parameters:** `config: OpenTelemetryConfig`

```typescript
interface OpenTelemetryConfig {
  /** Service name reported on spans (default: 'ai-matey') */
  serviceName?: string;

  /** Service version reported on spans */
  serviceVersion?: string;

  /** Tracer name (default: 'ai-matey-tracer') */
  tracerName?: string;

  /** OTLP/HTTP traces endpoint */
  endpoint?: string;

  /** Extra headers sent to the exporter */
  headers?: Record<string, string>;

  /** Extra resource attributes */
  resourceAttributes?: Record<string, string>;

  /** Sampling rate, 0-1 (default: 1.0) */
  samplingRate?: number;

  /** Export spans, rather than only creating them (default: true) */
  exportSpans?: boolean;

  /** Exporter timeout in ms */
  exporterTimeoutMillis?: number;

  /** Batch span processor tuning */
  batchSpanProcessorConfig?: BatchSpanProcessorConfig;
}
```

**Returns:** `Promise<Middleware>`

**Example:**

```typescript
import { createOpenTelemetryMiddleware } from '@johnhenry/aimatey-middleware';

const tracing = await createOpenTelemetryMiddleware({
  serviceName: 'my-ai-service',
  endpoint: 'http://localhost:4318/v1/traces',
  samplingRate: 1.0
});

bridge.use(tracing);
```

---

### Rate limiting

`@johnhenry/aimatey-middleware` does not ship a rate-limit middleware. Rate
limiting is applied at the HTTP layer instead, with `RateLimiter` from
`@johnhenry/aimatey-http-core`.

---

### Validation Middleware

#### `createValidationMiddleware(config)`

Validates and optionally sanitizes IR requests. Validation is expressed as
limits and flags, not JSON Schema.

**Parameters:** `config: ValidationConfig`

```typescript
interface ValidationConfig {
  /** Check that the request is structurally valid IR (default: true) */
  validateIRFormat?: boolean;

  /** Size limits */
  maxMessages?: number;
  maxMessageLength?: number;
  maxTotalTokens?: number;

  /** Allow-lists */
  allowedModels?: string[];
  allowedRoles?: Array<'user' | 'assistant' | 'system'>;

  /** Accepted temperature range, e.g. [0, 2] */
  temperatureRange?: [number, number];

  /** Strip control characters and normalize whitespace */
  sanitizeMessages?: boolean;

  /** PII detection */
  detectPII?: boolean;
  piiAction?: 'block' | 'redact' | 'warn' | 'log';

  /** Reject known prompt-injection patterns */
  preventPromptInjection?: boolean;

  /** Throw on validation failure rather than warn (default: true) */
  throwOnError?: boolean;

  /** Extra application-specific checks */
  customValidator?: (request: IRChatRequest) => ValidationError[] | Promise<ValidationError[]>;
}
```

**Returns:** `Middleware`

**Example:**

```typescript
import { createValidationMiddleware } from '@johnhenry/aimatey-middleware';

const validation = createValidationMiddleware({
  validateIRFormat: true,
  maxMessages: 50,
  maxMessageLength: 10_000,
  allowedModels: ['gpt-6-astra', 'gpt-5.6-sol'],
  allowedRoles: ['system', 'user', 'assistant'],
  temperatureRange: [0, 2],
  detectPII: true,
  piiAction: 'redact',
  throwOnError: true
});

bridge.use(validation);
```

`createProductionValidationMiddleware()` and
`createDevelopmentValidationMiddleware()` are preconfigured variants.

---

### Conversation History Middleware

#### `createConversationHistoryMiddleware(config)`

Maintains a single in-process conversation history across requests.

**Parameters:** `config: ConversationHistoryConfig`

```typescript
interface ConversationHistoryConfig {
  /** Maximum messages to keep (default: 20) */
  maxHistorySize?: number;

  /** Trim strategy: 'fifo' | 'smart' (default: 'smart') */
  strategy?: TrimStrategy;

  /** Prepend the history to each request (default: true) */
  prependHistory?: boolean;

  /** Append assistant responses to the history (default: true) */
  trackResponses?: boolean;

  /** Messages the history starts with */
  initialHistory?: IRMessage[];

  /** Decide which messages are kept */
  messageFilter?: (message: IRMessage) => boolean;
}
```

**Returns:** `{ middleware: Middleware; manager: ConversationHistoryManager }` -
register `result.middleware`, and use `result.manager` to read, seed or clear the
history.

**Example:**

```typescript
import { createConversationHistoryMiddleware } from '@johnhenry/aimatey-middleware';

const history = createConversationHistoryMiddleware({
  maxHistorySize: 20,
  strategy: 'smart',
  prependHistory: true,
  trackResponses: true
});

bridge.use(history.middleware);

// Messages are automatically maintained across requests
await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello' }]
});

await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'What did I just say?' }]
});
// Previous message is automatically included

console.log(history.manager.getHistory());
history.manager.clear();
```

The history is per-middleware-instance, not per-session: there is no `sessionId`
field on a request. To keep separate conversations, build one bridge (or one
history middleware) per conversation.

---

## Custom Middleware

### Creating Custom Middleware

```typescript
import type { Middleware } from '@johnhenry/aimatey-types';

function createCustomMiddleware(options: CustomOptions): Middleware {
  return async (context, next) => {
    // Modify request before sending
    console.log('Before request:', context.request.parameters?.model);

    // Replace the request on the context to change it
    context.request = {
      ...context.request,
      parameters: {
        ...context.request.parameters,
        temperature: Math.min(context.request.parameters?.temperature ?? 0.7, 0.9)
      }
    };

    try {
      const response = await next();

      // Process response after receiving
      console.log('After response:', response.usage);

      return response;
    } catch (error) {
      // Handle errors
      console.error('Error occurred:', (error as Error).message);

      // Re-throw, or recover by returning a response
      throw error;
    } finally {
      // Cleanup after the request completes
      console.log('Cleaning up...');
    }
  };
}
```

---

### Middleware with State

```typescript
function createStatefulMiddleware() {
  let requestCount = 0;
  const startTime = Date.now();

  const middleware: Middleware = async (context, next) => {
    requestCount++;
    console.log(`Request #${requestCount}`);
    return next();
  };

  return {
    middleware,

    getStats() {
      return {
        totalRequests: requestCount,
        uptime: Date.now() - startTime,
        avgRequestsPerMinute: (requestCount / ((Date.now() - startTime) / 60000)).toFixed(2)
      };
    }
  };
}

const counter = createStatefulMiddleware();
bridge.use(counter.middleware);

// Later
console.log(counter.getStats());
```

---

### Async Middleware

```typescript
function createAsyncMiddleware(): Middleware {
  return async (context, next) => {
    // Async operations
    const userContext = await fetchUserContext(context.request.metadata.requestId);

    context.request = {
      ...context.request,
      messages: [
        { role: 'system', content: `User context: ${userContext}` },
        ...context.request.messages
      ]
    };

    const response = await next();

    // Async logging
    await logToDatabase({
      requestId: response.metadata.requestId,
      tokens: response.usage?.totalTokens,
      timestamp: new Date()
    });

    return response;
  };
}
```

---

## Middleware Order

**Order matters!** Middleware runs in registration order - the first middleware
added is the outermost layer, so it runs first on the way in and last on the way
out:

```typescript
// ❌ Wrong order
bridge.use(createCachingMiddleware());  // Runs 1st (cache hits skip logging)
bridge.use(createRetryMiddleware());    // Runs 2nd
bridge.use(createLoggingMiddleware());  // Runs 3rd

// ✅ Correct order
bridge.use(createLoggingMiddleware());  // Runs 1st (logs everything)
bridge.use(createRetryMiddleware());    // Runs 2nd (retries if needed)
bridge.use(createCachingMiddleware());  // Runs 3rd (caches successful responses)
```

**Request Flow:**
1. Logging → logs request
2. Retry → sends request (may retry)
3. Caching → checks cache, stores response
4. Backend → executes request

**Response Flow:**
1. Backend → returns response
2. Caching → stores in cache
3. Retry → handles errors
4. Logging → logs response

---

## Middleware Composition

### Combining Multiple Middleware

```typescript
import {
  createLoggingMiddleware,
  createRetryMiddleware,
  createCachingMiddleware,
  createCostTrackingMiddleware,
  createValidationMiddleware
} from '@johnhenry/aimatey-middleware';

const bridge = new Bridge(frontend, backend);

// Production middleware stack
bridge
  .use(createLoggingMiddleware({ level: 'info' }))
  .use(createValidationMiddleware({ throwOnError: true }))
  .use(createRetryMiddleware({ maxAttempts: 3 }))
  .use(createCachingMiddleware({ ttl: 3_600_000 }))
  .use(createCostTrackingMiddleware({ dailyThreshold: 100 }));
```

---

## See Also

- [Bridge API](/api/bridge) - Using middleware with Bridge
- [Router API](/api/router) - Using middleware with Router
- [Middleware Package](/packages/middleware) - Package documentation
- [Middleware Examples](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/03-middleware) - Code examples
