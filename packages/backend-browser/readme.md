# @johnhenry/aimatey-backend-browser

[![npm version](https://img.shields.io/npm/v/%40johnhenry%2Faimatey-backend-browser.svg)](https://www.npmjs.com/package/@johnhenry/aimatey-backend-browser)
[![license](https://img.shields.io/npm/l/%40johnhenry%2Faimatey-backend-browser.svg)](LICENSE)

> **Note:** Previously published as `aimatey-backend.browser@0.5.1`.

Browser-compatible backend adapters for Aimatey - Universal AI Adapter System.

Part of the [aimatey](https://github.com/johnhenry/aimatey) monorepo.

## Installation

```bash
npm install @johnhenry/aimatey-backend-browser
```

## Overview

This package contains backend adapters that can run natively in browser environments without Node.js dependencies:

- **Chrome AI** - Chrome's built-in on-device model via the Prompt API (`LanguageModel`)
- **Function** - Custom function-based backends for testing and integration
- **Mock** - Mock responses for testing and development

For server-side provider adapters (OpenAI, Anthropic, etc.), see [`@johnhenry/aimatey-backend`](https://www.npmjs.com/package/@johnhenry/aimatey-backend).

## Usage

### Chrome AI Adapter

Runs entirely on-device via Chrome's built-in model — no API key, no network calls, no cost.
Requires Chrome 138+ (the `LanguageModel` global; `chrome://flags/#prompt-api-for-gemini-nano`
may be needed on some channels).

```typescript
import { ChromeAIBackendAdapter } from '@johnhenry/aimatey-backend-browser';

const chromeAI = new ChromeAIBackendAdapter({ temperature: 0.7, topK: 40 });

// Tri-state availability - gate UI on 'downloadable' to show a download prompt
const availability = await chromeAI.checkAvailability(); // 'unavailable' | 'downloadable' | 'downloading' | 'available'

const response = await chromeAI.execute({
  messages: [{ role: 'user', content: 'Hello!' }],
  metadata: { requestId: 'req_1', timestamp: Date.now(), provenance: {} },
});
```

Structured output maps directly onto the Prompt API's `responseConstraint`:

```typescript
const response = await chromeAI.execute({
  messages: [{ role: 'user', content: 'Extract the name and age from: John is 30.' }],
  responseFormat: {
    type: 'json_schema',
    schema: {
      type: 'object',
      properties: { name: { type: 'string' }, age: { type: 'number' } },
      required: ['name', 'age'],
    },
  },
  metadata: { requestId: 'req_2', timestamp: Date.now(), provenance: {} },
});
// response.metadata.custom.responseFormatEnforced === true
```

Notes:
- Text-only for now (no image/audio input) - `tools` is not supported (surfaced as an IR warning
  if requested).
- `session.inputUsage`/`inputQuota` (cumulative context-window tokens) are surfaced under
  `response.metadata.custom`, not `response.usage` - the Prompt API doesn't report a
  prompt/completion token split.
- Pass `onDownloadProgress` in the config to receive download progress events while
  availability is `'downloadable'`/`'downloading'`.

### Function Backend

```typescript
import { FunctionBackendAdapter, createFunctionBackend } from '@johnhenry/aimatey-backend-browser';

// Create a custom backend from a function
const customBackend = createFunctionBackend(async (request) => ({
  message: { role: 'assistant', content: 'Hello from custom backend!' },
  finishReason: 'stop',
  metadata: { requestId: request.metadata.requestId, provenance: {} },
}));
```

### Mock Backend

```typescript
import { MockBackendAdapter, createEchoBackend } from '@johnhenry/aimatey-backend-browser';

// Create a mock backend for testing
const mockBackend = new MockBackendAdapter({
  defaultResponse: 'This is a test response',
});

// Or use the echo helper
const echoBackend = createEchoBackend();
```

## Subpath Imports

```typescript
import { ChromeAIBackendAdapter } from '@johnhenry/aimatey-backend-browser/chrome-ai';
import { FunctionBackendAdapter } from '@johnhenry/aimatey-backend-browser/function';
import { MockBackendAdapter } from '@johnhenry/aimatey-backend-browser/mock';
```

## API Reference

See the TypeScript definitions for detailed API documentation.

## License

MIT - see [LICENSE](./LICENSE) for details.

## LiteRT-LM (on-device LLM, WebGPU)

Run Google's Gemma models entirely in the browser via [LiteRT-LM](https://developers.google.com/edge/litert-lm/js) — no API key, no server, no cost.

```bash
npm install @johnhenry/aimatey-backend-browser @litert-lm/core
```

```typescript
import { Bridge } from '@johnhenry/aimatey-core';
import { OpenAIFrontendAdapter } from '@johnhenry/aimatey-frontend';
import { LiteRtLmBackendAdapter } from '@johnhenry/aimatey-backend-browser';

const backend = new LiteRtLmBackendAdapter({
  model:
    'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
  maxNumTokens: 8192,
});

const bridge = new Bridge(new OpenAIFrontendAdapter(), backend);

for await (const chunk of bridge.chatStream({
  model: 'gemma-4-E2B-it-litert-lm',
  messages: [{ role: 'user', content: 'Write a haiku about tide pools.' }],
  stream: true,
})) {
  render(chunk.choices?.[0]?.delta?.content ?? '');
}

// Free GPU/WASM memory when done with the model
await backend.dispose();
```

### Requirements & notes

- **WebGPU** (Chrome 113+, Safari 17.4+, Firefox 121+). Browser only — no Node.js.
- **Cross-origin isolation** may be required for threaded WASM: serve your page with
  `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- **Model downloads are large** (hundreds of MB to GBs). Engines are cached per model URL across
  adapter instances, so the download/compile happens once per page.
- **Web SDK limits** (early preview): text-only, no tool calling, no sampler parameters
  (`temperature`/`topK`/`seed` are dropped with an IR warning). Prior conversation turns are
  flattened into a transcript prefix (each request opens a fresh conversation).
- Models: [litert-community on Hugging Face](https://huggingface.co/litert-community) —
  Gemma-4 E2B (faster) and E4B (better), under the Gemma license.
- Naming note: `@litertjs/core` ("LiteRT.js") is Google's tensor-level runtime and cannot run chat
  models — this adapter wraps **LiteRT-LM** (`@litert-lm/core`), the conversation runtime.
