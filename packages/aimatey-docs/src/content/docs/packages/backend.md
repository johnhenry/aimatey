---
title: "@johnhenry/aimatey-backend"
description: "Guide to the backend adapters in @johnhenry/aimatey-backend: execute requests against cloud and local AI providers."
---

Backend adapters connect to AI provider APIs. Switch providers without changing your application code - just swap the backend adapter.

## Installation

```bash
npm install @johnhenry/aimatey-backend
```

## Overview

Backend adapters translate aimatey's Intermediate Representation (IR) into provider-specific API calls. This allows you to switch AI providers without changing your application code.

**Supported Providers (24+):**
- OpenAI (GPT-6 Astra, GPT-5.6 family)
- Anthropic (Claude Fable 5.1, Opus 5, Haiku 4.5)
- Google (Gemini 1.5 Pro, Flash)
- Groq (Llama 3, Mixtral)
- DeepSeek (V3, Chat)
- Ollama (Local models)
- Cohere, Mistral, Perplexity, Together AI, and more!

## Quick Start

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';

const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new AnthropicBackendAdapter({
    apiKey: process.env.ANTHROPIC_API_KEY
  })
);

// Write in OpenAI format, execute with Claude
const response = await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

## OpenAI Backend

Use OpenAI's GPT models.

### Installation

```typescript
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';
```

### Configuration

```typescript
const backend = new OpenAIBackendAdapter({
  apiKey: process.env.OPENAI_API_KEY,   // Required
  baseURL: 'https://api.openai.com/v1', // Optional
  timeout: 60000,                       // Optional (default: 30000)
  defaultModel: 'gpt-6-astra',          // Optional
  headers: { 'OpenAI-Organization': 'org-xxx' }, // Optional; there is no `organization` field
});
```

All backend adapters take the same [`BackendAdapterConfig`](https://github.com/johnhenry/aimatey/blob/main/packages/aimatey-types/src/adapters.ts):
`apiKey` (required), `baseURL`, `timeout`, `maxRetries`, `debug`, `headers`,
`custom`, `browserMode`, `defaultModel`, `models`. Provider-specific options that
are not in that list go in `custom` or `headers`.

### Available Models

`DEFAULT_OPENAI_MODELS` ships this catalog (`@johnhenry/aimatey-backend`'s `shared.ts`, refreshed 2026-09-11):

- **GPT-6 Astra**: `gpt-6-astra` (flagship, supersedes the GPT-5.6 family)
- **GPT-5.6 Sol**: `gpt-5.6-sol`
- **GPT-5.6 Terra**: `gpt-5.6-terra`
- **GPT-5.6 Luna**: `gpt-5.6-luna` (fast, low-cost tier)

### Features

- ✅ Chat completions
- ✅ Streaming
- ✅ Function calling
- ✅ Vision
- ✅ JSON mode
- ✅ Seed for reproducibility

Pricing changes often enough that a static table here goes stale fast (this
page's previous one did) — check [OpenAI's own pricing page](https://openai.com/api/pricing/)
for current per-model rates, or call `backend.estimateCost(request)`, which
prices against the same model registry the adapter itself uses.

## Anthropic Backend

Use Anthropic's Claude models.

### Installation

```typescript
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';
```

### Configuration

```typescript
const backend = new AnthropicBackendAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY, // Required
  baseURL: 'https://api.anthropic.com', // Optional
  timeout: 60000 // Optional
});
```

### Available Models

`DEFAULT_ANTHROPIC_MODELS` ships this catalog (`@johnhenry/aimatey-backend`'s `shared.ts`, refreshed 2026-09-11); `claude-haiku-4-5-20251001` is the adapter's own fallback default when no model is specified:

- **Claude Fable 5.1**: `claude-fable-5-1` (Anthropic's most capable widely-released model)
- **Claude Fable 5**: `claude-fable-5` (predecessor to Fable 5.1, still served)
- **Claude Opus 5**: `claude-opus-5` (general-purpose flagship-tier default)
- **Claude Opus 4.8**: `claude-opus-4-8` (most capable Opus 4.x tier)
- **Claude Sonnet 5**: `claude-sonnet-5` (default Anthropic model, 1M-token context window)
- **Claude Haiku 4.5**: `claude-haiku-4-5-20251001` (fastest and most affordable current-generation model)

### Features

- ✅ Chat completions
- ✅ Streaming
- ✅ Tool use
- ✅ Vision
- ✅ 200K context window
- ✅ System prompts

Check [Anthropic's own pricing page](https://www.anthropic.com/pricing) for
current per-model rates, or call `backend.estimateCost(request)`.

## Google Gemini Backend

Use Google's Gemini models.

### Installation

```typescript
import { GeminiBackendAdapter } from '@johnhenry/aimatey-backend/gemini';
```

### Configuration

```typescript
const backend = new GeminiBackendAdapter({
  apiKey: process.env.GEMINI_API_KEY, // Required
  baseURL: 'https://generativelanguage.googleapis.com', // Optional
});
```

### Available Models

- **Gemini 1.5 Pro**: `gemini-1.5-pro-latest` (Most capable)
- **Gemini 1.5 Flash**: `gemini-1.5-flash-latest` (Fast, efficient)
- **Gemini 1.0 Pro**: `gemini-1.0-pro` (Previous generation)

### Features

- ✅ Chat completions
- ✅ Streaming
- ✅ Function calling
- ✅ Native multi-modal (vision, audio)
- ✅ 2M token context (Pro)
- ✅ Grounding with Google Search

### Pricing (per 1M tokens)

| Model | Input | Output |
|-------|-------|--------|
| Gemini 1.5 Pro | $3.50 | $10.50 |
| Gemini 1.5 Flash | $0.35 | $1.05 |

## Groq Backend

Use Groq's ultra-fast inference.

### Installation

```typescript
import { GroqBackendAdapter } from '@johnhenry/aimatey-backend/groq';
```

### Configuration

```typescript
const backend = new GroqBackendAdapter({
  apiKey: process.env.GROQ_API_KEY // Required
});
```

### Available Models

- **Llama 3**: `llama3-70b-8192`, `llama3-8b-8192`
- **Mixtral**: `mixtral-8x7b-32768`
- **Gemma**: `gemma-7b-it`

### Features

- ✅ Chat completions
- ✅ Streaming
- ✅ **Ultra-fast** (500+ tokens/sec)
- ⚠️ Limited tool support

### Pricing

**Free tier available!** Very cost-effective for high-throughput use cases.

## DeepSeek Backend

Use DeepSeek's cost-effective models.

### Installation

```typescript
import { DeepSeekBackendAdapter } from '@johnhenry/aimatey-backend/deepseek';
```

### Configuration

```typescript
const backend = new DeepSeekBackendAdapter({
  apiKey: process.env.DEEPSEEK_API_KEY // Required
});
```

### Available Models

- **DeepSeek V3**: `deepseek-chat` (Latest)
- **DeepSeek Coder**: `deepseek-coder` (Code specialist)

### Features

- ✅ Chat completions
- ✅ Streaming
- ✅ Competitive quality
- ✅ **Very low cost**

### Pricing (per 1M tokens)

| Model | Input | Output |
|-------|-------|--------|
| DeepSeek Chat | $0.14 | $0.28 |
| DeepSeek Coder | $0.14 | $0.28 |

**Up to 95% cheaper than GPT-4!**

## Ollama Backend

Use local open-source models.

### Installation

```typescript
import { OllamaBackendAdapter } from '@johnhenry/aimatey-backend/ollama';
```

### Configuration

```typescript
const backend = new OllamaBackendAdapter({
  baseURL: 'http://localhost:11434', // Optional (default)
  timeout: 120000 // Optional (2 min for local inference)
});
```

### Available Models

Any model supported by Ollama:
- **Llama 3.2**: `llama3.2`, `llama3.2:70b`
- **Mistral**: `mistral`, `mistral-nemo`
- **Qwen**: `qwen2.5:72b`
- **Gemma**: `gemma2`
- **Phi**: `phi3`

### Features

- ✅ Chat completions
- ✅ Streaming
- ✅ **100% local** (no API costs)
- ✅ Privacy (data never leaves your machine)
- ⚠️ Slower than cloud providers
- ⚠️ Limited tool support (model-dependent)

### Setup

1. Install Ollama: https://ollama.ai
2. Pull a model: `ollama pull llama3.2`
3. Use with aimatey:

```typescript
const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new OllamaBackendAdapter()
);

const response = await bridge.chat({
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

## More Providers

### Cohere

```typescript
import { CohereBackendAdapter } from '@johnhenry/aimatey-backend/cohere';

const backend = new CohereBackendAdapter({
  apiKey: process.env.COHERE_API_KEY
});
```

**Models:** `command-r-plus`, `command-r`, `command`

### Mistral

```typescript
import { MistralBackendAdapter } from '@johnhenry/aimatey-backend/mistral';

const backend = new MistralBackendAdapter({
  apiKey: process.env.MISTRAL_API_KEY
});
```

**Models:** `mistral-large-latest`, `mistral-medium-latest`, `mistral-small-latest`

### Perplexity

```typescript
import { PerplexityBackendAdapter } from '@johnhenry/aimatey-backend/perplexity';

const backend = new PerplexityBackendAdapter({
  apiKey: process.env.PERPLEXITY_API_KEY
});
```

**Models:** `llama-3.1-sonar-large`, `llama-3.1-sonar-small`

### Together AI

```typescript
import { TogetherAIBackendAdapter } from '@johnhenry/aimatey-backend/together-ai';

const backend = new TogetherAIBackendAdapter({
  apiKey: process.env.TOGETHER_API_KEY
});
```

**Models:** Wide selection of open-source models

## Provider Comparison

### By Use Case

#### Best for Production
1. **OpenAI** - Most reliable, widely tested
2. **Anthropic** - Excellent quality, large context
3. **Google Gemini** - Strong multi-modal capabilities

#### Best for Cost Optimization
1. **DeepSeek** - Cheapest cloud option
2. **Ollama** - Free (local)
3. **Groq** - Generous free tier

#### Best for Speed
1. **Groq** - 500+ tokens/sec
2. **Gemini Flash** - Very fast
3. **Claude Haiku** - Fast cloud model

#### Best for Privacy
1. **Ollama** - 100% local
2. **LM Studio** - Local with GUI
3. Self-hosted options

### Feature Matrix

| Provider | Streaming | Tools | Vision | Context | Speed |
|----------|-----------|-------|--------|---------|-------|
| OpenAI | ✅ | ✅ | ✅ | 128K | Fast |
| Anthropic | ✅ | ✅ | ✅ | 200K | Fast |
| Gemini | ✅ | ✅ | ✅ | 2M | Fast |
| Groq | ✅ | ⚠️ | ❌ | 32K | **Very Fast** |
| DeepSeek | ✅ | ✅ | ❌ | 64K | Medium |
| Ollama | ✅ | ⚠️ | ⚠️ | Varies | Slow |

## Switching Providers

### Simple Switch

Change providers by only changing the backend:

```typescript
// Before: OpenAI
const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new OpenAIBackendAdapter({ apiKey: openaiKey })
);

// After: Anthropic (only change backend!)
const bridge = new Bridge(
  new OpenAIFrontendAdapter(), // Same frontend
  new AnthropicBackendAdapter({ apiKey: anthropicKey })
);
```

### Environment-Based

Use different providers for dev/prod:

```typescript
const backend = process.env.NODE_ENV === 'production'
  ? new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY })
  : new OllamaBackendAdapter({ baseURL: 'http://localhost:11434' });

const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);
```

### Multi-Provider Fallback

Use Router for automatic failover:

```typescript
import { Bridge, Router } from '@johnhenry/aimatey-core';

// A Router is a BackendAdapter, so it goes *inside* a Bridge.
const router = new Router({
  routingStrategy: 'explicit',
  defaultBackend: 'anthropic',
  fallbackStrategy: 'sequential',
});

router
  .register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY }))
  .register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY }))
  .register('groq', new GroqBackendAdapter({ apiKey: process.env.GROQ_API_KEY }));

router.setFallbackChain(['openai', 'groq']);

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);

// Automatically tries Anthropic, then OpenAI, then Groq
const response = await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Hello!' }]
});
```

## Cost Optimization

### Route by Complexity

```typescript
const router = new Router({
  routingStrategy: 'custom',
  // customRouter is async and returns a backend NAME (or null to fall through)
  customRouter: async (request, availableBackends) => {
    const messageLength = JSON.stringify(request.messages).length;

    const preferred =
      messageLength < 100 ? 'deepseek'   // simple queries
      : messageLength < 500 ? 'groq'     // moderate queries
      : messageLength < 2000 ? 'openai'  // complex queries
      : 'anthropic';                     // very complex queries

    return availableBackends.includes(preferred) ? preferred : (availableBackends[0] ?? null);
  },
});

router
  .register('deepseek', new DeepSeekBackendAdapter({ apiKey: process.env.DEEPSEEK_API_KEY })) // Cheap
  .register('groq', new GroqBackendAdapter({ apiKey: process.env.GROQ_API_KEY }))             // Fast
  .register('openai', new OpenAIBackendAdapter({ apiKey: process.env.OPENAI_API_KEY }))       // Powerful
  .register('anthropic', new AnthropicBackendAdapter({ apiKey: process.env.ANTHROPIC_API_KEY })); // Most capable

const bridge = new Bridge(new OpenAIFrontendAdapter(), router);
```

**Potential savings:** Up to 90% compared to always using GPT-4.

## Provider-Specific Features

### OpenAI: JSON Mode

```typescript
const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new OpenAIBackendAdapter({ apiKey })
);

const response = await bridge.chat({
  model: 'gpt-4',
  messages: [{ role: 'user', content: 'Return a user object' }],
  response_format: { type: 'json_object' }
});
```

### Anthropic: Extended Context

```typescript
const bridge = new Bridge(
  new OpenAIFrontendAdapter(),
  new AnthropicBackendAdapter({ apiKey })
);

// Claude supports up to 200K tokens!
const longDocument = fs.readFileSync('long-doc.txt', 'utf-8');

const response = await bridge.chat({
  model: 'claude-haiku-4-5-20251001',
  messages: [
    { role: 'user', content: `Summarize this:\n\n${longDocument}` }
  ]
});
```

### Gemini: Grounding

```typescript
const bridge = new Bridge(
  new GeminiFrontendAdapter(),
  new GeminiBackendAdapter({ apiKey })
);

const response = await bridge.chat({
  model: 'gemini-1.5-pro',
  contents: [{ role: 'user', parts: [{ text: 'Latest AI news?' }] }],
  tools: [{ google_search_retrieval: {} }] // Enable grounding
});
```

## Best Practices

### 1. Use Environment Variables

```typescript
const backend = new AnthropicBackendAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY // Don't hardcode!
});
```

### 2. Set Timeouts

```typescript
const backend = new OpenAIBackendAdapter({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 30000 // 30 seconds
});
```

### 3. Handle Errors

```typescript
import { AdapterError, ErrorCode } from '@johnhenry/aimatey-errors';

try {
  const response = await bridge.chat(request);
} catch (error) {
  if (!(error instanceof AdapterError)) throw error;

  if (error.code === ErrorCode.RATE_LIMIT_EXCEEDED) {
    console.log('Rate limited, waiting...');
    await sleep(1000);
  } else if (error.code === ErrorCode.INVALID_API_KEY) {
    console.error('Invalid API key');
  } else {
    console.error('Error:', error.code, error.message);
  }
}
```

### 4. Monitor Costs

```typescript
import { createCostTrackingMiddleware } from '@johnhenry/aimatey-middleware';

bridge.use(createCostTrackingMiddleware({
  dailyThreshold: 100,
  onThresholdExceeded: (cost, threshold) => {
    console.error(`Spend passed $${threshold} (last request $${cost.totalCost.toFixed(4)})`);
  }
}));
```

## See Also

- [Frontend Adapters](/packages/frontend) - Available input formats
- [Core Package](/packages/core) - Bridge and Router
- [Middleware](/packages/middleware) - Add logging, caching, etc.
- [Integration Patterns](/patterns) - Production patterns
- [Examples on GitHub](https://github.com/johnhenry/aimatey/tree/main/packages/aimatey-docs/examples/02-providers) - Provider examples
