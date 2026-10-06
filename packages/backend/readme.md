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

This package includes adapters for **30 chat providers**, plus 1 typed-decision provider:

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

### Typed-Decision Models

Not chat: given a state and typed questions (`choice`/`score`/`noul`), these
answer with calibrated probabilities in a single forward pass -- see
`decide()` on `BackendAdapter` and `Bridge.decide()`, not `execute()`/
`chat()`. A backend in this category implements only `metadata` and
`decide()`; `fromIR`/`toIR`/`execute`/`executeStream` are all optional
precisely so it isn't forced to fake a chat capability it doesn't have.

- **TypeSafe (Jev)** - "System One" typed decisions, 70-500ms latency, input-token-only pricing
- **Together AI (Tev1)** - `TogetherAIBackendAdapter.decide()` for `together/Tev1-4B-experimental` and `together/Tev1-0.8B-experimental`. Not System One: each question is one chat-completions call and the model answers a single letter A-X, so a request makes one call per question (4 at a time by default; `parameters.custom.concurrency`). Native for `choice` only, with **2 to 24 options** (more throws), no images, $0.042 per 1M input tokens. `noul` and `score` are emulated on the same protocol with neutral option keys and each such answer carries a warning (`decisionsEmulatedTypes: ['noul', 'score']`). `probabilities` come from the first token's `top_logprobs` (softmax over the valid letters; letters outside the top 24 get 0) and `confidence` is `1 - H(p) / ln(n)`; if Together returns no logprobs the answer has neither, plus a warning.

Decision backends describe themselves through `capabilities`:
`decisionModels`, `decisionTypes` (which of `choice`/`score`/`noul` they
answer), `decisionImages`, and `decisionLimits` (`maxQuestions`,
`maxChoiceOptions`, `maxScoreLevels`, `maxStateTokens`, `maxImages`). The
TypeSafe adapter declares all three types, 255 options, 10 score levels,
32,000 state tokens and no images (images on a request are dropped with a
`capability-unsupported` warning). A response carries `usage.inputTokens`,
`usage.outputTokens` and `usage.cost`, plus `id`/`provider` when known, and
the adapter throws if the provider leaves a question unanswered. Use
`validateDecisionResponse()` from `@johnhenry/aimatey-utils` to check any
decision response against its request.

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
