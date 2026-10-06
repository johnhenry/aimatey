# @johnhenry/aimatey-middleware

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-middleware.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-middleware)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-middleware.svg)](LICENSE)

> **Note:** Previously published as `aimatey-middleware@0.3.1`.

Middleware components for Aimatey - Universal AI Adapter System.

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-middleware
```

## Overview

This package provides middleware components that can be composed into a middleware stack for request/response processing in Aimatey bridges.

## Included Middleware

- **Retry** - Automatic retry with exponential backoff
- **Caching** - Response caching with configurable storage
- **Logging** - Request/response logging
- **Telemetry** - Metrics and telemetry collection
- **OpenTelemetry** - OpenTelemetry integration
- **Validation** - Request validation and sanitization
- **Transform** - Request/response transformation
- **Security** - Security headers and validation
- **Cost Tracking** - Token usage and cost tracking
- **Conversation History** - Conversation state management
- **Decision middleware** - Caching, cost tracking, retry, logging, OpenTelemetry and validation for typed-decision calls (see [Decision middleware](#decision-middleware))

## Usage

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import {
  createRetryMiddleware,
  createCachingMiddleware,
  createLoggingMiddleware,
  InMemoryCacheStorage,
} from '@johnhenry/aimatey-middleware';

// Bridge takes positional arguments; middleware is registered with `use()`.
// There is no `middleware` field on BridgeConfig - passing one is silently ignored.
const bridge = new Bridge(frontend, backend);

bridge
  .use(createLoggingMiddleware({ level: 'info' }))
  .use(createRetryMiddleware({ maxAttempts: 3 }))
  .use(createCachingMiddleware({ storage: new InMemoryCacheStorage() }));
```

Middleware runs in registration order: the first registered is the outermost.

### Retry Middleware

```typescript
import { createRetryMiddleware } from '@johnhenry/aimatey-middleware';

const retry = createRetryMiddleware({
  maxAttempts: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  backoffMultiplier: 2,
});
```

### Caching Middleware

```typescript
import { createCachingMiddleware, InMemoryCacheStorage } from '@johnhenry/aimatey-middleware';

const cache = createCachingMiddleware({
  storage: new InMemoryCacheStorage(),
  ttl: 60000, // milliseconds - 1 minute
});
```

### Validation Middleware

```typescript
import { createValidationMiddleware } from '@johnhenry/aimatey-middleware';

const validation = createValidationMiddleware({
  detectPII: true,
  preventPromptInjection: true,
});
```

### Cost Tracking Middleware

```typescript
import { createCostTrackingMiddleware, InMemoryCostStorage } from '@johnhenry/aimatey-middleware';

const costTracking = createCostTrackingMiddleware({
  storage: new InMemoryCostStorage(),
});
```

## Decision middleware

`Bridge.decide()` has its own middleware chain (`bridge.useDecision()`, outermost first), separate from the chat stack because chat's `MiddlewareContext` is chat-shaped. Every chat middleware below has a decision counterpart, exported from the package root (and from `@johnhenry/aimatey-middleware/decisions`). Where it can, a decision factory is a thin wrapper over the chat one's internals: retry shares the chat backoff loop, cost tracking shares the pricing lookup, ledger and thresholds, caching shares the caller-scoping rules and in-memory store, logging and OpenTelemetry share the logger and tracer setup. Validation is a parallel implementation.

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import {
  createDecisionCachingMiddleware,
  createDecisionLoggingMiddleware,
  createDecisionValidationMiddleware,
  createDecisionRetryMiddleware,
  createDecisionCostTrackingMiddleware,
  createDecisionOpenTelemetryMiddleware,
} from '@johnhenry/aimatey-middleware';

// Outermost first: a cache hit never reaches the middleware below it.
bridge.useDecision(createDecisionCachingMiddleware({ ttl: 600_000 }));
bridge.useDecision(createDecisionLoggingMiddleware());
bridge.useDecision(createDecisionValidationMiddleware({ strict: true }));
bridge.useDecision(createDecisionRetryMiddleware({ maxAttempts: 3 }));
bridge.useDecision(createDecisionCostTrackingMiddleware());

await bridge.decide(ticket, questions, { principal: `tenant-${tenantId}` });
```

### `createDecisionCachingMiddleware`

Key = hash of `{ scope, state, questions, images, parameters.model, parameters.custom }`. `state` and `custom` are hashed with sorted keys; `questions` keep their order, since option order can change an answer. Like chat caching, **a request with no caller identity is not cached**: set `metadata.principal` (via `bridge.decide(..., { principal })`), pass `scopeKey`, or opt a single-tenant deployment in with `unidentified: 'share'`. A hit returns the stored answers with a fresh `metadata.requestId` / `timestamp` and `metadata.custom.cacheHit = true`. Responses carrying a `response-malformed`, `capability-emulated` or `capability-unsupported` warning are never stored (`uncacheableWarnings` overrides the list).

```typescript
bridge.useDecision(createDecisionCachingMiddleware({ ttl: 600_000, maxSize: 500 }));
```

### `createDecisionCostTrackingMiddleware`

Cost is `usage.cost` when the provider reports it, else `inputTokens` (+ `outputTokens`) x the model-registry price for `response.model` (falling back to the requested model), else 0 with a warning-level log. Same `onCost`, `storage` (`CostStorage`), thresholds and `includeInMetadata` as chat cost tracking; each record carries `metadata.principal` and `metadata.costSource` (`'provider' | 'pricing' | 'none'`).

```typescript
bridge.useDecision(
  createDecisionCostTrackingMiddleware({
    onCost: (cost) => console.log(`${cost.model}: $${cost.totalCost.toFixed(6)}`),
  })
);
```

### `createDecisionRetryMiddleware`

Same options and defaults as `createRetryMiddleware`: retries errors flagged `isRetryable` (network errors, 429, 5xx), never a `ValidationError`. A `DecisionMiddleware` receives only the request, so to let an abort stop the retry loop early, pass the signal as `metadata.custom.signal`.

```typescript
bridge.useDecision(createDecisionRetryMiddleware({ maxAttempts: 4, initialDelay: 500 }));
```

### `createDecisionLoggingMiddleware`

Logs per decision: model, backend, latency, usage and, per question, `type`, `value` and `confidence` (when reported). `state` is redacted unless `logState: true`, and only question names are logged, never instructions or criteria.

```typescript
bridge.useDecision(createDecisionLoggingMiddleware({ level: 'info', logState: false }));
```

### `createDecisionOpenTelemetryMiddleware`

One `aimatey-decision` span per call on the same provider as `createOpenTelemetryMiddleware` (same optional peer packages; the factory is async). Attributes include `ai.decision.question_count`, `ai.decision.questions` (names) and `ai.decision.answer.<question>.{type,value,confidence}` (see `DecisionOpenTelemetryAttributes`). `state` is only recorded with `logState: true`.

```typescript
bridge.useDecision(await createDecisionOpenTelemetryMiddleware({ serviceName: 'triage' }));
```

### `createDecisionValidationMiddleware`

Before the call: rejects an empty question set, a question without a valid `type` or non-empty `instructions`, a choice with fewer than 2 criteria, a score with fewer than 2 distinct levels, blank criteria keys or labels, and (with `maxStateBytes`) an oversized state. After the call: `validateDecisionResponse` from `aimatey-utils`; its warnings are merged into `metadata.warnings`, or thrown as a `ValidationError` with `strict: true`.

```typescript
bridge.useDecision(createDecisionValidationMiddleware({ maxStateBytes: 60_000, strict: true }));
```

This middleware is **not capability-aware**: supported question types, option / level / question-count limits and image support depend on the backend, and are checked by the pre-flight validation in `aimatey-core`, not here.

## API Reference

See the TypeScript definitions for detailed API documentation.

## License

MIT - see [LICENSE](./LICENSE) for details.
