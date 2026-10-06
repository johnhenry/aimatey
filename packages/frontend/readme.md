# @johnhenry/aimatey-frontend

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-frontend.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-frontend)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-frontend.svg)](LICENSE)

> **Note:** Previously published as `aimatey-frontend@0.4.1`.

Frontend adapters for Aimatey - Universal AI Adapter System.

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-frontend
```

## Overview

Frontend adapters convert provider-specific request formats to the Universal IR (Intermediate Representation) format used internally by Aimatey. This allows your application to accept requests in any provider's format and route them to any backend.

## Included Adapters

- **OpenAI** - OpenAI Chat Completions API format
- **Anthropic** - Anthropic Messages API format
- **Gemini** - Google Gemini API format
- **Mistral** - Mistral API format
- **Ollama** - Ollama API format
- **Chrome AI** - Chrome AI format
- **Generic** - Passthrough adapter for IR format
- **TypeSafe (Jev)** - `@typesafe-ai/sdk`-shaped typed-decision calls, translated to the Decision IR (not chat -- see `packages/backend`'s "Typed-Decision Models" section)
- **Laya** - `Router.predict()`/`Agent.system_one()`-shaped typed-decision calls, translated to the Decision IR. Pairs with `LayaBackendAdapter` in [`@johnhenry/aimatey-native-laya`](../native-laya), which runs Laya's real ONNX model in-process via `@receptron/laya` -- no hosted API, no Python service
- **Vercel AI SDK `decide()`** - `decide({ model, state, questions, providerOptions })`-shaped calls (`boolean`/`choice`/`score` questions) and `{ answers, usage, response, providerMetadata }` results, translated to the Decision IR (`VercelDecideFrontendAdapter`)
- **OpenRouter Decisions** - `/api/alpha/decisions` bodies (`provider`/`trace`/`session_id`/`user` extras travel in `parameters.custom`) and the `id`/`provider`/`usage.cost` response envelope (`OpenRouterDecisionsFrontendAdapter`)

The TypeSafe adapter doubles as the shape of Ollama's `/v1/systemone` endpoint
(the same `{ state, questions }` / `{ answers, model }` bodies), so use it to
front an Ollama decision model too.

The decision adapters (TypeSafe, Laya, Vercel, OpenRouter) implement `FrontendAdapter` through its
`decisionToIR`/`decisionFromIR` hooks rather than the chat ones (`toIR`/
`fromIR`/`fromIRStream` are optional on `FrontendAdapter`). Drive them with
`Bridge.decideFrom(request)`: it converts the request, runs the decision
middleware and backend, and converts the answer back to the frontend's own
shape. `Bridge.chat()` on one of them throws `UNSUPPORTED_FEATURE`.
`probabilities`/`confidence` are optional on choice and score answers, and
are omitted from the converted response when the backend did not report them.

## Usage

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { VercelDecideFrontendAdapter } from '@johnhenry/aimatey-frontend';

// AI SDK decide()-shaped request in, decide()-shaped result out
const bridge = new Bridge(new VercelDecideFrontendAdapter(), decisionBackend);
const { answers } = await bridge.decideFrom({
  model: 'tev1:0.8b',
  state: 'I was billed twice, please refund me.',
  questions: { refund: { type: 'boolean', instructions: 'Wants a refund?' } },
});
// answers.refund -> { type: 'boolean', probability: 0.99 }
```


```typescript
import { OpenAIFrontendAdapter, AnthropicFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { Bridge } from '@johnhenry/aimatey-core';

// Accept OpenAI-formatted requests
const openAIFrontend = new OpenAIFrontendAdapter();

// Accept Anthropic-formatted requests
const anthropicFrontend = new AnthropicFrontendAdapter();

// Create a bridge that accepts OpenAI format
const bridge = new Bridge(openAIFrontend, yourBackend);
```

## Generic Adapter

The Generic adapter passes IR format directly without conversion:

```typescript
import { GenericFrontendAdapter, createGenericFrontend } from '@johnhenry/aimatey-frontend';

const frontend = createGenericFrontend();
```

## API Reference

See the TypeScript definitions for detailed API documentation.

## License

MIT - see [LICENSE](./LICENSE) for details.
