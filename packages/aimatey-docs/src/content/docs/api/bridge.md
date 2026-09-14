---
title: "Bridge API"
description: "API reference for the Bridge class: construction, chat and streaming methods, middleware, and events."
---

Complete API reference for the `Bridge` class - the core component for connecting frontend and backend adapters.

## Constructor

### `new Bridge(frontend, backend, config?)`

Creates a new Bridge instance.

**Parameters:**

- `frontend: FrontendAdapter` - Adapter for parsing input format
- `backend: BackendAdapter | Router` - Adapter (or router) that executes requests against an AI provider
- `config?: Partial<BridgeConfig>` - Optional configuration (see [BridgeConfig](#bridgeconfig))

**Returns:** `Bridge` instance

**Example:**

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new AnthropicBackendAdapter({
    apiKey: process.env.ANTHROPIC_API_KEY
  }),
  {
    timeout: 30000,
    retries: 3
  }
);
```

## Methods

### `chat(request, options?)`

Execute a chat completion request.

**Parameters:**

- `request: any` - Request in frontend adapter format
- `options?: RequestOptions` - Per-request overrides (see [RequestOptions](#requestoptions))

**Returns:** `Promise<any>` - Response in frontend adapter format

**Throws:**
- `ProviderError` - If the provider API returns an error
- `NetworkError` - If the network request fails
- `ValidationError` - If request validation fails
- `AdapterError` (`CONNECTION_TIMEOUT` / `PROVIDER_TIMEOUT`) - If the request times out
- `AdapterError` (`ROUTING_FAILED`) - If `options.backend` names a backend that is not registered

**Example:**

```typescript
const response = await bridge.chat({
  model: 'gpt-4',
  messages: [
    { role: 'user', content: 'Hello!' }
  ]
});

console.log(response.choices[0].message.content);
```

---

### `chatStream(request, options?)`

Execute a streaming chat completion request.

**Parameters:**

- `request: any` - Request in frontend adapter format (with `stream: true`)
- `options?: RequestOptions` - Per-request overrides (see [RequestOptions](#requestoptions))

**Returns:** `AsyncGenerator<any>` - Stream of chunks in frontend adapter format. `chatStream()`
is an async generator, so it returns the stream synchronously - do not `await` the call itself.

**Throws:**
- `ProviderError` - If the provider API returns an error
- `StreamError` - If stream parsing fails
- `ValidationError` - If request validation fails
- `AdapterError` (`ROUTING_FAILED`) - If `options.backend` names a backend that is not registered

**Example:**

```typescript
const stream = bridge.chatStream({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Count to 10' }],
  stream: true
});

for await (const chunk of stream) {
  const content = chunk.choices?.[0]?.delta?.content;
  if (content) {
    process.stdout.write(content);
  }
}
```

---

### `use(middleware)`

Add middleware to the bridge.

**Parameters:**

- `middleware: Middleware` - Middleware to add to the chain

**Returns:** `Bridge` (for chaining)

**Example:**

```typescript
import { createLoggingMiddleware, createCachingMiddleware } from '@johnhenry/aimatey-middleware';

bridge
  .use(createLoggingMiddleware({ level: 'info' }))
  .use(createCachingMiddleware({ ttl: 3_600_000 })); // ttl is milliseconds
```

---

### `executeIR(request, options?)`

Execute a request using the IR format directly (bypassing the frontend adapter).

**Parameters:**

- `request: IRChatRequest` - Request in IR format
- `options?: RequestOptions` - Per-request overrides (see [RequestOptions](#requestoptions))

**Returns:** `Promise<IRChatResponse>` - Response in IR format

**Example:**

```typescript
const irResponse = await bridge.executeIR({
  messages: [{ role: 'user', content: 'Hello' }],
  parameters: {
    model: 'claude-haiku-4-5-20251001',
    temperature: 0.7
  },
  metadata: {
    requestId: 'req_1',
    timestamp: Date.now()
  }
});

console.log(irResponse.message.content);
```

---

### `executeIRStream(request, options?)`

Execute a streaming request using IR format directly. This is an async generator -
it returns the stream synchronously, so the call itself is not awaited.

**Parameters:**

- `request: IRChatRequest` - Request in IR format with streaming enabled
- `options?: RequestOptions` - Per-request overrides (see [RequestOptions](#requestoptions))

**Returns:** `IRChatStream` - `AsyncGenerator<IRStreamChunk>`

**Example:**

```typescript
const stream = bridge.executeIRStream({
  messages: [{ role: 'user', content: 'Hello' }],
  parameters: { model: 'claude-haiku-4-5-20251001' },
  metadata: { requestId: 'req_2', timestamp: Date.now() },
  stream: true
});

for await (const chunk of stream) {
  if (chunk.type === 'content') {
    process.stdout.write(chunk.delta);
  }
}
```

---

### `clone(config)`

`frontend` and `backend` are readonly - a bridge cannot be re-pointed at a
different adapter after construction. To run the same request through another
provider, build a second bridge; to change only configuration, `clone()` returns
a new bridge with the same adapters and middleware and a merged config.

**Parameters:**

- `config: Partial<BridgeConfig>` - Configuration overrides

**Returns:** `Bridge` - A new bridge instance

**Example:**

```typescript
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';

// Same adapters, longer timeout
const patientBridge = bridge.clone({ timeout: 120000 });

// A different backend means a new bridge
const openaiBridge = new Bridge(
  bridge.frontend,
  new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY })
);
```

---

### `on(event, handler)`

Subscribe to bridge events.

**Parameters:**

- `event: BridgeEventType | '*'` - Event name, or `'*'` for every event
- `handler: BridgeEventListener` - Event handler function

**Returns:** `Bridge` (for chaining). `off()` and `once()` have the same shape.

**Events:**

`BridgeEventType` declares eleven event names (see [BridgeEventType](#bridgeeventtype)),
but only these six are emitted by `Bridge` today:

- `request:start` - Fired before a non-streaming request is sent
- `request:success` - Fired after a successful non-streaming response
- `request:error` - Fired when a non-streaming request fails
- `stream:start` - Fired when streaming starts
- `stream:complete` - Fired when streaming finishes
- `stream:error` - Fired when a stream fails

The remaining names (`request:cancelled`, `stream:chunk`, `backend:selected`,
`backend:failover`, `middleware:executed`) are reserved and never fire.

**Example:**

```typescript
bridge.on('request:start', (event) => {
  console.log('Request:', event.request.messages);
});

bridge.on('request:success', (event) => {
  console.log('Response tokens:', event.response?.usage?.totalTokens);
});

bridge.on('request:error', (event) => {
  console.error('Error:', event.error?.message);
});
```

---

## Properties

### `frontend`

**Type:** `FrontendAdapter`

**Read-only**

The frontend adapter instance the bridge was constructed with.

---

### `backend`

**Type:** `BackendAdapter | Router`

**Read-only**

The backend adapter (or router) the bridge was constructed with.

---

### `config`

**Type:** `BridgeConfig`

**Read-only**

The resolved bridge configuration.

---

### `getMiddleware()` / `getStreamingMiddleware()`

There is no `middlewares` property. The registered middleware is read back through
methods instead:

```typescript
bridge.getMiddleware();          // readonly Middleware[]
bridge.getStreamingMiddleware(); // readonly StreamingMiddleware[]
```

---

## Types

### `BridgeConfig`

Configuration options for Bridge, passed as the third constructor argument.

```typescript
interface BridgeConfig {
  /** Enable debug mode with detailed logging (default: false) */
  debug?: boolean;

  /** Global request timeout in milliseconds (default: 30000) */
  timeout?: number;

  /** Maximum retries for transient failures (default: 0) */
  retries?: number;

  /** Default model to use if the request does not specify one */
  defaultModel?: string;

  /** Router configuration, when the backend is a Router */
  routerConfig?: Partial<RouterConfig>;

  /** Add a request ID to metadata if not present (default: true) */
  autoRequestId?: boolean;

  /** Custom configuration options */
  custom?: Record<string, unknown>;
}
```

---

### `RequestOptions`

Per-request overrides, passed as the second argument to `chat()` and `chatStream()`.

```typescript
interface RequestOptions {
  /** Request timeout in milliseconds */
  timeout?: number;

  /** AbortSignal for request cancellation */
  signal?: AbortSignal;

  /** Backend override, by registered name (router only) */
  backend?: string;

  /** Additional metadata merged into `metadata.custom` */
  metadata?: Record<string, unknown>;

  /** Skip middleware execution for this request (default: false) */
  skipMiddleware?: boolean;

  /** Custom request options */
  custom?: Record<string, unknown>;
}
```

#### Per-request backend selection

`backend` picks a specific backend for one request, by the name it was registered
under. It only applies when the bridge's backend is a `Router` - with a single
backend adapter there is no routing to override and the option is ignored.

```typescript
const router = new Router({ routingStrategy: 'explicit', defaultBackend: 'openai' });
router.register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY }));
router.register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }));

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

// Routed by the router's configured strategy
await bridge.chat({ model: 'gpt-4', messages });

// Forced to Anthropic for this request only
await bridge.chat({ model: 'gpt-4', messages }, { backend: 'anthropic' });
```

The bridge writes the override onto `metadata.custom.backend`, which is the channel
the router reads its explicit routing decision from. It is applied last, so it takes
precedence over a `metadata.custom.backend` already present on the request and over a
`backend` key passed through `options.metadata`.

A name that is not registered is rejected up front with an `AdapterError` carrying
`ErrorCode.ROUTING_FAILED`, so a typo cannot be served by a different provider:

```typescript
await bridge.chat(request, { backend: 'antropic' });
// AdapterError: Requested backend 'antropic' is not registered.
//               Registered backends: openai, anthropic
```

A backend that *is* registered but is currently unhealthy or has an open circuit
breaker is not an error - the router's normal fallback applies.

---

### `BridgeEventType`

The event names accepted by `on()` / `off()` / `once()`. (`BridgeEvent` is a
different thing - the interface describing an event object.)

```typescript
type BridgeEventType =
  | 'request:start'
  | 'request:success'
  | 'request:error'
  | 'request:cancelled'
  | 'stream:start'
  | 'stream:chunk'
  | 'stream:complete'
  | 'stream:error'
  | 'backend:selected'
  | 'backend:failover'
  | 'middleware:executed';
```

Only `request:start`, `request:success`, `request:error`, `stream:start`,
`stream:complete` and `stream:error` are actually emitted.

---

## Error Handling

Bridge can throw the following errors:

Every error thrown by a bridge derives from `AdapterError`, which carries a
machine-readable `code`, a `category`, and an `isRetryable` flag.

### `ProviderError`

Thrown when the provider API returns an error response.

```typescript
import { AdapterError, ProviderError } from '@johnhenry/aimatey-errors';

try {
  await bridge.chat(request);
} catch (error) {
  if (error instanceof ProviderError) {
    console.log('Provider failed:', error.provenance.backend);
    console.log('Code:', error.code);
    console.log('Message:', error.message);
  } else if (error instanceof AdapterError) {
    console.log('Adapter error:', error.code, error.category);
  }
}
```

### `ValidationError`

Thrown when request validation fails. The per-field detail lives on
`validationDetails`.

```typescript
import { ValidationError } from '@johnhenry/aimatey-errors';

try {
  await bridge.chat(invalidRequest);
} catch (error) {
  if (error instanceof ValidationError) {
    console.log('Validation failed:', error.validationDetails);
  }
}
```

### Timeouts

There is no `TimeoutError` class. A timeout surfaces as an `AdapterError` whose
code is `CONNECTION_TIMEOUT` (the network call timed out) or `PROVIDER_TIMEOUT`
(the provider reported a timeout).

```typescript
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';

const bridge = new Bridge(frontend, backend, { timeout: 5000 });

try {
  await bridge.chat(request);
} catch (error) {
  if (
    error instanceof AdapterError &&
    (error.code === ErrorCode.CONNECTION_TIMEOUT || error.code === ErrorCode.PROVIDER_TIMEOUT)
  ) {
    console.log('Request timed out after 5s');
  }
}
```

---

## Advanced Usage

### Custom Backend Adapter

```typescript
import type {
  BackendAdapter,
  AdapterMetadata,
  IRChatRequest,
  IRChatResponse
} from '@johnhenry/aimatey-types';

class CustomBackend implements BackendAdapter {
  readonly metadata: AdapterMetadata = {
    name: 'custom',
    version: '1.0.0',
    provider: 'Custom',
    capabilities: {
      streaming: true,
      multiModal: false,
      systemMessageStrategy: 'in-messages',
      supportsMultipleSystemMessages: true
    }
  };

  fromIR(request: IRChatRequest): unknown {
    return request;
  }

  toIR(_response: unknown, originalRequest: IRChatRequest): IRChatResponse {
    return {
      message: { role: 'assistant', content: 'Custom response' },
      finishReason: 'stop',
      usage: { promptTokens: 5, completionTokens: 5, totalTokens: 10 },
      metadata: originalRequest.metadata
    };
  }

  async execute(request: IRChatRequest): Promise<IRChatResponse> {
    return this.toIR(null, request);
  }

  async *executeStream(request: IRChatRequest) {
    yield { type: 'start' as const, sequence: 0, metadata: request.metadata };
    yield { type: 'content' as const, sequence: 1, delta: 'Custom' };
    yield { type: 'done' as const, sequence: 2, finishReason: 'stop' as const };
  }
}

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new CustomBackend()
);
```

---

### Middleware Stack

```typescript
import {
  createLoggingMiddleware,
  createCachingMiddleware,
  createRetryMiddleware,
  createCostTrackingMiddleware
} from '@johnhenry/aimatey-middleware';

const bridge = new Bridge(frontend, backend);

// Add middleware in order
bridge
  .use(createLoggingMiddleware({ level: 'info' }))
  .use(createRetryMiddleware({ maxAttempts: 3 }))
  .use(createCachingMiddleware({ ttl: 3_600_000 })) // ttl is milliseconds
  .use(createCostTrackingMiddleware({ dailyThreshold: 100 }));
```

---

## See Also

- [Router API](/api/router) - Multi-backend routing
- [Middleware API](/api/middleware) - Middleware reference
- [Error Handling](/api/errors) - Error types
- [Tutorial: Simple Bridge](/tutorials/beginner/simple-bridge) - Getting started
- [Examples](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/01-basics) - Code examples
