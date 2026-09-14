---
title: "Errors API"
description: "Error handling reference: the AdapterError hierarchy, error codes, and handling patterns."
---

Complete error handling reference for aimatey.

Every error class, the `ErrorCode` constant and the two error factory functions
live in a single package with a single entry point:

```typescript
import { AdapterError, RateLimitError, ErrorCode } from '@johnhenry/aimatey-errors';
```

The matching `*Options` interfaces, `ErrorCategory` and `ERROR_CODE_CATEGORIES`
are declared in `@johnhenry/aimatey-types` and re-exported from
`@johnhenry/aimatey-errors`. Note that `@johnhenry/aimatey-errors` re-exports
`ErrorCategory` as a **type only** - import it from `@johnhenry/aimatey-types`
when you need the runtime constant object.

## Error Hierarchy

```
Error
└── AdapterError (base)
    ├── AuthenticationError
    ├── AuthorizationError
    ├── RateLimitError
    ├── ValidationError
    ├── ProviderError
    ├── AdapterConversionError
    ├── NetworkError
    ├── StreamError
    ├── RouterError
    └── MiddlewareError
```

The hierarchy is flat: every specialized class extends `AdapterError` directly.
There is no intermediate "backend error" class, so `error instanceof AdapterError`
is the one check that matches everything aimatey throws.

:::note[Errors take an options object]
Every constructor takes a single options object - there are no positional
arguments. The `code` is required for most classes; `RateLimitError` and
`MiddlewareError` set their own code and do not accept one.
:::

---

## Base Error

### `AdapterError`

Base class for all aimatey errors, and the class thrown directly whenever no
more specific class fits (the `Router`, for example, throws `AdapterError` with
routing codes).

```typescript
class AdapterError extends Error {
  /** Universal error code */
  readonly code: ErrorCode;

  /** Category derived from the code via ERROR_CODE_CATEGORIES */
  readonly category: ErrorCategory;

  /** Whether retrying the request could succeed */
  readonly isRetryable: boolean;

  /** Where in the adapter chain the failure happened */
  readonly provenance: ErrorProvenance;

  /** Original error, when this one wraps another */
  readonly cause?: Error;

  /** Snapshot of the IR request/response involved */
  readonly irState?: {
    request?: Partial<IRChatRequest>;
    response?: Partial<IRChatResponse>;
  };

  /** Class-specific extra context */
  readonly details?: Record<string, unknown>;

  /** Milliseconds since epoch, set at construction */
  readonly timestamp: number;

  isCategory(category: ErrorCategory): boolean;
  toJSON(): Record<string, unknown>;
}
```

**Constructor options (`BaseErrorOptions`):**

| Option | Type | Required | Notes |
|--------|------|----------|-------|
| `code` | `ErrorCode` | yes | Sets `category` automatically |
| `message` | `string` | yes | |
| `isRetryable` | `boolean` | no | Defaults to `false` |
| `provenance` | `ErrorProvenance` | no | Defaults to `{}` |
| `cause` | `Error` | no | |
| `irState` | `{ request?, response? }` | no | Partial IR snapshots |
| `details` | `Record<string, unknown>` | no | |

`ErrorProvenance` has four optional string fields: `frontend`, `backend`,
`middleware` and `router`.

**Example:**

```typescript
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';

try {
  await bridge.chat({ model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] });
} catch (error) {
  if (error instanceof AdapterError) {
    console.log('Code:', error.code);
    console.log('Category:', error.category);
    console.log('Retryable:', error.isRetryable);
    console.log('Where:', error.provenance); // { frontend, backend, middleware, router }
  }
}
```

**`isCategory(category)`** compares against `error.category`:

```typescript
import { ErrorCategory } from '@johnhenry/aimatey-types';

if (error instanceof AdapterError && error.isCategory(ErrorCategory.NETWORK)) {
  // network / connectivity family
}
```

**`toJSON()`** returns a plain object with `name`, `code`, `category`,
`message`, `isRetryable`, `provenance`, `irState`, `details`, `timestamp`,
`stack` and a flattened `cause`. It is what `JSON.stringify(error)` produces.

---

## Authentication and Authorization

### `AuthenticationError`

API key missing, invalid or expired. Always constructed with
`isRetryable: false`.

```typescript
new AuthenticationError({
  code: ErrorCode.INVALID_API_KEY, // or MISSING_API_KEY | EXPIRED_API_KEY
  message: 'Authentication failed',
  provenance: { backend: 'openai' },  // optional
  cause: originalError,               // optional
});
```

**Example:**

```typescript
import { AuthenticationError } from '@johnhenry/aimatey-errors';

try {
  await bridge.chat({ model: 'gpt-4', messages });
} catch (error) {
  if (error instanceof AuthenticationError) {
    console.error('Auth failed at:', error.provenance.backend);
    console.error('Code:', error.code); // INVALID_API_KEY | MISSING_API_KEY | EXPIRED_API_KEY
  }
}
```

---

### `AuthorizationError`

Permission or quota problems. Always constructed with `isRetryable: false`.

```typescript
new AuthorizationError({
  code: ErrorCode.INSUFFICIENT_PERMISSIONS, // or QUOTA_EXCEEDED
  message: 'Authorization failed',
  provenance: { backend: 'anthropic' },
  cause: originalError,
});
```

---

## Rate Limiting

### `RateLimitError`

Thrown when the provider reports a rate limit. The code is always
`RATE_LIMIT_EXCEEDED` and `isRetryable` is always `true` - you do not pass
either.

```typescript
new RateLimitError({
  message: 'Rate limit exceeded',
  provenance: { backend: 'openai' },
  cause: originalError,
  rateLimitDetails: {
    retryAfter: 30_000, // milliseconds
    limit: 3500,
    remaining: 0,
    resetAt: '2025-01-01T00:00:30Z',
  },
});
```

The four `rateLimitDetails` fields are also lifted onto the error itself:

```typescript
class RateLimitError extends AdapterError {
  readonly retryAfter?: number;  // milliseconds
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetAt?: string;     // ISO timestamp
}
```

**Example:**

```typescript
import { RateLimitError } from '@johnhenry/aimatey-errors';

try {
  await bridge.chat({ model: 'gpt-4', messages });
} catch (error) {
  if (error instanceof RateLimitError) {
    // retryAfter is in milliseconds and may be undefined
    const waitMs = error.retryAfter ?? 1000;
    console.log(`Rate limited, waiting ${waitMs}ms (${error.remaining ?? '?'} left of ${error.limit ?? '?'})`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    await bridge.chat({ model: 'gpt-4', messages });
  }
}
```

---

## Validation Errors

### `ValidationError`

Request validation failures, raised before or instead of hitting a provider.
Always constructed with `isRetryable: false`.

```typescript
new ValidationError({
  code: ErrorCode.INVALID_REQUEST,
  //   | INVALID_MESSAGE_FORMAT | INVALID_PARAMETERS
  //   | UNSUPPORTED_MODEL | UNSUPPORTED_FEATURE | CONTEXT_LENGTH_EXCEEDED
  message: 'Request validation failed',
  validationDetails: [
    { field: 'messages', value: [], reason: 'must contain at least one message', expected: 'IRMessage[]' },
  ],
  provenance: { frontend: 'openai' }, // optional
  irState: { request: partialRequest }, // optional
});
```

`validationDetails` is required and each entry is a `ValidationErrorDetails`:
`field` (string), `value` (unknown), `reason` (string) and optional `expected`
(string). The array is exposed as `error.validationDetails`.

**Example:**

```typescript
import { ValidationError } from '@johnhenry/aimatey-errors';

try {
  await bridge.chat({ model: 'gpt-4', messages: [] }); // empty messages
} catch (error) {
  if (error instanceof ValidationError) {
    for (const detail of error.validationDetails) {
      console.error(`${detail.field}: ${detail.reason} (expected ${detail.expected ?? 'n/a'})`);
    }
  }
}
```

---

## Provider Errors

### `ProviderError`

Upstream API failures. This is the only specialized class that lets you decide
`isRetryable` yourself (it defaults to `false`).

```typescript
new ProviderError({
  code: ErrorCode.PROVIDER_UNAVAILABLE,
  //   | PROVIDER_ERROR | PROVIDER_TIMEOUT | PROVIDER_OVERLOADED
  message: 'Provider is unavailable',
  isRetryable: true,
  provenance: { backend: 'anthropic' },
  cause: originalError,
  providerDetails: {
    provider: 'anthropic',        // required within providerDetails
    providerCode: 'overloaded_error',
    providerMessage: 'Overloaded',
    providerData: { requestId: 'req_123' },
  },
  httpContext: {
    statusCode: 503,              // required within httpContext
    statusText: 'Service Unavailable',
    headers: { 'retry-after': '5' },
    responseBody: rawBody,
  },
  irState: { request: partialRequest },
});
```

Both `providerDetails` and `httpContext` are exposed on the error.

**Example:**

```typescript
import { ProviderError } from '@johnhenry/aimatey-errors';

try {
  await bridge.chat({ model: 'claude-haiku-4-5-20251001', messages });
} catch (error) {
  if (error instanceof ProviderError) {
    console.error('Provider:', error.providerDetails?.provider);
    console.error('Upstream code:', error.providerDetails?.providerCode);
    console.error('HTTP status:', error.httpContext?.statusCode);
  }
}
```

---

## Adapter Conversion Errors

### `AdapterConversionError`

Raised by frontend and backend adapters when a request or response cannot be
translated to or from IR. Always constructed with `isRetryable: false`.

```typescript
new AdapterConversionError({
  code: ErrorCode.UNSUPPORTED_CONVERSION,
  //   | ADAPTER_CONVERSION_ERROR | ADAPTER_VALIDATION_ERROR | SEMANTIC_DRIFT_ERROR
  message: 'Cannot represent tool_choice in this provider format',
  provenance: { frontend: 'anthropic', backend: 'gemini' },
  cause: originalError,
  irState: { request: partialRequest, response: partialResponse },
});
```

**Example:**

```typescript
import { AdapterConversionError } from '@johnhenry/aimatey-errors';

try {
  await bridge.chat({ model: 'gpt-4', messages });
} catch (error) {
  if (error instanceof AdapterConversionError) {
    console.error(
      `Conversion failed between ${error.provenance.frontend} and ${error.provenance.backend}`
    );
    console.error('Offending request:', error.irState?.request);
  }
}
```

---

## Network Errors

### `NetworkError`

Connectivity failures below the HTTP response layer. Always constructed with
`isRetryable: true`.

```typescript
new NetworkError({
  code: ErrorCode.CONNECTION_TIMEOUT,
  //   | NETWORK_ERROR | DNS_RESOLUTION_FAILED
  message: 'Request timed out',
  provenance: { backend: 'openai' },
  cause: originalError,
});
```

:::note[There is no `TimeoutError`]
Timeouts surface as `NetworkError` with `CONNECTION_TIMEOUT` (transport level) or
as `ProviderError` with `PROVIDER_TIMEOUT` (the provider itself timed out).
:::

---

## Streaming Errors

### `StreamError`

Failures on the streaming path. `isRetryable` is computed: it is `true` only
when the code is `STREAM_INTERRUPTED`.

```typescript
new StreamError({
  code: ErrorCode.STREAM_INTERRUPTED,
  //   | STREAM_ERROR | STREAM_PARSE_ERROR | STREAM_CANCELLED
  message: 'Stream ended before completion',
  provenance: { backend: 'openai' },
  cause: originalError,
  irState: { request: partialRequest },
});
```

**Example:**

```typescript
import { StreamError } from '@johnhenry/aimatey-errors';

try {
  for await (const chunk of bridge.chatStream({ model: 'gpt-4', messages })) {
    process.stdout.write(chunk.choices?.[0]?.delta?.content ?? '');
  }
} catch (error) {
  if (error instanceof StreamError) {
    // Only STREAM_INTERRUPTED is marked retryable
    console.error(`Stream failed (${error.code}), retryable: ${error.isRetryable}`);
  }
}
```

---

## Routing Errors

### `RouterError`

Routing failures, carrying the backends that were tried. `isRetryable` is
computed: `true` only when the code is `ALL_BACKENDS_FAILED`.

```typescript
class RouterError extends AdapterError {
  readonly attemptedBackends?: string[];
}

new RouterError({
  code: ErrorCode.ALL_BACKENDS_FAILED,
  //   | NO_BACKEND_AVAILABLE | ROUTING_FAILED
  message: 'All backends failed',
  attemptedBackends: ['openai', 'anthropic', 'groq'],
  provenance: { router: 'my-router' },
  cause: originalError,
  irState: { request: partialRequest },
});
```

:::caution[The shipped `Router` throws `AdapterError`, not `RouterError`]
`RouterError` is exported and available for your own routers, but the built-in
`Router` raises plain `AdapterError` instances carrying the routing codes
(`NO_BACKEND_AVAILABLE`, `ROUTING_FAILED`, `ALL_BACKENDS_FAILED`). Match on
`error.code` or `error.category` rather than `error instanceof RouterError`.
:::

**Example:**

```typescript
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';

try {
  await bridge.chat({ model: 'gpt-4', messages });
} catch (error) {
  if (error instanceof AdapterError && error.code === ErrorCode.ALL_BACKENDS_FAILED) {
    console.error('Every backend failed:', error.message);
  }
}
```

---

## Middleware Errors

### `MiddlewareError`

The code is always `MIDDLEWARE_ERROR` and `isRetryable` is always `false` -
neither is passed.

```typescript
class MiddlewareError extends AdapterError {
  readonly middlewareName?: string;
}

new MiddlewareError({
  message: 'Middleware could not complete',
  middlewareName: 'my-middleware',
  provenance: { middleware: 'my-middleware' },
  cause: originalError,
  irState: { request: partialRequest, response: partialResponse },
});
```

The middleware stack itself throws `MiddlewareError` for stack misuse: adding or
removing middleware after the stack is locked, or calling `next()` more than once
on a streaming request. An error thrown *inside* your own middleware is not
wrapped - it propagates as whatever you threw.

---

## Error Factories

Two helpers build the right error class for you. Both are exported from
`@johnhenry/aimatey-errors`, and the built-in backend adapters use them.

### `createErrorFromHttpResponse(statusCode, statusText, responseBody, provenance)`

Maps an HTTP status to a class:

| Status | Returned class | Code |
|--------|----------------|------|
| `401` | `AuthenticationError` | `INVALID_API_KEY` |
| `403` | `AuthorizationError` | `INSUFFICIENT_PERMISSIONS` |
| `429` | `RateLimitError` | `RATE_LIMIT_EXCEEDED` |
| `400` | `ValidationError` | `INVALID_REQUEST` |
| `>= 500` | `ProviderError` (retryable) | `PROVIDER_ERROR` |
| anything else | `AdapterError` | `PROVIDER_ERROR` |

**Returns:** `AdapterError` (a subclass instance in the mapped cases).

```typescript
import { createErrorFromHttpResponse } from '@johnhenry/aimatey-errors';

const response = await fetch(url, init);
if (!response.ok) {
  const body = await response.text();
  throw createErrorFromHttpResponse(response.status, response.statusText, body, {
    backend: 'my-backend',
  });
}
```

### `createErrorFromProviderError(provider, providerError, provenance)`

Wraps an arbitrary provider error value into a `ProviderError` with code
`PROVIDER_ERROR`, setting `providerDetails.provider` and stringifying the
original into `providerDetails.providerMessage`.

```typescript
import { createErrorFromProviderError } from '@johnhenry/aimatey-errors';

try {
  await providerSdk.messages.create(payload);
} catch (providerError) {
  throw createErrorFromProviderError('anthropic', providerError, { backend: 'anthropic' });
}
```

---

## Error Handling Patterns

### Try-Catch

Basic error handling:

```typescript
import {
  AdapterError,
  AuthenticationError,
  RateLimitError,
} from '@johnhenry/aimatey-errors';

try {
  const response = await bridge.chat({ model: 'gpt-4', messages });
} catch (error) {
  if (error instanceof RateLimitError) {
    await new Promise((resolve) => setTimeout(resolve, error.retryAfter ?? 1000));
  } else if (error instanceof AuthenticationError) {
    console.error('Invalid API key:', error.code);
  } else if (error instanceof AdapterError) {
    console.error(`${error.category}/${error.code}: ${error.message}`);
  } else {
    console.error('Unexpected error:', error);
  }
}
```

---

### Branch on Category

`category` is derived from `code`, so one check covers a whole family:

```typescript
import { AdapterError } from '@johnhenry/aimatey-errors';
import { ErrorCategory } from '@johnhenry/aimatey-types';

function classify(error: unknown): 'retry' | 'reconfigure' | 'fail' {
  if (!(error instanceof AdapterError)) return 'fail';

  switch (error.category) {
    case ErrorCategory.RATE_LIMIT:
    case ErrorCategory.NETWORK:
      return 'retry';
    case ErrorCategory.AUTHENTICATION:
    case ErrorCategory.AUTHORIZATION:
      return 'reconfigure';
    default:
      return error.isRetryable ? 'retry' : 'fail';
  }
}
```

---

### Error Handler Middleware

`Middleware` is a function, `(context, next) => Promise<IRChatResponse>`. There
is no object form and no `onError` hook - wrap the `next()` call in your own
try/catch. `next()` takes no arguments; the request lives on `context.request`.

```typescript
import type { Middleware } from '@johnhenry/aimatey-types';
import { AdapterError, AuthenticationError, RateLimitError } from '@johnhenry/aimatey-errors';

const errorHandler: Middleware = async (context, next) => {
  try {
    return await next();
  } catch (error) {
    if (error instanceof RateLimitError) {
      console.warn(`Rate limited on ${context.backendName ?? 'unknown backend'}`);
    } else if (error instanceof AuthenticationError) {
      await sendAlert(`Authentication failed: ${error.message}`);
    } else if (error instanceof AdapterError) {
      console.error(`${error.category}/${error.code} for model ${context.request.parameters?.model}`);
    }

    // Re-throw to propagate; returning a value here would swallow the failure.
    throw error;
  }
};

bridge.use(errorHandler);
```

---

### Bridge Error Events

`bridge.on(event, listener)` subscribes to lifecycle events and returns the
bridge. Listeners receive a single event object; `request:error` and
`stream:error` carry the failure in `event.error`.

```typescript
import { AdapterError } from '@johnhenry/aimatey-errors';

bridge.on('request:error', (event) => {
  const error = 'error' in event ? event.error : undefined;
  if (error instanceof AdapterError) {
    console.error(`[${event.requestId}] ${error.category}/${error.code}: ${error.message}`);
    console.error('Provenance:', error.provenance);
  }
});

bridge.on('stream:error', (event) => {
  console.error('Stream failed:', 'error' in event ? event.error?.message : undefined);
});
```

Use `bridge.off(event, listener)` to unsubscribe, `bridge.once(event, listener)`
for a one-shot listener, and `'*'` with `on()`/`off()` to receive every event.

:::caution[Only six event types are actually emitted]
`Bridge` emits `'request:start'`, `'request:success'`, `'request:error'`,
`'stream:start'`, `'stream:complete'` and `'stream:error'`. The
`BridgeEventType` union additionally declares `'request:cancelled'`,
`'stream:chunk'`, `'backend:selected'`, `'backend:failover'` and
`'middleware:executed'`, but nothing emits them today - subscribing to those
names is valid TypeScript that never fires.
:::

---

### Router Failover

`Router` is a `BackendAdapter`, not a bridge: it has no `chat()`, no
`chatStream()` and no event emitter. Its constructor takes only a config object;
backends are added afterwards with `register()`. Give the router to a `Bridge`
and call `bridge.chat()`.

```typescript
import { Bridge, Router } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';

const router = new Router({
  routingStrategy: 'explicit',
  defaultBackend: 'openai',
  fallbackStrategy: 'sequential', // 'none' | 'sequential' | 'parallel' | 'custom'
});

router
  .register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY! }))
  .register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY! }));

// Order the router tries after the primary fails
router.setFallbackChain(['anthropic']);

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

try {
  const response = await bridge.chat({ model: 'gpt-4', messages });
} catch (error) {
  if (error instanceof AdapterError) {
    switch (error.code) {
      case ErrorCode.NO_BACKEND_AVAILABLE:
        console.error('Nothing registered or healthy to route to');
        break;
      case ErrorCode.ALL_BACKENDS_FAILED:
        console.error('Primary and every fallback failed');
        break;
      case ErrorCode.ROUTING_FAILED:
        console.error('Routing configuration problem:', error.message);
        break;
    }
  }
}
```

Failover applies to `execute()` (that is, `bridge.chat()`). Streaming does not
fall back: if the selected backend fails mid-stream, the stream ends.

---

### Retry Logic

`createRetryMiddleware` retries the wrapped call with exponential backoff. By
default it retries only errors whose `isRetryable` is `true`, which is exactly
what the error classes compute for you.

```typescript
import { createRetryMiddleware } from '@johnhenry/aimatey-middleware';
import { AuthenticationError, NetworkError, RateLimitError } from '@johnhenry/aimatey-errors';

bridge.use(
  createRetryMiddleware({
    maxAttempts: 3,        // total attempts, not extra retries
    initialDelay: 1000,
    backoffMultiplier: 2,
    maxDelay: 30_000,
    useJitter: true,
    shouldRetry: (error, attempt) => {
      if (error instanceof RateLimitError) return true;
      if (error instanceof NetworkError) return true;
      if (error instanceof AuthenticationError) return false;
      return attempt < 2;
    },
    onRetry: (error, attempt, delay) => {
      console.warn(`Attempt ${attempt} failed, retrying in ${delay}ms`);
    },
  })
);
```

---

### Error Logging

`AdapterError.toJSON()` already produces a structured record, so logging is
mostly a matter of forwarding it:

```typescript
import { AdapterError } from '@johnhenry/aimatey-errors';

function logError(error: unknown): void {
  const logData: Record<string, unknown> =
    error instanceof AdapterError
      ? error.toJSON()
      : {
          name: error instanceof Error ? error.name : 'UnknownError',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          timestamp: Date.now(),
        };

  console.error(JSON.stringify(logData, null, 2));
  sendToLogService(logData);
}

try {
  await bridge.chat({ model: 'gpt-4', messages });
} catch (error) {
  logError(error);
}
```

---

## Error Codes Reference

`ErrorCode` is a constant object exported from `@johnhenry/aimatey-errors` (the
type alias is exported separately as `ErrorCodeType`). `ERROR_CODE_CATEGORIES`
maps every code to its category.

| Code | Category | Raised as |
|------|----------|-----------|
| `INVALID_API_KEY` | `authentication` | `AuthenticationError` |
| `MISSING_API_KEY` | `authentication` | `AuthenticationError` |
| `EXPIRED_API_KEY` | `authentication` | `AuthenticationError` |
| `INSUFFICIENT_PERMISSIONS` | `authorization` | `AuthorizationError` |
| `QUOTA_EXCEEDED` | `authorization` | `AuthorizationError` |
| `RATE_LIMIT_EXCEEDED` | `rate_limit` | `RateLimitError` |
| `INVALID_REQUEST` | `validation` | `ValidationError` |
| `INVALID_MESSAGE_FORMAT` | `validation` | `ValidationError` |
| `INVALID_PARAMETERS` | `validation` | `ValidationError` |
| `UNSUPPORTED_MODEL` | `validation` | `ValidationError` |
| `UNSUPPORTED_FEATURE` | `validation` | `ValidationError` |
| `CONTEXT_LENGTH_EXCEEDED` | `validation` | `ValidationError` |
| `MAX_TOOL_ITERATIONS_EXCEEDED` | `validation` | `AdapterError` |
| `PROVIDER_ERROR` | `provider` | `ProviderError` |
| `PROVIDER_UNAVAILABLE` | `provider` | `ProviderError` |
| `PROVIDER_TIMEOUT` | `provider` | `ProviderError` |
| `PROVIDER_OVERLOADED` | `provider` | `ProviderError` |
| `ADAPTER_CONVERSION_ERROR` | `adapter` | `AdapterConversionError` |
| `ADAPTER_VALIDATION_ERROR` | `adapter` | `AdapterConversionError` |
| `UNSUPPORTED_CONVERSION` | `adapter` | `AdapterConversionError` |
| `SEMANTIC_DRIFT_ERROR` | `adapter` | `AdapterConversionError` |
| `NETWORK_ERROR` | `network` | `NetworkError` |
| `CONNECTION_TIMEOUT` | `network` | `NetworkError` |
| `DNS_RESOLUTION_FAILED` | `network` | `NetworkError` |
| `STREAM_ERROR` | `streaming` | `StreamError` |
| `STREAM_INTERRUPTED` | `streaming` | `StreamError` (retryable) |
| `STREAM_PARSE_ERROR` | `streaming` | `StreamError` |
| `STREAM_CANCELLED` | `streaming` | `StreamError` |
| `NO_BACKEND_AVAILABLE` | `routing` | `AdapterError` / `RouterError` |
| `ROUTING_FAILED` | `routing` | `AdapterError` / `RouterError` |
| `ALL_BACKENDS_FAILED` | `routing` | `AdapterError` / `RouterError` (retryable) |
| `MIDDLEWARE_ERROR` | `middleware` | `MiddlewareError` |
| `UNKNOWN_ERROR` | `unknown` | `AdapterError` |
| `INTERNAL_ERROR` | `unknown` | `AdapterError` |

The category constants are `authentication`, `authorization`, `rate_limit`,
`validation`, `provider`, `adapter`, `network`, `streaming`, `routing`,
`middleware` and `unknown`, available as `ErrorCategory` from
`@johnhenry/aimatey-types`.

---

## Best Practices

### 1. Always Handle Errors

```typescript
// ✅ Good
try {
  const response = await bridge.chat({ model: 'gpt-4', messages });
} catch (error) {
  logError(error);
}

// ❌ Bad
const response = await bridge.chat({ model: 'gpt-4', messages }); // Unhandled errors
```

---

### 2. Narrow With `AdapterError` First

```typescript
// ✅ Good
catch (error) {
  if (error instanceof RateLimitError) {
    // handle rate limit specifically
  } else if (error instanceof AdapterError) {
    // everything aimatey throws lands here
  } else {
    throw error; // not ours
  }
}

// ❌ Bad
catch (error) {
  console.log('Something went wrong'); // Too generic
}
```

---

### 3. Log the Context the Error Already Carries

```typescript
// ✅ Good
catch (error) {
  if (error instanceof AdapterError) {
    console.log('Code:', error.code);
    console.log('Category:', error.category);
    console.log('Provenance:', error.provenance);
    console.log('Details:', error.details);
  }
}

// ❌ Bad
catch (error) {
  console.log(error.message); // Missing context
}
```

---

### 4. Trust `isRetryable` Instead of Re-deriving It

```typescript
// ✅ Good - the subclasses already computed this
catch (error) {
  if (error instanceof AdapterError && error.isRetryable) {
    return await bridge.chat({ model: 'gpt-4', messages });
  }
  throw error;
}

// ❌ Bad
catch (error) {
  return await bridge.chat({ model: 'gpt-4', messages }); // Retries auth failures forever
}
```

---

### 5. Let the Router Handle Degradation

```typescript
// ✅ Good - configure fallback once, at the router
const router = new Router({ fallbackStrategy: 'sequential' });
router.register('openai', openaiBackend).register('anthropic', anthropicBackend);
router.setFallbackChain(['anthropic']);
const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

// ❌ Bad - hand-rolled fallback in every call site
try {
  return await primaryBridge.chat({ model: 'gpt-4', messages });
} catch (error) {
  return await fallbackBridge.chat({ model: 'gpt-4', messages });
}
```

---

## See Also

- [Bridge API](/api/bridge) - Bridge error handling
- [Router API](/api/router) - Router error handling
- [Middleware API](/api/middleware) - Middleware error handling
- [Testing Guide](/guides/testing) - Testing error scenarios
