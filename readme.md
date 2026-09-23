<p align="center">
  <img src="logo.png" alt="aimatey logo" width="200" />
</p>

# aimatey - Universal AI Adapter System

[![CI](https://github.com/johnhenry/aimatey/actions/workflows/ci.yml/badge.svg)](https://github.com/johnhenry/aimatey/actions/workflows/ci.yml)
[![license](https://img.shields.io/github/license/johnhenry/aimatey.svg)](LICENSE)

Full documentation: [opensource.johnhenry.me/aimatey](https://opensource.johnhenry.me/aimatey/)

Provider-agnostic interface for AI APIs. Write once, run anywhere.

> **Note:** All packages in this monorepo now publish under the `@johnhenry` npm scope
> (e.g. `aimatey-core` → `@johnhenry/aimatey-core`), restarting at version `0.0.0`. See each
> package's readme.md for its prior unscoped name and last published version. The root
> `aimatey-monorepo` package itself is private and not published to npm -- see
> [Which package do I want?](#which-package-do-i-want) below for the individual published
> packages, each of which carries its own npm badge on its own readme.

## Which package do I want?

| I want to... | Start with |
|---|---|
| Call any provider through one interface | [`aimatey-core`](./packages/aimatey-core) (`@johnhenry/aimatey-core`) -- `Bridge`, `Router`, `MiddlewareStack`; everything else builds on it |
| Get started with the least setup | [`aimatey`](./packages/aimatey) (`@johnhenry/aimatey`) -- the umbrella package that re-exports the common pieces |
| Add a specific provider's backend | [`backend`](./packages/backend) (`@johnhenry/aimatey-backend`) -- all 30 server-side provider adapters, or its subpath imports |
| Run in the browser | [`backend-browser`](./packages/backend-browser) (`@johnhenry/aimatey-backend-browser`) -- the browser-safe adapter subset (Chrome AI, LiteRT-LM, mock/function) |
| Accept a client's request format (OpenAI/Anthropic/Gemini/...) | [`frontend`](./packages/frontend) (`@johnhenry/aimatey-frontend`) |
| Add logging, caching, retry, cost tracking, or PII redaction | [`middleware`](./packages/middleware) (`@johnhenry/aimatey-middleware`) -- all 10 middleware types in one package |
| Route LLM-authored code into a sandbox for tool calling | [`@johnhenry/aimatey-middleware-andbox`](https://github.com/johnhenry/aimatey-middleware-andbox) -- separate repo, not in this monorepo; see [Family](#family) |
| Serve an OpenAI-compatible HTTP API | [`http`](./packages/http) (`@johnhenry/aimatey-http`) plus [`http.core`](./packages/http.core) -- framework adapters for Express/Fastify/Hono/Koa/Node/Deno |
| Use it from React | [`react-core`](./packages/react-core) first (`useChat`/`useCompletion`); `react-hooks`, `react-stream`, `react-nextjs` add more |
| Drop in as an OpenAI/Anthropic SDK replacement | [`wrapper`](./packages/wrapper) (`@johnhenry/aimatey-wrapper`) |
| Call MCP tools from the agentic tool loop | [`mcp`](./packages/mcp) (`@johnhenry/aimatey-mcp`) |
| Use a validated production pattern (routing, batching, failover) | [`patterns`](./packages/patterns) (`@johnhenry/aimatey-patterns`) |
| Run a local model (llama.cpp, Apple Foundation Models, Laya) | `native-node-llamacpp` / `native-apple` / `native-laya` / `native-model-runner` |
| Convert between request/response formats from the CLI | [`cli`](./packages/cli) (`@johnhenry/aimatey-cli`, binary `ai-matey`) |

The [`## Package Reference`](#package-reference) tables below group every
package by category with links to its own readme.

## Why aimatey?

**Same code, any provider.** Switch between OpenAI, Anthropic, Gemini, Ollama, and 26 other providers (30 total) without changing your application code.

```typescript
// Your code stays the same...
const response = await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello!' }],
});

// ...only the backend changes
new OpenAIBackendAdapter({ apiKey: '...' })      // → OpenAI
new AnthropicBackendAdapter({ apiKey: '...' })   // → Anthropic
new GeminiBackendAdapter({ apiKey: '...' })      // → Google Gemini
new OllamaBackendAdapter({ baseURL: '...' })     // → Local Ollama
new GroqBackendAdapter({ apiKey: '...' })        // → Groq (fast inference)
```

## Quick Start

### Basic Bridge

Accept requests in one format, execute on any provider:

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';

// Accept OpenAI format → Execute on Anthropic
const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY })
);

const response = await bridge.chat({
  model: 'gpt-4',  // Mapped to claude-3-5-sonnet automatically
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Streaming

```typescript
const stream = await bridge.chatStream({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Tell me a story' }],
  stream: true,
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

### Router with Fallback

Route requests to multiple backends with automatic fallback:

```typescript
import { Bridge, createRouter } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';

// Create router and register backends
const router = createRouter({
  routingStrategy: 'model-based',
  fallbackStrategy: 'sequential',
})
  .register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY }))
  .register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }))
  .setFallbackChain(['openai', 'anthropic']);

// Use router as a backend in a Bridge
const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

// If OpenAI fails, automatically falls back to Anthropic
const response = await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello!' }],
});
```

### Parallel Dispatch

Query multiple models simultaneously for comparison or consensus:

```typescript
import { createRouter } from '@johnhenry/aimatey-core';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';
import { GeminiBackendAdapter } from '@johnhenry/aimatey-backend/gemini';

// Create router with multiple backends
const router = createRouter()
  .register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY }))
  .register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }))
  .register('gemini', new GeminiBackendAdapter({ apiKey: process.env.GEMINI_API_KEY }));

// Create IR request
const request = {
  messages: [{ role: 'user', content: 'What is 2+2?' }],
  parameters: { model: 'gpt-4' },
  metadata: { requestId: crypto.randomUUID(), timestamp: Date.now(), provenance: {} },
};

// Get responses from ALL backends in parallel
const result = await router.dispatchParallel(request, {
  strategy: 'all',
  backends: ['openai', 'anthropic', 'gemini'],
});

result.allResponses?.forEach(({ backend, response, latencyMs }) => {
  console.log(`${backend}: ${response.message.content} (${latencyMs}ms)`);
});
```

### Middleware

**Consolidated Package:** [`@johnhenry/aimatey-middleware`](./packages/middleware)

All 10 middleware types in one package for cross-cutting concerns:

```typescript
import {
  createLoggingMiddleware,
  createCachingMiddleware,
  createRetryMiddleware,
  createTransformMiddleware,
  createValidationMiddleware,
  createTelemetryMiddleware,
  createOpenTelemetryMiddleware,
  createCostTrackingMiddleware,
  createSecurityMiddleware,
  createConversationHistoryMiddleware
} from '@johnhenry/aimatey-middleware';

bridge
  .use(createLoggingMiddleware({ level: 'info' }))
  .use(createValidationMiddleware({ validateIRFormat: true }))
  .use(createSecurityMiddleware({ redactPII: true, promptInjectionAction: 'warn' }))
  .use(createRetryMiddleware({ maxAttempts: 3, backoffMultiplier: 2 }))
  .use(createCachingMiddleware({ ttl: 3600 }))
  .use(createCostTrackingMiddleware())
  .use(createTelemetryMiddleware())
  .use(createOpenTelemetryMiddleware());
```

**Available Middleware:**
- **Logging** - Request/response logging with configurable levels
- **Caching** - Response caching with TTL and custom key generation
- **Retry** - Automatic retries with exponential backoff
- **Transform** - Request/response transformation pipeline
- **Validation** - Input validation & sanitization
- **Telemetry** - Metrics collection and reporting
- **OpenTelemetry** - Distributed tracing integration (OpenTelemetry standard)
- **Cost Tracking** - Token usage and cost tracking per request
- **Security** - PII redaction, content sanitization, prompt-injection detection, HTTP header policy
- **Conversation History** - Automatic context management and persistence

### HTTP Server

Serve an OpenAI-compatible API with any backend:

```typescript
import express from 'express';
import { ExpressMiddleware } from '@johnhenry/aimatey-http/express';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY })
);

const app = express();
app.use(express.json());
app.use('/v1/chat/completions', ExpressMiddleware(bridge, { streaming: true }));
app.listen(3000);

// Now clients can use OpenAI SDK pointed at localhost:3000
```

### React Hooks

```tsx
import { useChat } from '@johnhenry/aimatey-react-core';

function ChatComponent() {
  const { messages, input, handleInputChange, handleSubmit } = useChat({
    api: '/api/chat',
  });

  return (
    <form onSubmit={handleSubmit}>
      {messages.map((m) => (
        <div key={m.id}>{m.content}</div>
      ))}
      <input value={input} onChange={handleInputChange} />
    </form>
  );
}
```

### React Hooks - Direct Mode

Use backend adapters directly without HTTP (great for Electron, browser extensions, testing):

```tsx
import { useChat } from '@johnhenry/aimatey-react-core';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';

const backend = new OpenAIBackendAdapter({ apiKey: process.env.REACT_APP_OPENAI_API_KEY });

function ChatComponent() {
  const { messages, input, handleInputChange, handleSubmit } = useChat({
    direct: {
      backend,
      systemPrompt: 'You are a helpful assistant.',
    },
  });

  return (
    <form onSubmit={handleSubmit}>
      {messages.map((m) => (
        <div key={m.id}>{m.content}</div>
      ))}
      <input value={input} onChange={handleInputChange} />
    </form>
  );
}
```

### SDK Wrapper

Use OpenAI SDK-style code with any backend:

```typescript
import { OpenAI } from '@johnhenry/aimatey-wrapper/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';

// Create a backend adapter
const backend = new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY });

// Wrap it with OpenAI SDK interface
const client = OpenAI(backend);

// Use familiar OpenAI SDK patterns - works with any backend!
const response = await client.chat.completions.create({
  model: 'claude-3-5-sonnet',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0].message.content);
```

### Embeddings

Generate embeddings through the same provider-agnostic interface:

```typescript
const response = await bridge.embed(['first document', 'second document'], {
  model: 'text-embedding-3-small',
  dimensions: 512, // normalized client-side when the provider lacks native support
});

console.log(response.embeddings[0].vector.length); // 512
```

Supported backends: OpenAI, Mistral, Gemini, Cohere, Ollama, Together, Fireworks, DeepInfra,
NVIDIA, LM Studio. Routers route embedding requests with the same fallback and circuit-breaker
behavior as chat. Caching and cost-tracking middleware: `bridge.useEmbed(createEmbeddingCachingMiddleware())`.

### Agentic Tool Loop

Let the model call your tools until it reaches an answer:

```typescript
const result = await bridge.runTools({
  prompt: 'What is the weather in SF?',
  tools: {
    get_weather: {
      description: 'Get current weather for a city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
      execute: async ({ city }) => fetchWeather(city),
    },
  },
});

console.log(result.text); // final answer after tool round-trips
```

Tool calls stream too: both OpenAI and Anthropic backends emit `tool_use` chunks with incremental
arguments, and frontend adapters re-emit them in their native streaming formats.

### Production Patterns

The validated pattern library is importable from [`@johnhenry/aimatey-patterns`](./packages/patterns):

```typescript
import { createComplexityRouter, createBatchProcessor } from '@johnhenry/aimatey-patterns';
```

Complexity-based routing, parallel aggregation, failover, cost optimization with budget windows,
and rate-limited batch processing.

### Production HTTP Endpoints

The HTTP handler ships health, metrics, and embeddings endpoints for every framework adapter:

```typescript
const handler = new CoreHTTPHandler({
  bridge,
  health: { enabled: true },      // GET /health, /health/ready, /health/live
  metrics: { enabled: true },     // GET /metrics (Prometheus text format)
  embeddings: { enabled: true },  // POST /v1/embeddings (OpenAI-compatible)
});
```

Real-time streaming over WebSocket (any socket implementation — ws, Deno, Bun):

```typescript
import { createWebSocketHandler } from '@johnhenry/aimatey-http/websocket';
new WebSocketServer({ port: 8080 }).on('connection', createWebSocketHandler(bridge));
```

### Model Registry

Pricing, context windows, and capabilities come from a runtime-extensible registry — register new
models the day they ship instead of waiting for a library release:

```typescript
import { registerModels } from '@johnhenry/aimatey-utils';

registerModels([
  {
    id: 'gpt-6-preview',
    provider: 'openai',
    family: 'gpt-6',
    contextWindow: 800000,
    pricing: { inputPer1M: 4.0, outputPer1M: 20.0 },
  },
]);
```

## Documentation

| Document | Description |
|----------|-------------|
| [API Reference](./docs/api.md) | Complete API documentation for all components |
| [IR Format Guide](./docs/IR-FORMAT.md) | Comprehensive Intermediate Representation format specification |
| [Feature Guides](./docs/GUIDES.md) | In-depth guides for parallel dispatch, CLI tools, response conversion |
| [Roadmap](./docs/ROADMAP.md) | Project roadmap and planned features |

## Package Reference

### Core Packages

| Package | Description | Documentation |
|---------|-------------|---------------|
| [`@johnhenry/aimatey`](./packages/aimatey) | Main umbrella package | [README](./packages/aimatey/readme.md) |
| [`@johnhenry/aimatey-core`](./packages/aimatey-core) | Bridge, Router, MiddlewareStack | [README](./packages/aimatey-core/readme.md) |
| [`@johnhenry/aimatey-types`](./packages/aimatey-types) | TypeScript type definitions | [README](./packages/aimatey-types/readme.md) |
| [`@johnhenry/aimatey-errors`](./packages/aimatey-errors) | Error classes and utilities | [README](./packages/aimatey-errors/readme.md) |
| [`@johnhenry/aimatey-utils`](./packages/aimatey-utils) | Shared utility functions | [README](./packages/aimatey-utils/readme.md) |
| [`@johnhenry/aimatey-testing`](./packages/aimatey-testing) | Testing utilities and mocks | [README](./packages/aimatey-testing/readme.md) |
| [`@johnhenry/aimatey-cli`](./packages/cli) | CLI and conversion utilities | [README](./packages/cli/readme.md) |
| [`@johnhenry/aimatey-patterns`](./packages/patterns) | Production integration patterns | [README](./packages/patterns/readme.md) |

### Backend Adapters

**Consolidated Package:** [`@johnhenry/aimatey-backend`](./packages/backend) | [📚 Documentation](./packages/backend/readme.md)

All server-side provider adapters in one package. Import from main or use subpath imports:

```typescript
import { OpenAIBackendAdapter, AnthropicBackendAdapter } from '@johnhenry/aimatey-backend';
// or
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';
```

**Included Providers:**
- OpenAI (GPT-4, GPT-3.5)
- Anthropic (Claude)
- Google Gemini
- Mistral AI
- Cohere
- Groq
- Ollama (local)
- AWS Bedrock
- Azure OpenAI
- DeepSeek
- Fireworks
- Together AI
- Perplexity
- OpenRouter
- Anyscale
- DeepInfra
- Cerebras
- AI21 Labs
- xAI (Grok)
- NVIDIA NIM
- LM Studio (local)
- Hugging Face
- Cloudflare Workers AI
- Replicate
- Inception Labs (Mercury)
- Moonshot AI (Kimi)
- SambaNova
- GitHub Models (free via any GitHub account)
- Alibaba Cloud Model Studio / DashScope (Qwen)
- OmniRoute (self-hosted gateway, 290+ providers, no API key required by default)

**Typed-decision (not chat) provider:**
- TypeSafe (Jev) -- typed `choice`/`score`/`noul` questions over a state, answered with calibrated probabilities via `Bridge.decide()`, not `chat()`

**Browser-Compatible Package:** [`@johnhenry/aimatey-backend-browser`](./packages/backend-browser)

Subset of adapters that work in browser environments:
- Chrome AI
- LiteRT-LM (on-device Gemma via WebGPU)
- Mock (testing)
- Function (testing)

### Frontend Adapters

**Consolidated Package:** [`@johnhenry/aimatey-frontend`](./packages/frontend) | [📚 Documentation](./packages/frontend/readme.md)

All frontend request adapters in one package:

```typescript
import { OpenAIFrontendAdapter, AnthropicFrontendAdapter } from '@johnhenry/aimatey-frontend';
```

**Included Adapters:**
- OpenAI format
- Anthropic format
- Gemini format
- Mistral format
- Ollama format
- Chrome AI format
- Generic (IR passthrough)
- TypeSafe (Jev) -- `@typesafe-ai/sdk`-shaped calls, translated to the Decision IR
- Laya -- `Router.predict()`-shaped calls, translated to the Decision IR (frontend only; no hosted API to pair a backend with yet)

### HTTP Integrations

**Consolidated Package:** [`@johnhenry/aimatey-http`](./packages/http) | [📚 Documentation](./packages/http/readme.md)

Framework adapters for serving AI endpoints. Core utilities in [`@johnhenry/aimatey-http-core`](./packages/http.core).

**Supported Frameworks:**
- Express.js
- Fastify
- Hono
- Koa
- Node.js http
- Deno

### Middleware

**Consolidated Package:** [`@johnhenry/aimatey-middleware`](./packages/middleware) | [📚 Documentation](./packages/middleware/readme.md)

All middleware in one package:

```typescript
import {
  createLoggingMiddleware,
  createCachingMiddleware,
  createRetryMiddleware
} from '@johnhenry/aimatey-middleware';
```

**Included Middleware:**
- Logging - Request/response logging
- Caching - Response caching
- Retry - Automatic retries with backoff
- Transform - Request/response transforms
- Validation - Request validation
- Telemetry - Metrics collection
- OpenTelemetry - Distributed tracing
- Cost Tracking - Usage & cost tracking
- Security - Rate limiting & security
- Conversation History - Context management

### React Integration

| Package | Purpose | Documentation |
|---------|---------|---------------|
| [`@johnhenry/aimatey-react-core`](./packages/react-core) | Core hooks (useChat, useCompletion) | [README](./packages/react-core/readme.md) |
| [`@johnhenry/aimatey-react-hooks`](./packages/react-hooks) | Additional hooks | [README](./packages/react-hooks/readme.md) |
| [`@johnhenry/aimatey-react-stream`](./packages/react-stream) | Streaming components | [README](./packages/react-stream/readme.md) |
| [`@johnhenry/aimatey-react-nextjs`](./packages/react-nextjs) | Next.js App Router | [README](./packages/react-nextjs/readme.md) |

### SDK Wrappers

**Consolidated Package:** [`@johnhenry/aimatey-wrapper`](./packages/wrapper) | [📚 Documentation](./packages/wrapper/readme.md)

Drop-in replacements for official SDKs:

```typescript
import { OpenAI } from '@johnhenry/aimatey-wrapper';  // OpenAI SDK-compatible
```

**Included Wrappers:**
- OpenAI SDK
- Anthropic SDK
- Chrome AI API
- IR-native chat client
- Dynamic wrapper (anymethod)

### Tool Calling (MCP)

**Package:** [`@johnhenry/aimatey-mcp`](./packages/mcp) | [📚 Documentation](./packages/mcp/readme.md)

Translates MCP (Model Context Protocol) tools into the `ToolDefinition` shape consumed by
`@johnhenry/aimatey-core`'s `Bridge.runTools()` agentic loop, via an injectable client - no hard
dependency on any MCP SDK. Works with the official `@modelcontextprotocol/sdk`,
[`mcp-query`](https://github.com/johnhenry/mcp-query), or a test fake.

```typescript
import { runMcpTools } from '@johnhenry/aimatey-mcp';

const result = await runMcpTools(bridge.runTools, {
  client: mcpClient, // any object satisfying McpClientLike
  prompt: 'What files changed in the last commit?',
});
```

### Native Backends

| Package | Runtime | Documentation |
|---------|---------|---------------|
| [`@johnhenry/aimatey-native-node-llamacpp`](./packages/native-node-llamacpp) | llama.cpp via Node | [README](./packages/native-node-llamacpp/readme.md) |
| [`@johnhenry/aimatey-native-apple`](./packages/native-apple) | Apple Foundation Models (macOS 26+) | [README](./packages/native-apple/readme.md) |
| [`@johnhenry/aimatey-native-laya`](./packages/native-laya) | Laya typed-decision model, via ONNX Runtime | [README](./packages/native-laya/readme.md) |
| [`@johnhenry/aimatey-native-onnx`](./packages/native-onnx) | Shared `onnxruntime-node` integration layer | [README](./packages/native-onnx/readme.md) |
| [`@johnhenry/aimatey-native-model-runner`](./packages/native-model-runner) | Generic model runner | [README](./packages/native-model-runner/readme.md) |

## CLI Tools

```bash
# Install globally
npm install -g @johnhenry/aimatey-cli

# Start an OpenAI-compatible proxy with any backend
ai-matey proxy --backend ./my-backend.mjs --port 3000

# Emulate Ollama CLI with any backend
ai-matey emulate-ollama --backend ./backend.mjs run llama3.1 "Hello!"

# Convert requests between formats
ai-matey convert-request --from openai --to anthropic --input request.json

# Convert responses between formats
ai-matey convert-response --format openai --input response.json

# Create a backend adapter template
ai-matey create-backend --provider groq --output ./groq-backend.mjs
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         Client                              │
│  (OpenAI format, Anthropic format, Gemini format, etc.)     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Frontend Adapter                         │
│  Translates client format → Internal IR                     │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      Bridge / Router                        │
│  Middleware stack, routing, fallback                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Backend Adapter                          │
│  Translates Internal IR → Provider API                      │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      AI Provider                            │
│  (OpenAI, Anthropic, Gemini, Ollama, etc.)                  │
└─────────────────────────────────────────────────────────────┘
```

## Examples

See the [examples directory](./examples) and [demo directory](./demo) for comprehensive usage:

```bash
# Run the main demo
node demo/demo.mjs

# Run the router demo
npx tsx demo/router-demo.ts
```

## Development

```bash
# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test

# Run linter
npm run lint
```

## Adding a new backend adapter

The five backend adapters added in this repo's own recent history (Inception
Labs/Mercury, Moonshot AI/Kimi, SambaNova, GitHub Models, and Alibaba Cloud
Model Studio/DashScope — see `CHANGELOG.md`) are the real worked examples
this section walks through; every existing adapter in
[`packages/backend/src/providers`](./packages/backend/src/providers)
follows one of the same two shapes.

**Smallest: the provider is OpenAI-compatible.** `GroqBackendAdapter`
(`packages/backend/src/providers/groq.ts`) is the template — it `extends
OpenAIBackendAdapter` and overrides only the base URL and, where needed, a
default-model mapping in the constructor. DashScope (Alibaba Cloud Model
Studio) shipped the same way: OpenAI-compatible mode means a thin subclass,
not a new request/response translation layer. The test for which case
you're in: does the provider's HTTP API already speak the OpenAI chat-
completions shape? If yes, subclassing `OpenAIBackendAdapter` is the whole
adapter.

**A genuinely new shape: `AWSBedrockBackendAdapter`**
(`packages/backend/src/providers/aws-bedrock.ts`). Bedrock's request
signing (SigV4) and response envelope have nothing in common with the
OpenAI shape, so this one implements `BackendAdapter` directly rather than
subclassing anything. Every backend adapter, whichever shape it follows,
touches the same four places:

1. **`packages/backend/src/providers/<provider>.ts`** — the adapter class
   itself: a `<Provider>BackendAdapter` implementing (or, for an
   OpenAI-compatible provider, inheriting) `BackendAdapter<Request,
   Response>` from `@johnhenry/aimatey-types`, taking an
   `ApiKeyBackendAdapterConfig` (or the provider-specific config shape, e.g.
   Bedrock's AWS credentials) in its constructor.
2. **`packages/backend/src/index.ts`** — one `export * from
   './providers/<provider>.js';` line, alongside every other adapter.
3. **`packages/backend/readme.md`** — add the provider to the categorized
   list (Commercial APIs / Cloud Providers / Fast Inference / Aggregators /
   Specialized / Local), and to this root readme's own "Included Providers"
   list if it changes the count.
4. **The one part that isn't boilerplate: response and streaming
   translation.** Converting the provider's actual response shape (and, for
   `executeStream()`, its chunk format) into aimatey's Universal IR is the
   real work — token usage extraction, tool-call translation, and finish-
   reason mapping are where providers disagree the most. `estimateTokens()`
   in `packages/backend/src/shared.ts` is the shared fallback when a
   provider doesn't return usage data itself; reuse it rather than writing
   a new estimator per adapter.

**Tests.** Each adapter has its own test file exercising request
construction, response parsing, and error mapping against fixtures rather
than live provider calls (live credentials aren't available in CI). A
browser-safe subset of adapters lives in the separate
`packages/backend-browser` package — if the new provider has a
browser-compatible mode (no server-only signing, no secrets that can't be
scoped to the client), consider whether it belongs there too, following
`packages/backend-browser`'s own existing adapters as the template rather
than this section (server-side adapters and browser-side adapters are
different `BackendAdapter` implementations, not the same class reused).

New **frontend** adapters (accepting a different client request format) and
new **middleware** types follow the same numbered shape, in
`packages/frontend/src/` and `packages/middleware/src/` respectively — one
file per adapter/middleware, one export line, one readme entry, and the
same "find the one part that isn't boilerplate" question (for a frontend
adapter: translating the client's request shape into Universal IR; for
middleware: the `before`/`after` hook logic itself).

## Security model

aimatey's core (`Bridge`, `Router`, `MiddlewareStack`) does not sanitize,
redact, or inspect message content, and does not add HTTP security headers,
by default. Every guarantee below is opt-in, through
`@johnhenry/aimatey-middleware`'s `createSecurityMiddleware()`. Read this
before assuming a `bridge.use(...)`-free pipeline is protected.

**What aimatey guarantees:**

- **API keys and credentials are passed straight through to the configured
  backend adapter's own SDK/HTTP client and nowhere else.** `Bridge` and
  `Router` route IR requests between frontend and backend adapters; neither
  layer logs, persists, or forwards credentials independently of the
  backend adapter you constructed with them.
- **`createSecurityMiddleware()`, once registered, redacts PII from message
  content before the request reaches the backend by default**
  (`redactPII: true`) — matches are replaced with `[REDACTED_<TYPE>]` using
  `DEFAULT_PII_PATTERNS`, tuned for precision on developer text (vendor-
  prefixed API keys rather than any 32+ character alphanumeric run, so
  commit hashes/UUIDs/base64 ids survive). A `content-redacted` `IRWarning`
  is attached to `request.metadata.warnings` whenever redaction fires, so
  it's observable, not silent.
- **`sanitizeContent` (on by default when the security middleware is
  registered) strips null bytes and zero-width characters and normalizes
  CRLF** — zero-width characters are a standard way to smuggle instructions
  past a human reviewer, and this closes that specific channel.
- **The CSP/HSTS/X-Frame-Options response-header policy is computed by a
  pure function, `buildSecurityHeaders()`**, so it can be unit-tested and
  wired into `new CoreHTTPHandler({ headers: buildSecurityHeaders() })`
  without the middleware needing to reach into your HTTP layer itself.

**What is still yours:**

- **None of the above runs unless you call `bridge.use(createSecurityMiddleware(...))`.**
  A `Bridge` with no middleware registered forwards message content to the
  backend adapter completely unmodified.
- **Prompt-injection detection is a regex heuristic, not a guarantee.**
  `DEFAULT_INJECTION_PATTERNS` catches some phrase patterns (e.g.
  "disregard all") but not arbitrary rephrasings, and its default action is
  `promptInjectionAction: 'warn'` (log and let the request through), not
  `'block'` — a heuristic that throws by default is a bad default for a
  middleware you register once and forget. Use `'block'`, or tune
  `injectionPatterns` for your own traffic, once you've measured false
  positives against real traffic.
- **PII detection is pattern-based and has known, documented edge cases** —
  e.g. an unmarked four-segment version string (`1.2.3.4`) reads as an IP
  address; there is no ML-based or context-aware detection here. Supply
  your own `piiPatterns` where the defaults' false positives or false
  negatives matter for your traffic, and watch for the `content-redacted`
  warning to see when redaction actually fired.
- **The response-header policy is advisory until you wire it in.** Computing
  `buildSecurityHeaders()` does not, by itself, cause any header to be sent
  — CSP/HSTS/X-Frame-Options are meaningless as request headers to a
  provider API, so this middleware never sends them anywhere; only your own
  HTTP handler applying the computed policy makes it real.

## Family

aimatey is the middleware host that a sibling package plugs into for
sandboxed, code-based tool execution.

- **[`@johnhenry/aimatey-middleware-andbox`](https://github.com/johnhenry/aimatey-middleware-andbox)** —
  a separate repo, not a workspace in this monorepo. It depends on this
  package's middleware interface shape (an object with a `before`/`after`
  hook, registered via `bridge.use(...)`) and on
  [`@johnhenry/andbox`](https://github.com/johnhenry/andbox) for the actual
  sandboxed execution — see that package's own readme for how the two
  combine, and its `## Security model` for what the resulting pipeline
  does and does not guarantee.

## License

MIT
