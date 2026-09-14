---
title: "Core Concepts"
description: "The core ideas behind aimatey: frontend and backend adapters, the intermediate representation (IR), Bridge, Router, and middleware."
---

Understanding the four fundamental concepts in aimatey: **Bridge**, **Router**, **Middleware**, and **Intermediate Representation (IR)**.

## The Problem aimatey Solves

Every AI provider has their own API format:

```typescript
// OpenAI format
{
  model: "gpt-4",
  messages: [{ role: "user", content: "Hello" }],
  max_tokens: 100
}

// Anthropic format
{
  model: "claude-haiku-4-5-20251001",
  messages: [{ role: "user", content: "Hello" }],
  max_tokens: 100
}

// Gemini format
{
  model: "gemini-1.5-flash",
  contents: [{ role: "user", parts: [{ text: "Hello" }] }],
  generationConfig: { maxOutputTokens: 100 }
}
```

Switching providers means rewriting your code. aimatey solves this by using an **Intermediate Representation** that all providers can convert to/from.

## Architecture Overview

```
┌─────────────────┐
│   Your Code     │  Write in any format (OpenAI, Anthropic, etc.)
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Frontend Adapter│  Parses your input format
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  IR (Universal) │  Provider-agnostic format
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Backend Adapter │  Converts IR to provider format
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  AI Provider    │  OpenAI, Anthropic, Gemini, etc.
└─────────────────┘
```

## 1. Intermediate Representation (IR)

The **IR** is a universal format that all providers can convert to and from. It's the core of aimatey's portability.

### IR Structure

```typescript
interface IRChatRequest {
  messages: readonly IRMessage[];
  // Model and sampling options live under `parameters`
  parameters?: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    // ... topK, seed, stopSequences, penalties, user, custom
  };
  // `metadata` is required
  metadata: {
    requestId: string;
    timestamp: number;
    // ... provenance, warnings, custom
  };
  stream?: boolean;
  // ... tools, toolChoice, responseFormat, streamMode
}
```

### Why IR Matters

- ✅ **Provider-agnostic**: Same format works with all backends
- ✅ **Stable**: Your code doesn't break when providers change their APIs
- ✅ **Extensible**: Add new providers without changing your code
- ✅ **Testable**: Mock backends easily with consistent interfaces

### Example: IR in Action

```typescript
// Your code uses IR directly (no frontend adapter needed)
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';

const backend = new AnthropicBackendAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// IR format request
const irRequest = {
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
  parameters: {
    model: 'claude-haiku-4-5-20251001',
    temperature: 0.7,
    maxTokens: 100
  },
  metadata: {
    requestId: crypto.randomUUID(),
    timestamp: Date.now()
  }
};

// Execute with IR
const response = await backend.execute(irRequest);
console.log(response.message.content);
```

## 2. Bridge

The **Bridge** connects a **Frontend Adapter** (input format) with a **Backend Adapter** (AI provider).

### Bridge Pattern

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),    // Accept OpenAI format
  new AnthropicBackendAdapter({   // Execute on Anthropic
    apiKey: process.env.ANTHROPIC_API_KEY
  })
);
```

### Frontend Adapters

Frontend adapters parse different input formats into IR:

- **OpenAIFrontendAdapter** - OpenAI's chat completion format
- **AnthropicFrontendAdapter** - Anthropic's messages API format
- **GeminiFrontendAdapter** - Google Gemini's format
- **MistralFrontendAdapter** - Mistral's format
- **GenericFrontendAdapter** - Already in IR format

### Backend Adapters

Backend adapters convert IR to provider-specific formats:

- **24 different providers** (OpenAI, Anthropic, Gemini, Ollama, Groq, etc.)
- Each handles API specifics (authentication, rate limits, retries)
- Consistent interface: `execute()` and `executeStream()`

### Bridge with Middleware

Add middleware to enhance functionality:

```typescript
import { createLoggingMiddleware } from '@johnhenry/aimatey-middleware';

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new AnthropicBackendAdapter({ apiKey }),
  [
    createLoggingMiddleware({ level: 'info' })
  ]
);
```

## 3. Router

The **Router** routes requests to multiple backends based on strategies.

### Basic Router

```typescript
import { createRouter } from '@johnhenry/aimatey-core';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';

const router = createRouter({
  routingStrategy: 'round-robin'
})
  .register('openai', new OpenAIBackendAdapter({ apiKey: openaiKey }))
  .register('anthropic', new AnthropicBackendAdapter({ apiKey: anthropicKey }));

// Router is a backend, so use it in a Bridge
const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  router
);
```

### Routing Strategies

#### 1. Round Robin

Distribute load evenly:

```typescript
const router = createRouter({
  routingStrategy: 'round-robin'
});

// Request 1 → openai
// Request 2 → anthropic
// Request 3 → openai
// ...
```

#### 2. Model-Based

Route by model name:

```typescript
const router = createRouter({
  routingStrategy: 'model-based'
})
  .register('openai', openaiBackend)
  .register('anthropic', anthropicBackend);

// gpt-4 → openai
// claude-3 → anthropic
```

#### 3. Custom Strategy

Route based on custom logic:

Set `routingStrategy: 'custom'` and supply `customRouter`, an async function
returning the *name* of a registered backend (or `null` to fall through):

```typescript
const router = createRouter({
  routingStrategy: 'custom',
  customRouter: async (request) => {
    // Route expensive queries to powerful models
    const first = request.messages[0].content;
    const isComplex = typeof first === 'string' && first.length > 1000;
    return isComplex ? 'openai' : 'anthropic';
  }
});
```

#### 4. Fallback Chain

Automatic failover:

```typescript
router.setFallbackChain(['openai', 'anthropic', 'groq']);

// Try openai → if fails, try anthropic → if fails, try groq
```

### Advanced Routing

#### Parallel Dispatch

Query multiple backends simultaneously:

```typescript
const result = await router.dispatchParallel(request, {
  backends: ['openai', 'anthropic', 'gemini'],
  strategy: 'all' // or 'first' or 'fastest'
});

// Get responses from all 3 providers for comparison
console.log(result.successfulBackends);
for (const entry of result.allResponses ?? []) {
  console.log(entry.backend, entry.response.message.content);
}
```

#### Health Checking

Monitor backend health:

The router has no event emitter - check health on demand instead:

```typescript
const health = await router.checkHealth();
// { openai: true, anthropic: true, groq: false }

for (const [backend, healthy] of Object.entries(health)) {
  console.log(`${backend} is ${healthy ? 'healthy' : 'unhealthy'}`);
}

// One backend at a time
const openaiHealthy = await router.checkHealth('openai'); // boolean
```

Set `healthCheckInterval` in `RouterConfig` to have the router poll in the
background as well.

## 4. Middleware

**Middleware** intercepts requests and responses to add functionality.

### Middleware Pattern

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import {
  createLoggingMiddleware,
  createCachingMiddleware,
  createRetryMiddleware
} from '@johnhenry/aimatey-middleware';

const bridge = new Bridge(
  frontend,
  backend,
  [
    createLoggingMiddleware({ level: 'info' }),
    createCachingMiddleware({ ttl: 300000 }),  // 5 minutes
    createRetryMiddleware({ maxAttempts: 3 })
  ]
);
```

### Built-in Middleware

#### 1. Logging

Log requests and responses:

```typescript
createLoggingMiddleware({
  level: 'info',          // 'debug' | 'info' | 'warn' | 'error'
  sanitize: true,         // Remove sensitive data
  includeTimings: true    // Add timing information
})
```

#### 2. Caching

Cache responses for identical requests:

```typescript
createCachingMiddleware({
  ttl: 300000,           // Cache for 5 minutes
  maxSize: 100,          // Max 100 cached items
  keyGenerator: (req) => JSON.stringify(req)  // Custom cache key
})
```

**Performance**: 1000x+ speedup for duplicate requests!

#### 3. Retry

Automatic retry with exponential backoff:

```typescript
createRetryMiddleware({
  maxAttempts: 3,
  initialDelay: 1000,    // Start with 1 second
  maxDelay: 10000,       // Max 10 seconds
  backoffMultiplier: 2,  // Double each time
  retryOn: ['rate_limit', 'server_error']
})
```

#### 4. Transform

Modify requests/responses:

```typescript
createTransformMiddleware({
  transformRequest: (req) => ({
    ...req,
    messages: [
      { role: 'system', content: 'You are helpful' },
      ...req.messages
    ]
  }),
  transformResponse: (res) => {
    // Modify response
    return res;
  }
})
```

#### 5. Cost Tracking

Track API costs:

```typescript
createCostTrackingMiddleware({
  onCost: (cost) => {
    console.log(`${cost.provider}/${cost.model}: $${cost.totalCost.toFixed(4)}`);
  }
})
```

#### 6. OpenTelemetry

Add distributed tracing:

`createOpenTelemetryMiddleware` is async - it loads the optional
`@opentelemetry/*` packages at call time, so it must be awaited.

```typescript
const tracing = await createOpenTelemetryMiddleware({
  serviceName: 'my-ai-service',
  endpoint: 'http://localhost:4318/v1/traces'
});

bridge.use(tracing);
```

### Custom Middleware

Create your own:

```typescript
import type { Middleware } from '@johnhenry/aimatey-types';

// Middleware is a function: everything before `await next()` runs on the way
// in, everything after it runs on the way out.
const customMiddleware: Middleware = async (context, next) => {
  console.log('Request:', context.request);

  const response = await next();

  console.log('Response:', response);
  return response;
};

bridge.use(customMiddleware);
```

### Middleware Order

Middleware executes in order:

```
Request Flow:
  [Logging] → [Transform] → [Retry] → [Backend]

Response Flow:
  [Backend] → [Retry] → [Transform] → [Logging]
```

## Putting It All Together

Here's a production-ready example combining all concepts:

```typescript
import { Bridge, createRouter } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';
import {
  createLoggingMiddleware,
  createCachingMiddleware,
  createRetryMiddleware,
  createCostTrackingMiddleware
} from '@johnhenry/aimatey-middleware';

// 1. Create backends
const openaiBackend = new OpenAIBackendAdapter({
  apiKey: process.env.OPENAI_API_KEY
});

const anthropicBackend = new AnthropicBackendAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// 2. Create router with fallback
const router = createRouter({
  routingStrategy: 'model-based'
})
  .register('openai', openaiBackend)
  .register('anthropic', anthropicBackend)
  .setFallbackChain(['openai', 'anthropic']);

// 3. Add middleware
const middleware = [
  createLoggingMiddleware({ level: 'info' }),
  createCachingMiddleware({ ttl: 300000 }),
  createRetryMiddleware({ maxAttempts: 3 }),
  createCostTrackingMiddleware({
    onCost: (cost, provider) => console.log(`Cost: $${cost}`)
  })
];

// 4. Create bridge
const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  router,
  middleware
);

// 5. Use it
const response = await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello!' }]
});

// Features you get:
// ✅ Write in OpenAI format
// ✅ Automatic provider routing
// ✅ Fallback if primary fails
// ✅ Request/response logging
// ✅ Response caching
// ✅ Automatic retries
// ✅ Cost tracking
```

## Key Takeaways

1. **IR (Intermediate Representation)** - Universal format that makes portability possible
2. **Bridge** - Connects frontend (input format) with backend (provider)
3. **Router** - Routes to multiple backends with strategies and fallback
4. **Middleware** - Adds logging, caching, retry, cost tracking, and more

## Next Steps

- **[Your First Bridge](/getting-started/your-first-bridge)** - Build a bridge step-by-step
- **[IR Format Guide](/guides/architecture/ir-format)** - Deep dive into IR format
- **[Testing Guide](/guides/testing)** - Testing your integrations
- **[Middleware Package](/packages/middleware)** - All middleware types
- **[Examples](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples)** - Working code examples

---

**Ready to build?** Continue to [Your First Bridge](/getting-started/your-first-bridge) for a hands-on tutorial!
