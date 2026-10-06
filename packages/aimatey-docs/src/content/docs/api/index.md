---
title: "API Reference"
description: "Entry point to the aimatey API reference: Bridge, Router, middleware, types, errors, and per-package documentation."
---

Complete API documentation for all aimatey packages.

## Core API

Comprehensive reference for the core aimatey APIs:

### [Bridge API](/api/bridge)

Complete reference for the `Bridge` class - connecting frontend and backend adapters.

- Constructor and configuration
- Request/response methods (chat, chatStream, execute, decide, decideFrom, decideBatch)
- Middleware management
- Event handling
- Error handling

[View Bridge API →](/api/bridge)

---

### [Router API](/api/router)

Complete reference for the `Router` class - intelligent multi-backend routing.

- Routing strategies (round-robin, priority, weighted, custom)
- Backend management
- Health monitoring
- Failover and fallback
- Advanced routing patterns

[View Router API →](/api/router)

---

### [Middleware API](/api/middleware)

Complete reference for all built-in middleware and the Middleware interface.

- Logging, caching, retry, transform
- Cost tracking, validation, security
- OpenTelemetry tracing
- Creating custom middleware
- Middleware composition

[View Middleware API →](/api/middleware)

---

### [Types API](/api/types)

Complete TypeScript type definitions.

- IR types (IRChatRequest, IRChatResponse, etc.)
- Adapter interfaces (BackendAdapter, FrontendAdapter)
- Configuration types (BridgeConfig, RouterConfig)
- Utility types and type guards

[View Types API →](/api/types)

---

### [Errors API](/api/errors)

Complete error handling reference.

- Error hierarchy (AdapterError, ProviderError, ValidationError, etc.)
- Error codes and descriptions
- Error handling patterns
- Best practices

[View Errors API →](/api/errors)

---

## Core Packages

### @johnhenry/aimatey-core

The foundational package containing Bridge, Router, and core functionality.

**Key Exports:**
- `Bridge` - Connect frontend and backend adapters → [API](/api/bridge)
- `Router` - Route requests to multiple backends → [API](/api/router)
- `MiddlewareStack` - Manage middleware chain

[View Package Documentation →](/packages/core)

### @johnhenry/aimatey-types

TypeScript type definitions for all packages.

**Key Types:**
- `IRChatRequest` - Intermediate Representation request format
- `IRChatResponse` - IR response format
- `IRStreamChunk` - Streaming chunk format
- `BackendAdapter` - Backend interface
- `FrontendAdapter` - Frontend interface
- `Middleware` - Middleware function type

[View Full API Documentation →](/api/all-packages)

### @johnhenry/aimatey-errors

Error classes and utilities.

**Key Exports:**
- `AdapterError` - Base error class for every adapter error
- `ProviderError` - Provider API returned an error
- `NetworkError` - Network request failed
- `RateLimitError` - Rate limit exceeded
- `AuthenticationError` - Invalid API key
- `ValidationError` - Request validation failed

[View Full API Documentation →](/api/all-packages)

## Adapter Packages

### Frontend Adapters

Parse different input formats into IR.

- **@johnhenry/aimatey-frontend/openai** - OpenAI chat completion format
- **@johnhenry/aimatey-frontend/anthropic** - Anthropic messages API format
- **@johnhenry/aimatey-frontend/gemini** - Google Gemini format
- **@johnhenry/aimatey-frontend/mistral** - Mistral format
- **@johnhenry/aimatey-frontend/ollama** - Ollama format
- **@johnhenry/aimatey-frontend/chrome-ai** - Chrome built-in AI format
- **@johnhenry/aimatey-frontend/generic** - Generic IR format

[View Frontend Adapters →](/packages/frontend)

### Backend Adapters

Convert IR to provider-specific formats and execute requests.

**24 Supported Providers:**
- @johnhenry/aimatey-backend/openai
- @johnhenry/aimatey-backend/anthropic
- @johnhenry/aimatey-backend/gemini
- @johnhenry/aimatey-backend/mistral
- @johnhenry/aimatey-backend/ollama
- @johnhenry/aimatey-backend/groq
- ... and 18 more

[View All Backend Providers →](/packages/backend)

## Middleware Packages

### @johnhenry/aimatey-middleware

Built-in middleware for common use cases.

**Available Middleware:**
- `createLoggingMiddleware()` - Request/response logging
- `createCachingMiddleware()` - Response caching
- `createRetryMiddleware()` - Automatic retry with backoff
- `createTransformMiddleware()` - Request/response transformation
- `createCostTrackingMiddleware()` - Track API costs
- `createOpenTelemetryMiddleware()` - Distributed tracing (async)
- `createValidationMiddleware()` - Request validation
- `createSecurityMiddleware()` - PII redaction, sanitization, prompt-injection detection, HTTP header policy
- `createConversationHistoryMiddleware()` - Conversation state

[View Middleware Guide →](/packages/middleware)

## Integration Packages

### @johnhenry/aimatey-http

HTTP server integration for Express, Fastify, Hono, and Node.js http.

**Key Exports:**
- `ExpressMiddleware` - Express.js integration
- `FastifyHandler` - Fastify handler
- `HonoMiddleware` - Hono middleware
- `NodeHTTPListener` - Node.js http integration

[View Examples →](/examples)

## Quick Links

### By Use Case

- **Building a Chat App?** → [Tutorial: Building a Chat API](/tutorials/beginner/building-chat-api)
- **HTTP API?** → [Examples](/examples)
- **Multi-Provider Routing?** → [Tutorial: Multi-Provider](/tutorials/beginner/multi-provider)
- **Need Caching?** → [Middleware Package](/packages/middleware)
- **Testing?** → [Testing Guide](/guides/testing)

### By Package

- [@johnhenry/aimatey-core](/packages/core) - Bridge, Router, Middleware
- [@johnhenry/aimatey-frontend](/packages/frontend) - Frontend adapters
- [@johnhenry/aimatey-backend](/packages/backend) - Backend adapters
- [@johnhenry/aimatey-middleware](/packages/middleware) - Middleware
- [All 23 published packages](/api/all-packages) - HTTP, React, patterns, MCP, wrappers, CLI, native backends, and more

## Common Interfaces

### BackendAdapter Interface

```typescript
interface BackendAdapter {
  readonly metadata: AdapterMetadata;
  fromIR(request: IRChatRequest): unknown;
  toIR(response: unknown, originalRequest: IRChatRequest, latencyMs: number): IRChatResponse;
  execute(request: IRChatRequest, signal?: AbortSignal): Promise<IRChatResponse>;
  /** Returns the stream itself, not a Promise */
  executeStream(request: IRChatRequest, signal?: AbortSignal): IRChatStream;
  healthCheck?(): Promise<boolean>;
}
```

### FrontendAdapter Interface

```typescript
interface FrontendAdapter {
  readonly metadata: AdapterMetadata;
  toIR(request: unknown): Promise<IRChatRequest>;
  fromIR(response: IRChatResponse): Promise<unknown>;
  fromIRStream(stream: IRChatStream): AsyncGenerator<unknown, void, undefined>;
  validate?(request: unknown): Promise<void>;
}
```

### Middleware Interface

```typescript
type Middleware = (
  context: MiddlewareContext,
  next: () => Promise<IRChatResponse>
) => Promise<IRChatResponse>;

// context.request is the IR request (readable and replaceable),
// context.state is a per-request scratch object shared between middleware.
```

## TypeScript Support

All packages include full TypeScript definitions. Import types:

```typescript
import type {
  IRChatRequest,
  IRChatResponse,
  IRStreamChunk,
  BackendAdapter,
  FrontendAdapter,
  Middleware
} from '@johnhenry/aimatey-types';
```

## Version Compatibility

All aimatey packages use synchronized versioning. Always use matching versions across packages:

```json
{
  "dependencies": {
    "@johnhenry/aimatey-core": "^0.2.0",
    "@johnhenry/aimatey-frontend": "^0.2.0",
    "@johnhenry/aimatey-backend": "^0.2.0"
  }
}
```

## Auto-Generated Documentation

Detailed API documentation is auto-generated from TypeScript source code using TypeDoc:

- [View All Packages →](/api/all-packages) - Complete directory of all 23 published packages, with symbol-level reference generated from source

## Contributing

Found an issue with the API? Want to request a new feature?

- [Report an Issue](https://github.com/johnhenry/aimatey/issues)
- [Contributing Guide](/contributing)
- [GitHub Repository](https://github.com/johnhenry/aimatey)

---

**Explore the API:**
- [Getting Started](/getting-started/installation)
- [Examples](/examples)
- [IR Format Guide](/guides/architecture/ir-format)
- [Packages](/packages/overview)
