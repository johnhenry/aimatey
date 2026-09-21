# @johnhenry/aimatey-backend

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-backend.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-backend)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-backend.svg)](LICENSE)

> **Note:** Previously published as `aimatey-backend@0.9.0`.

Server-side backend provider adapters for Aimatey - Universal AI Adapter System.

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-backend
```

## Included Providers

This package includes adapters for **30 AI providers**:

### Commercial APIs
- **OpenAI** - GPT-5.6 family
- **Anthropic** - Claude Sonnet 5, Claude Opus 4.7+
- **Google Gemini** - Gemini 3.6 Flash and other current-generation Gemini models
- **Mistral AI** - Mistral Large, Medium, Small
- **Cohere** - Command, Command-Light, Command-R
- **xAI** - Grok models
- **AI21 Labs** - Jurassic models
- **Moonshot AI** - Kimi models with long-context support (up to 128K)
- **Inception Labs** - Mercury diffusion language models
- **Alibaba Cloud Model Studio (DashScope)** - Qwen model family, OpenAI-compatible mode

### Cloud Providers
- **AWS Bedrock** - Amazon's managed AI service
- **Azure OpenAI** - Microsoft's OpenAI deployment
- **Cloudflare Workers AI** - Edge AI deployment

### Fast Inference
- **Groq** - Ultra-fast LLaMA, Mixtral inference
- **Fireworks AI** - Fast inference platform
- **Together AI** - Open model hosting
- **Anyscale** - Fast endpoints
- **DeepInfra** - High-performance inference
- **Cerebras** - AI supercomputer inference
- **SambaNova** - High-throughput RDU-accelerated inference

### Aggregators
- **OpenRouter** - Multi-provider routing and fallback
- **Perplexity** - Search-augmented models
- **GitHub Models** - Free access to OpenAI, Meta, DeepSeek, Mistral & Microsoft models via any GitHub account

### Specialized
- **Replicate** - ML model deployment
- **NVIDIA NIM** - NVIDIA inference microservices
- **Hugging Face** - Open model inference
- **DeepSeek** - Research models

### Local/Development
- **Ollama** - Local model hosting
- **LM Studio** - Local desktop inference
- **OmniRoute** - Self-hosted gateway fronting 290+ providers (90+ free), no API key required by default

For browser-compatible adapters (Chrome AI, Function, Mock), see [`@johnhenry/aimatey-backend-browser`](../backend-browser).

## Usage

```typescript
import { OpenAIBackendAdapter, AnthropicBackendAdapter } from '@johnhenry/aimatey-backend';

// Create an OpenAI backend
const openaiBackend = new OpenAIBackendAdapter({
  apiKey: process.env.OPENAI_API_KEY,
});

// Create an Anthropic backend
const anthropicBackend = new AnthropicBackendAdapter({
  apiKey: process.env.ANTHROPIC_API_KEY,
});
```

## Subpath Imports

You can also import specific providers directly:

```typescript
import { OpenAIBackendAdapter } from '@johnhenry/aimatey-backend/openai';
import { AnthropicBackendAdapter } from '@johnhenry/aimatey-backend/anthropic';
```

## Structured Output

Set `responseFormat` on an `IRChatRequest` to get schema-constrained JSON output. OpenAI,
Anthropic, and Gemini map it to their native structured-output mechanisms
(`response_format`/`output_config`/`responseSchema`); every other backend falls back to prompt
injection + best-effort JSON extraction. See
[`docs/IR-FORMAT.md`](../../docs/IR-FORMAT.md#structured-output) for the full support matrix and
a request/response example.

## Anthropic Sampling Parameters

Claude Opus 4.7+ and Sonnet 5 return an HTTP 400 if `temperature`/`top_p`/`top_k` are set to
non-default values. `AnthropicBackendAdapter` detects these model families and omits the
params automatically - no config needed, but don't rely on sampling-param overrides taking
effect against these specific models.

## API Reference

See the TypeScript definitions for detailed API documentation.

## License

MIT - see [LICENSE](./LICENSE) for details.
