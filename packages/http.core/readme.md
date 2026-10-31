# @johnhenry/aimatey-http-core

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-http-core.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-http-core)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-http-core.svg)](LICENSE)

> **Note:** Previously published as `aimatey-http.core@0.3.1`.

Core HTTP utilities shared across integrations

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-http-core
```

## Quick Start

```typescript
import { CoreHTTPHandler } from '@johnhenry/aimatey-http-core';
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY })
);

const handler = new CoreHTTPHandler({
  bridge,
  timeout: 30000,
  cors: true,
});

// Framework-agnostic: adapt your server's request/response to the generic shape,
// or use one of the @johnhenry/aimatey-http adapters, which wrap this class.
await handler.handle(genericRequest, genericResponse);
```

## API Reference

### CoreHTTPHandler

Framework-agnostic HTTP handler. The adapters in `@johnhenry/aimatey-http`
(Express, Fastify, Hono, Koa, Node, Deno) are thin wrappers around it.

```typescript
new CoreHTTPHandler(options: CoreHandlerOptions)
handler.handle(req: GenericRequest, res: GenericResponse): Promise<void>
handler.dispose(): void
```

#### CoreHandlerOptions

| Option | Type | Description |
|--------|------|-------------|
| `bridge` | `Bridge` | Required. The bridge that executes requests. |
| `cors` | `CORSOptions \| boolean` | CORS configuration. |
| `validateAuth` | `GenericAuthValidator` | Authentication callback. |
| `onError` | `GenericErrorHandler` | Custom error handling. |
| `headers` | `Record<string, string>` | Extra response headers. |
| `timeout` | `number` | Request timeout in milliseconds. |
| `pathPrefix` | `string` | Prefix applied to all routes. |
| `rateLimit` | `GenericRateLimitOptions` | Rate limiting configuration. |
| `routes` | `RouteConfig[]` | Custom route table. |
| `health` | `{ enabled: boolean; path?: string }` | Health-check endpoint. |
| `metrics` | see `src/types.ts` | Metrics endpoint. |
| `embeddings` | see `src/types.ts` | Embeddings endpoint. |

### Stream framing

Streamed answers are framed the way each API's clients expect, picked from
the request path by `detectStreamFraming(url, query)`:

| Path | Framing | Content-Type | End |
|------|---------|--------------|-----|
| `/chat/completions` (and anything unrecognised) | SSE `data:` lines | `text/event-stream` | `data: [DONE]` |
| `/messages` | named SSE events (`event: message_start` ...) | `text/event-stream` | `message_stop` event |
| `…:streamGenerateContent?alt=sse` | SSE `data:` lines | `text/event-stream` | nothing |
| `…:streamGenerateContent` without `alt=sse` | one JSON array | `application/json` | `]` |
| `/api/chat`, `/api/generate` | NDJSON, one object per line | `application/x-ndjson` | nothing |

Whether a request streams also follows its API (`requestWantsStream(url, body)`):
`stream: true` in the body for OpenAI and Anthropic, the URL for Gemini
(`:streamGenerateContent`), and anything but `stream: false` for Ollama, whose
default is to stream. For Gemini URLs the handler copies the model named in
the URL (`geminiModelFromURL(url)`) into the body when the body has none.

A custom `GenericResponse` receives the framing as `stream(generator, { framing })`
and can build the wire text with `createStreamFramer(framing)` (`contentType`,
`frame(chunk)`, `end()`).

### Utilities

Request parsing (`parseRequest`, `extractBearerToken`, `getClientIP`), response
formatting (`sendJSON`, `sendError`, `sendSSEChunk`, `sendText`), CORS
(`handleCORS`, `handlePreflight`, `isPreflight`, `normalizeCORSOptions`),
authentication validators, and `RateLimiter` are all exported from this package.
See `src/index.ts` for the full list.

## License

MIT - see [LICENSE](./LICENSE) for details.
