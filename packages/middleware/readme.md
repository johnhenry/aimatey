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

## API Reference

See the TypeScript definitions for detailed API documentation.

## License

MIT - see [LICENSE](./LICENSE) for details.
